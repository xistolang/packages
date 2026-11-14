// elastic-apm-node for xisto: the agent's manual API (elastic-apm-node ^4) on the xisto-apm core, exporting to the APM
// Server's intake v2 (POST {serverUrl}/intake/v2/events, ndjson: metadata, transaction, span, error), with
// "Authorization: Bearer <secretToken>" or "ApiKey <apiKey>".
//
// A root span of this service (or a server span, or one whose parent is in another service) is a transaction; the
// others are its spans (transaction_id, parent_id). Spans made by the instrumented packages (xisto-apm hooks) are
// exported the same way; one that failed becomes an error event as well.
//
// Differences from the npm package:
// - No automatic instrumentation by patching modules: the ported packages call xisto-apm's hooks instead (see its
//   header). Options about instrumentation, metrics, central config, cloud metadata, stack traces of spans, logging
//   and the like are accepted and ignored (no metricsets, no central config polling, no cloud metadata).
// - start() accepts the same options and ELASTIC_APM_* variables (SERVICE_NAME, SERVER_URL, SECRET_TOKEN, API_KEY,
//   ENVIRONMENT, SERVICE_VERSION, ACTIVE, GLOBAL_LABELS, TRANSACTION_SAMPLE_RATE, HOSTNAME, LOG_LEVEL); as in the
//   agent, a variable wins over the option. The service name defaults to "unknown-nodejs-service" (no package.json
//   is read).
// - The payload is sent uncompressed (the agent gzips it), in a request per batch (xisto-apm's: every 2 s, at 1000
//   spans, before exit, flush()), not over one long-lived streaming request.
// - metadata: service.agent is {name: "nodejs", version: "4.18.0", activation_method: "import"}, service.runtime is
//   {name: "xisto"}, process.argv and title are the binary's.
// - The error's stacktrace frames come from err.stack (function, file, line, column; no source lines, no
//   library_frame detection beyond node_modules); culprit is "function (file)" of the first frame.
// - span "sync" is true when the span ended before the first microtask after its start (the agent compares async ids).
// - currentTransaction/currentSpan/currentTraceIds are properties of the default export (the agent object); the
//   named function exports (start, isStarted, startTransaction...) are there for `import * as apm` and require().
// - Not implemented: lambda/azure functions wrappers, setFramework, addFilter/addErrorFilter/addSpanFilter/
//   addTransactionFilter (accepted, the filter is never called), registerMetric, span links, compressed spans,
//   breakdown metrics, captureError's request/response context.
import {
  Apm,
  ApmExporter,
  ApmServiceInfo,
  ApmSpan,
  ApmTrace,
  ApmSpanOptions,
  ApmParent,
  activeSpan,
  enterSpan,
  newSpan,
  extractParent,
  hostName,
  newId,
  nsText,
} from "xisto-apm";

/** The options of apm.start() (and their ELASTIC_APM_* variables); the ones marked "accepted" change nothing here. */
export interface AgentConfigOptions {
  serviceName?: string;
  serverUrl?: string;
  secretToken?: string;
  apiKey?: string;
  environment?: string;
  serviceVersion?: string;
  active?: boolean;
  logLevel?: string;
  hostname?: string;
  globalLabels?: Record<string, any>;
  transactionSampleRate?: number;
  /** accepted */
  centralConfig?: boolean;
  metricsInterval?: any;
  cloudProvider?: string;
  captureExceptions?: boolean;
  captureErrorLogStackTraces?: string;
  captureBody?: string;
  captureHeaders?: boolean;
  instrument?: boolean;
  instrumentIncomingHTTPRequests?: boolean;
  disableInstrumentations?: any;
  breakdownMetrics?: boolean;
  apiRequestTime?: any;
  apiRequestSize?: any;
  serverTimeout?: any;
  verifyServerCert?: boolean;
  usePathAsTransactionName?: boolean;
  spanStackTraceMinDuration?: any;
  transactionMaxSpans?: number;
  frameworkName?: string;
  frameworkVersion?: string;
  logger?: any;
  contextPropagationOnly?: boolean;
  disableSend?: boolean;
}

/** The user of the transaction (setUserContext). */
export interface UserObject {
  id?: any;
  username?: string;
  email?: string;
}

/** The options of startTransaction/startSpan (startTime in ms since the epoch, childOf a traceparent or a span). */
export interface TransactionOptions {
  startTime?: number;
  childOf?: any;
  exitSpan?: boolean;
}

function labelKey(k: string): string {
  return k.replace(/[.*"]/g, "_");
}
function labelValue(v: any, stringify: boolean): string {
  if (!stringify && (typeof v === "number" || typeof v === "boolean")) return String(v);
  return JSON.stringify(String(v));
}

/** What Transaction and Span share: the core span, labels, outcome. */
export class GenericSpan {
  core: ApmSpan;
  isTx: boolean;
  subtype: string | null = null;
  action: string | null = null;
  outcome: string = "unknown";
  /** label key → its JSON value */
  labels: Map<string, string> = new Map<string, string>();
  sync: boolean = true;
  outcomeSet: boolean = false;
  constructor(core: ApmSpan, isTx: boolean) {
    this.core = core;
    this.isTx = isTx;
    core.facade = this;
    Promise.resolve().then(() => {
      if (!core.ended) this.sync = false;
    });
  }
  get name(): string {
    return this.core.name;
  }
  set name(n: string) {
    this.core.name = n;
  }
  get type(): string {
    return this.core.type;
  }
  set type(t: string) {
    this.core.type = t;
  }
  get traceparent(): string {
    return `00-${this.core.traceIdHex()}-${this.core.spanIdHex()}-${this.core.trace.priority > 0 ? "01" : "00"}`;
  }
  get ended(): boolean {
    return this.core.ended;
  }
  setLabel(key: string, value: any, stringify: boolean = true): boolean {
    if (value === null) return false;
    this.labels.set(labelKey(key), labelValue(value, stringify));
    return true;
  }
  addLabels(labels: Record<string, any>, stringify: boolean = true): boolean {
    for (const k of Object.keys(labels)) this.setLabel(k, labels[k], stringify);
    return true;
  }
  setType(type: string | null = null, subtype: string | null = null, action: string | null = null): void {
    if (type !== null) this.core.type = type;
    this.subtype = subtype;
    this.action = action;
  }
  setOutcome(outcome: string): void {
    if (outcome !== "success" && outcome !== "failure" && outcome !== "unknown") return;
    this.outcome = outcome;
    this.outcomeSet = true;
  }
  /** Ends it (now, or at endTime in ms since the epoch); it stops being the current one. */
  end(endTime: number | null = null): void {
    if (this.core.ended) return;
    if (!this.isTx && !this.outcomeSet) this.outcome = this.core.error ? "failure" : "success";
    this.core.finish(endTime === null ? -1 : (endTime as number));
    if (activeSpan() === this.core) enterSpan(this.isTx ? null : this.core.parent);
  }
}

/** A span: a timed operation inside a transaction. */
export class Span extends GenericSpan {
  constructor(core: ApmSpan) {
    super(core, false);
  }
  get ids(): Record<string, string> {
    const r: Record<string, string> = {};
    r["trace.id"] = this.core.traceIdHex();
    r["span.id"] = this.core.spanIdHex();
    return r;
  }
  get transaction(): Transaction | null {
    return transactionOf(this.core);
  }
  setServiceTarget(type: string | null, name: string | null): void {}
  setDestinationContext(ctx: any): void {}
  setDbContext(ctx: any): void {}
}

/** A transaction: a request served, a job run; the root of this service's spans. */
export class Transaction extends GenericSpan {
  result: any = "success";
  /** custom context key → its JSON value */
  custom: Map<string, string> = new Map<string, string>();
  user: Map<string, string> = new Map<string, string>();
  started: int = 0;
  constructor(core: ApmSpan) {
    super(core, true);
  }
  get ids(): Record<string, string> {
    const r: Record<string, string> = {};
    r["trace.id"] = this.core.traceIdHex();
    r["transaction.id"] = this.core.spanIdHex();
    return r;
  }
  setCustomContext(ctx: Record<string, any>): void {
    for (const k of Object.keys(ctx)) this.custom.set(k, JSON.stringify(ctx[k]));
  }
  setUserContext(u: Record<string, any>): void {
    for (const k of Object.keys(u)) if (u[k] !== null) this.user.set(k, JSON.stringify(u[k]));
  }
  /** A span of this transaction (a child of the current span when that is in it). */
  startSpan(name: string | null = null, type: string | null = null, subtype: string | null = null, action: string | null = null, opts: TransactionOptions | null = null): Span | null {
    if (this.core.ended) return null;
    const cur = activeSpan();
    const parent: ApmSpan = cur !== null && transactionOf(cur) === this ? cur : this.core;
    return makeSpan(parent, name, type, subtype, action, opts);
  }
  ensureParentId(): string {
    return this.core.parentId;
  }
}

/** The transaction a core span belongs to: itself or its nearest ancestor that is one. */
function transactionOf(s: ApmSpan): Transaction | null {
  let c: ApmSpan | null = s;
  while (c !== null) {
    const cs = c as ApmSpan;
    if (isTransaction(cs)) {
      if (cs.facade === null) return null;
      const f: any = cs.facade;
      const g = f as GenericSpan;
      if (!g.isTx) return null;
      return f as Transaction;
    }
    c = cs.parent;
  }
  return null;
}

/** A transaction in Elastic's model: the service's root span, a server span, or the first one of this service. */
function isTransaction(s: ApmSpan): boolean {
  if (s.facade !== null) {
    const f: any = s.facade;
    return (f as GenericSpan).isTx;
  }
  const p = s.parent;
  return p === null || s.kind === "server" || s.kind === "consumer" || (p as ApmSpan).service !== s.service;
}

function makeSpan(parent: ApmSpan, name: string | null, type: string | null, subtype: string | null, action: string | null, opts: TransactionOptions | null): Span | null {
  const o = new ApmSpanOptions();
  o.childOf = parent;
  o.type = type ?? "custom";
  o.component = "elastic-apm-node";
  const core = newSpan(name ?? "unnamed", o);
  if (core === null) return null;
  if (opts !== null && opts.startTime !== null) core.startNs = Math.trunc((opts.startTime as number) * 1000000);
  const s = new Span(core);
  s.subtype = subtype;
  s.action = action;
  const tx = transactionOf(parent);
  if (tx !== null) tx.started++;
  enterSpan(core);
  return s;
}

// ---- the exporter: intake v2 ----

function frames(stack: string): string[] {
  const out: string[] = [];
  for (const line of stack.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("at ")) continue;
    let fn = "<anonymous>";
    let loc = l.slice(3);
    const p = loc.indexOf(" (");
    if (p >= 0 && loc.endsWith(")")) {
      fn = loc.slice(0, p);
      loc = loc.slice(p + 2, loc.length - 1);
    }
    const parts = loc.split(":");
    let file = loc;
    let lineno = 0;
    let colno = 0;
    if (parts.length >= 3) {
      colno = Number(parts[parts.length - 1]);
      lineno = Number(parts[parts.length - 2]);
      file = parts.slice(0, parts.length - 2).join(":");
    }
    if (file.startsWith("file://")) file = file.slice(7);
    const base = file.lastIndexOf("/") >= 0 ? file.slice(file.lastIndexOf("/") + 1) : file;
    out.push(
      `{"filename":${JSON.stringify(base)},"abs_path":${JSON.stringify(file)},"function":${JSON.stringify(fn)},"lineno":${lineno},"colno":${colno},"library_frame":${file.indexOf("node_modules") >= 0}}`,
    );
  }
  return out;
}
function culprit(stack: string): string {
  for (const line of stack.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("at ")) continue;
    const loc = l.slice(3);
    const p = loc.indexOf(" (");
    const fn = p >= 0 ? loc.slice(0, p) : "<anonymous>";
    let file = p >= 0 ? loc.slice(p + 2, loc.length - 1) : loc;
    const parts = file.split(":");
    if (parts.length >= 3) file = parts.slice(0, parts.length - 2).join(":");
    return `${fn} (${file.lastIndexOf("/") >= 0 ? file.slice(file.lastIndexOf("/") + 1) : file})`;
  }
  return "";
}
function jsonMap(m: Map<string, string>): string {
  const parts: string[] = [];
  for (const k of m.keys()) parts.push(`${JSON.stringify(k)}:${m.get(k) ?? "null"}`);
  return `{${parts.join(",")}}`;
}
function jsonOrNull(s: string | null): string {
  return s === null ? "null" : JSON.stringify(s);
}
function ms(ns: number): number {
  return Math.round(ns / 1000) / 1000;
}
function us(ns: number): number {
  return Math.trunc(ns / 1000);
}

/** err.stack; "" for the built-in TypeError, RangeError... (xisto gives them no stack: reading it is not safe) */
export function readStack(e: Error): string {
  const n = e.name;
  if (n === "TypeError" || n === "RangeError" || n === "SyntaxError" || n === "ReferenceError" || n === "EvalError" || n === "URIError") return "";
  return e.stack ?? "";
}

/** One error event's JSON, made at capture time (the current transaction and span then). */
function errorEvent(err: any, cur: ApmSpan | null, handled: boolean): string {
  if (err instanceof Error) {
    const e = err as Error;
    return errorEventOf(e.name, e.message, readStack(e), true, cur, handled);
  }
  return errorEventOf("Error", String(err), "", false, cur, handled);
}
function errorEventOf(type: string, message: string, stack: string, isError: boolean, cur: ApmSpan | null, handled: boolean): string {
  const f = [`"id":"${newId()}${newId()}"`, `"timestamp":${Date.now() * 1000}`];
  if (cur !== null) {
    const c = cur as ApmSpan;
    f.push(`"trace_id":"${c.traceIdHex()}"`, `"parent_id":"${c.spanIdHex()}"`);
    let t: ApmSpan = c;
    while (!isTransaction(t) && t.parent !== null) t = t.parent as ApmSpan;
    f.push(`"transaction_id":"${t.spanIdHex()}"`);
    f.push(`"transaction":{"name":${JSON.stringify(t.name)},"type":${JSON.stringify(elasticType(t, true))},"sampled":true}`);
  }
  const fr = frames(stack);
  let ex = `"message":${JSON.stringify(message)},"type":${JSON.stringify(type)},"handled":${handled}`;
  if (isError) ex += `,"stacktrace":[${fr.join(",")}]`;
  f.push(`"exception":{${ex}}`);
  const cp = stack.length > 0 ? culprit(stack) : "";
  if (cp.length > 0) f.push(`"culprit":${JSON.stringify(cp)}`);
  f.push(`"context":{"custom":{},"tags":{},"user":{}}`);
  return `{"error":{${f.join(",")}}}`;
}

function elasticType(s: ApmSpan, tx: boolean): string {
  if (s.facade !== null) return s.type;
  if (tx) return s.kind === "server" || s.type === "web" ? "request" : s.type.length > 0 ? s.type : "custom";
  if (s.type === "sql" || s.type === "redis" || s.type === "mongodb" || s.type === "elasticsearch" || s.type === "db") return "db";
  if (s.type === "http" || s.kind === "client") return "external";
  return s.type.length > 0 ? s.type : "custom";
}

/** Sends to the APM Server's intake v2. */
export class ElasticExporter implements ApmExporter {
  url: string;
  auth: string;
  /** error events waiting for the next request */
  errors: string[] = [];
  constructor(url: string, auth: string) {
    this.url = url;
    this.auth = auth;
  }
  metadata(): string {
    const info = Apm.info;
    const svc = [`"name":${JSON.stringify(info.service)}`];
    if (info.env.length > 0) svc.push(`"environment":${JSON.stringify(info.env)}`);
    if (info.version.length > 0) svc.push(`"version":${JSON.stringify(info.version)}`);
    svc.push(`"agent":{"name":"nodejs","version":"4.18.0","activation_method":"import"}`, `"language":{"name":"javascript"}`, `"runtime":{"name":"xisto","version":"0.1.0"}`);
    const sys = [`"architecture":${JSON.stringify(process.arch)}`, `"platform":${JSON.stringify(process.platform)}`, `"detected_hostname":${JSON.stringify(hostName())}`];
    if (info.hostname.length > 0) sys.push(`"configured_hostname":${JSON.stringify(info.hostname)}`);
    const proc = `"process":{"pid":${process.pid},"ppid":${process.ppid},"title":${JSON.stringify(process.title)},"argv":${JSON.stringify(process.argv)}}`;
    let labels = "";
    if (info.tags.size > 0) {
      const m = new Map<string, string>();
      for (const k of info.tags.keys()) m.set(labelKey(k), JSON.stringify(info.tags.get(k) ?? ""));
      labels = `,"labels":${jsonMap(m)}`;
    }
    return `{"metadata":{"service":{${svc.join(",")}},${proc},"system":{${sys.join(",")}}${labels}}}`;
  }
  /** The ndjson body of these traces and the queued errors. */
  body(traces: ApmSpan[][]): string {
    const lines: string[] = [this.metadata()];
    for (const t of traces) {
      for (const s of t) {
        const tx = isTransaction(s);
        const f: any = s.facade;
        const g: GenericSpan | null = s.facade !== null ? (f as GenericSpan) : null;
        const labels = g !== null ? (g as GenericSpan).labels : new Map<string, string>();
        if (g === null) for (const k of s.tags.keys()) labels.set(labelKey(k), JSON.stringify(s.tags.get(k) ?? ""));
        if (g === null) for (const k of s.nums.keys()) labels.set(labelKey(k), String(s.nums.get(k) ?? 0));
        const common = [
          `"id":"${s.spanIdHex()}"`,
          `"trace_id":"${s.traceIdHex()}"`,
          `"name":${JSON.stringify(s.name)}`,
          `"type":${JSON.stringify(elasticType(s, tx))}`,
          `"timestamp":${us(s.startNs)}`,
          `"duration":${ms(s.durationNs)}`,
          `"sample_rate":1`,
        ];
        if (s.parentId.length > 0) common.push(`"parent_id":"${s.parentId}"`);
        if (tx) {
          let started = 0;
          let result = "success";
          let outcome = s.error ? "failure" : "success";
          let custom = "{}";
          let user = "{}";
          if (g !== null) {
            const tr = f as Transaction;
            started = tr.started;
            result = String(tr.result);
            outcome = tr.outcome;
            custom = jsonMap(tr.custom);
            user = jsonMap(tr.user);
          } else {
            for (const c of t) if (c !== s && !isTransaction(c) && txOf(c) === s) started++;
            const code = s.nums.get("http.status_code");
            if (code !== null) result = `HTTP ${Math.trunc((code as number) / 100)}xx`;
          }
          common.push(
            `"result":${JSON.stringify(result)}`,
            `"outcome":${JSON.stringify(outcome)}`,
            `"sampled":true`,
            `"span_count":{"started":${started}}`,
            `"context":{"cloud":{},"custom":${custom},"message":{},"service":{},"tags":${jsonMap(labels)},"user":${user}}`,
          );
          lines.push(`{"transaction":{${common.join(",")}}}`);
        } else {
          const sub = g !== null ? (g as GenericSpan).subtype : s.component.length > 0 ? s.component : null;
          const act = g !== null ? (g as GenericSpan).action : null;
          const outcome = g !== null ? (g as GenericSpan).outcome : s.error ? "failure" : "success";
          common.push(
            `"transaction_id":"${txOf(s).spanIdHex()}"`,
            `"subtype":${jsonOrNull(sub)}`,
            `"action":${jsonOrNull(act)}`,
            `"outcome":${JSON.stringify(outcome)}`,
            `"sync":${g !== null ? (g as GenericSpan).sync : false}`,
          );
          if (labels.size > 0) common.push(`"context":{"tags":${jsonMap(labels)}}`);
          lines.push(`{"span":{${common.join(",")}}}`);
        }
        if (g === null && s.error) {
          lines.push(errorEventOf(s.errorType.length > 0 ? s.errorType : "Error", s.errorMessage, s.errorStack, true, s, false));
        }
        s.facade = null;
      }
    }
    for (const e of this.errors) lines.push(e);
    this.errors = [];
    return lines.join("\n") + "\n";
  }
  async send(traces: ApmSpan[][]): Promise<void> {
    const body = this.body(traces);
    const h: Record<string, string> = { "Content-Type": "application/x-ndjson" };
    if (this.auth.length > 0) h["Authorization"] = this.auth;
    try {
      Apm.skipNextFetch(); // (its own request is not traced, as the agent's)
      await fetch(this.url, { method: "POST", headers: h, body: body });
    } catch (err) {
      // (an APM Server that is down loses this batch, as the agent does)
    }
  }
}

function txOf(s: ApmSpan): ApmSpan {
  let t: ApmSpan = s;
  while (t.parent !== null) {
    t = t.parent as ApmSpan;
    if (isTransaction(t)) return t;
  }
  return t;
}

// ---- the agent ----

function env(name: string): string | null {
  const v = process.env[name];
  return v === null || v === "" ? null : v;
}

/** The agent: `import apm from "elastic-apm-node"`. */
export class Agent {
  started: boolean = false;
  exporter: ElasticExporter | null = null;
  exitHooked: boolean = false;

  /** Starts the agent; options as the npm package's, ELASTIC_APM_* variables win over them. */
  start(opts: AgentConfigOptions | null = null): Agent {
    if (this.started) throw new Error("Do not call .start() more than once");
    this.started = true;
    const o: AgentConfigOptions = opts ?? {};
    const activeEnv = env("ELASTIC_APM_ACTIVE");
    const active = activeEnv !== null ? activeEnv !== "false" : o.active !== false;
    if (!active) return this;
    const info = new ApmServiceInfo();
    info.service = env("ELASTIC_APM_SERVICE_NAME") ?? o.serviceName ?? "unknown-nodejs-service";
    info.env = env("ELASTIC_APM_ENVIRONMENT") ?? o.environment ?? env("NODE_ENV") ?? "development";
    info.version = env("ELASTIC_APM_SERVICE_VERSION") ?? o.serviceVersion ?? "";
    info.hostname = env("ELASTIC_APM_HOSTNAME") ?? o.hostname ?? "";
    const rate = env("ELASTIC_APM_TRANSACTION_SAMPLE_RATE");
    info.sampleRate = rate !== null ? Number(rate) : o.transactionSampleRate ?? 1;
    const gl = env("ELASTIC_APM_GLOBAL_LABELS");
    if (gl !== null) {
      for (const kv of gl.split(",")) {
        const eq = kv.indexOf("=");
        if (eq > 0) info.tags.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
      }
    } else if (o.globalLabels !== null) {
      const g = o.globalLabels as Record<string, any>;
      for (const k of Object.keys(g)) info.tags.set(k, String(g[k]));
    }
    let url = env("ELASTIC_APM_SERVER_URL") ?? o.serverUrl ?? "http://127.0.0.1:8200";
    while (url.endsWith("/")) url = url.slice(0, url.length - 1);
    const apiKey = env("ELASTIC_APM_API_KEY") ?? o.apiKey ?? "";
    const token = env("ELASTIC_APM_SECRET_TOKEN") ?? o.secretToken ?? "";
    const auth = apiKey.length > 0 ? `ApiKey ${apiKey}` : token.length > 0 ? `Bearer ${token}` : "";
    const ex = new ElasticExporter(url + "/intake/v2/events", auth);
    this.exporter = ex;
    Apm.start(info, ex);
    if (!this.exitHooked) {
      this.exitHooked = true;
      process.on("beforeExit", () => {
        if (ex.errors.length > 0) ex.send([]);
      });
    }
    return this;
  }
  isStarted(): boolean {
    return this.started;
  }
  /** A new transaction (a new trace, or a child of opts.childOf: a traceparent string or a span); it becomes the
   * current one. */
  startTransaction(name: string | null = null, type: string | null = null, opts: TransactionOptions | null = null): Transaction {
    if (!Apm.on) {
      // (not tracing: a transaction that is never sent, as the agent's when inactive)
      const tr = new ApmTrace(newId(), newId());
      tr.priority = 0;
      const n = new ApmSpan(tr, newId(), "", null, name ?? "unnamed");
      n.type = type ?? "custom";
      tr.spans.push(n);
      tr.open++;
      return new Transaction(n);
    }
    const o = new ApmSpanOptions();
    o.root = true;
    o.type = type ?? "custom";
    o.kind = "server";
    o.component = "elastic-apm-node";
    if (opts !== null && opts.childOf !== null) {
      const c: any = opts.childOf;
      if (typeof c === "string") {
        const h = new Map<string, string>();
        h.set("traceparent", c as string);
        const p = extractParent(h);
        if (p !== null) {
          o.root = false;
          o.remote = p as ApmParent;
        }
      } else if (c instanceof GenericSpan) {
        o.root = false;
        o.childOf = (c as GenericSpan).core;
      }
    }
    const core = newSpan(name ?? "unnamed", o) as ApmSpan;
    core.kind = "server";
    if (opts !== null && opts.startTime !== null) core.startNs = Math.trunc((opts.startTime as number) * 1000000);
    const t = new Transaction(core);
    enterSpan(core);
    return t;
  }
  /** A span of the current transaction (null when there is none), a child of the current span; it becomes current. */
  startSpan(name: string | null = null, type: string | null = null, subtype: string | null = null, action: string | null = null, opts: TransactionOptions | null = null): Span | null {
    const cur = activeSpan();
    if (cur === null) return null;
    return makeSpan(cur as ApmSpan, name, type, subtype, action, opts);
  }
  get currentTransaction(): Transaction | null {
    const cur = activeSpan();
    if (cur === null) return null;
    const t = transactionOf(cur as ApmSpan);
    if (t === null || (t as Transaction).core.ended) return null;
    return t;
  }
  get currentSpan(): Span | null {
    const cur = activeSpan();
    if (cur === null) return null;
    const c = cur as ApmSpan;
    if (c.ended || c.facade === null) return null;
    const f: any = c.facade;
    if ((f as GenericSpan).isTx) return null;
    return f as Span;
  }
  /** {"trace.id", "transaction.id", "span.id"} of the current span ({} when none). */
  get currentTraceIds(): Record<string, string> {
    const r: Record<string, string> = {};
    const cur = activeSpan();
    if (cur === null) return r;
    const c = cur as ApmSpan;
    r["trace.id"] = c.traceIdHex();
    let t: ApmSpan = c;
    while (!isTransaction(t) && t.parent !== null) t = t.parent as ApmSpan;
    r["transaction.id"] = t.spanIdHex();
    if (t !== c) r["span.id"] = c.spanIdHex();
    return r;
  }
  get currentTraceparent(): string | null {
    const cur = activeSpan();
    if (cur === null) return null;
    const c = cur as ApmSpan;
    return `00-${c.traceIdHex()}-${c.spanIdHex()}-${c.trace.priority > 0 ? "01" : "00"}`;
  }
  /** Sends err (an Error or a message) as an error event of the current transaction and span. */
  captureError(err: any, opts: any = null, cb: ((err: Error | null, id: string) => void) | null = null): void {
    const ex = this.exporter;
    if (ex === null || !Apm.on) {
      if (cb !== null) cb(null, "");
      return;
    }
    const cur = activeSpan();
    const ev = errorEvent(err, cur !== null && !(cur as ApmSpan).ended ? cur : null, true);
    (ex as ElasticExporter).errors.push(ev);
    if (cb !== null) cb(null, ev.slice(14, 46));
  }
  setLabel(key: string, value: any, stringify: boolean = true): boolean {
    const t = this.currentTransaction;
    if (t === null) return false;
    return (t as Transaction).setLabel(key, value, stringify);
  }
  addLabels(labels: Record<string, any>, stringify: boolean = true): boolean {
    const t = this.currentTransaction;
    if (t === null) return false;
    return (t as Transaction).addLabels(labels, stringify);
  }
  setCustomContext(ctx: Record<string, any>): boolean {
    const t = this.currentTransaction;
    if (t === null) return false;
    (t as Transaction).setCustomContext(ctx);
    return true;
  }
  setUserContext(u: Record<string, any>): boolean {
    const t = this.currentTransaction;
    if (t === null) return false;
    (t as Transaction).setUserContext(u);
    return true;
  }
  setTransactionName(name: string): void {
    const t = this.currentTransaction;
    if (t !== null) {
      const tt = t as Transaction;
      tt.name = name;
    }
  }
  setTransactionOutcome(outcome: string): void {
    const t = this.currentTransaction;
    if (t !== null) (t as Transaction).setOutcome(outcome);
  }
  setSpanOutcome(outcome: string): void {
    const s = this.currentSpan;
    if (s !== null) (s as Span).setOutcome(outcome);
  }
  /** Ends the current transaction (with a result). */
  endTransaction(result: any = null, endTime: number | null = null): void {
    const t = this.currentTransaction;
    if (t === null) return;
    if (result !== null) (t as Transaction).result = result;
    (t as Transaction).end(endTime);
  }
  /** Sends what is queued; cb runs once it is sent (also: the promise resolves). */
  flush(cb: ((err: Error | null) => void) | null = null): Promise<void> {
    const ex = this.exporter;
    const p = (async (): Promise<void> => {
      await Apm.flush();
      if (ex !== null && (ex as ElasticExporter).errors.length > 0) await (ex as ElasticExporter).send([]);
      if (cb !== null) cb(null);
    })();
    return p;
  }
  /** Stops the agent (spans already ended are sent at the next flush). */
  destroy(): Promise<void> {
    Apm.stop();
    return this.flush(null);
  }
  addFilter(fn: any): void {}
  addErrorFilter(fn: any): void {}
  addSpanFilter(fn: any): void {}
  addTransactionFilter(fn: any): void {}
  setFramework(f: any): void {}
  lambda(fn: any): any {
    return fn;
  }
}

const agent = new Agent();
export default agent;

/** The same agent's methods, for `import * as apm` and require("elastic-apm-node"). */
export function start(opts: AgentConfigOptions | null = null): Agent {
  return agent.start(opts);
}
export function isStarted(): boolean {
  return agent.isStarted();
}
export function startTransaction(name: string | null = null, type: string | null = null, opts: TransactionOptions | null = null): Transaction {
  return agent.startTransaction(name, type, opts);
}
export function startSpan(name: string | null = null, type: string | null = null, subtype: string | null = null, action: string | null = null, opts: TransactionOptions | null = null): Span | null {
  return agent.startSpan(name, type, subtype, action, opts);
}
export function captureError(err: any, opts: any = null, cb: ((err: Error | null, id: string) => void) | null = null): void {
  agent.captureError(err, opts, cb);
}
export function flush(cb: ((err: Error | null) => void) | null = null): Promise<void> {
  return agent.flush(cb);
}
