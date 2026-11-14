// xisto-apm: the tracing core that the APM packages (dd-trace, newrelic, elastic-apm-node, @dynatrace/oneagent,
// appdynamics) share, and the hooks the other packages call to be instrumented.
//
// A binary made by xisto cannot patch other modules at run time, as Node's APM agents do. Instead the packages that an
// agent would instrument (@nestjs/core, express, pg, oracledb, mongodb, redis, ioredis, @elastic/elasticsearch, the
// loggers) call these hooks. With no agent started, enabled() is false and startSpan() gives null: one test of a
// boolean per call.
//
// Model: a span has a 128-bit trace id (traceHi, traceLo; Datadog uses the low 64 bits and keeps the high ones in
// _dd.p.tid), a 64-bit id, its parent's, a name, a resource, a service, a type, a kind (server, client, internal...),
// string tags, number tags, an error and its times (nanoseconds). The active span follows the asynchronous flow
// (AsyncLocalStorage). A trace is exported once all its spans have ended, by the exporter the agent registered, in
// batches: every 2 s (an unref'd timer), at 1000 spans, and before the program exits.
import { AsyncLocalStorage } from "node:async_hooks";

declare function isPromise(v: unknown): boolean;
declare function onSettle(p: unknown, cb: (failed: boolean, err: Error | null) => void): void;
declare function randomId(): string;
declare function hexToDec(h: string): string;
declare function decToHex(d: string): string;
declare function nowNs(): number;
declare function monoNs(): number;
declare function hostname(): string;

/** What an agent sends finished traces to: the backend's protocol (Datadog Agent, OTLP, Elastic intake). */
export interface ApmExporter {
  /** Sends these traces (each a list of spans, root first); resolves once sent (or failed: never rejects). */
  send(traces: ApmSpan[][]): Promise<void>;
}

/** The settings of the service being traced (the agent's init/start options and environment). */
export class ApmServiceInfo {
  service: string = "";
  env: string = "";
  version: string = "";
  hostname: string = "";
  /** tags added to every span (DD_TAGS, global labels) */
  tags: Map<string, string> = new Map<string, string>();
  /** the share of traces kept, 0..1 */
  sampleRate: number = 1;
}

/** The spans of one trace in this process. */
export class ApmTrace {
  /** the trace id's two halves, 16 hex digits each */
  hi: string;
  lo: string;
  spans: ApmSpan[] = [];
  open: int = 0;
  /** keep (1), drop (0); from the sampler or the incoming request */
  priority: int = 1;
  /** the user of the request (setUser): usr.* tags on the root */
  user: Map<string, string> = new Map<string, string>();
  /** propagated tags (x-datadog-tags, tracestate) */
  propagated: Map<string, string> = new Map<string, string>();
  constructor(hi: string, lo: string) {
    this.hi = hi;
    this.lo = lo;
  }
}

/** One operation: a request served, a query, a call made. */
export class ApmSpan {
  trace: ApmTrace;
  /** 16 hex digits */
  id: string;
  /** the parent's id ("" for a root) */
  parentId: string;
  /** the parent in this process (null for a root, and for a span whose parent came from another service) */
  parent: ApmSpan | null;
  name: string;
  resource: string = "";
  service: string = "";
  type: string = "";
  /** "server", "client", "producer", "consumer", "internal" */
  kind: string = "internal";
  /** the instrumentation that made it ("pg", "express"...; "opentracing" for the manual API) */
  component: string = "";
  tags: Map<string, string> = new Map<string, string>();
  nums: Map<string, number> = new Map<string, number>();
  error: boolean = false;
  errorType: string = "";
  errorMessage: string = "";
  errorStack: string = "";
  /** dd-trace's _dd.measured (trace() and wrap() spans, integrations) */
  measured: boolean = false;
  /** the agent's own object for this span (dd-trace's ApmSpan, Elastic's Transaction...), so that the same one comes back */
  facade: any = null;
  /** nanoseconds since the epoch (a number: past 2^53 xisto's int stops) */
  startNs: number;
  durationNs: number = 0;
  ended: boolean = false;
  private startMono: number;

  constructor(trace: ApmTrace, id: string, parentId: string, parent: ApmSpan | null, name: string) {
    this.trace = trace;
    this.id = id;
    this.parentId = parentId;
    this.parent = parent;
    this.name = name;
    this.startNs = nowNs();
    this.startMono = monoNs();
  }

  /** A tag: a number goes with the numbers, an Error sets the error, anything else is kept as text. */
  setTag(key: string, value: any): ApmSpan {
    if (value === null) return this;
    if (typeof value === "number") {
      this.nums.set(key, value as number);
      return this;
    }
    if (value instanceof Error) {
      this.setError(value as Error);
      return this;
    }
    if (typeof value === "boolean" && key === "error") {
      this.error = value as boolean;
      return this;
    }
    this.tags.set(key, String(value));
    return this;
  }
  setText(key: string, value: string): ApmSpan {
    this.tags.set(key, value);
    return this;
  }
  setNumber(key: string, value: number): ApmSpan {
    this.nums.set(key, value);
    return this;
  }
  /** Marks the span failed with this error (its type, message and stack). */
  setError(err: Error): ApmSpan {
    this.error = true;
    this.errorType = err.name;
    this.errorMessage = err.message;
    this.errorStack = err.stack ?? "";
    return this;
  }
  /** Ends the span (now, or at a time in milliseconds since the epoch); a span ends once. */
  finish(endTimeMs: number = -1): void {
    if (this.ended) return;
    this.ended = true;
    this.durationNs = endTimeMs >= 0 ? Math.trunc(endTimeMs * 1000000) - this.startNs : monoNs() - this.startMono;
    if (this.durationNs < 0) this.durationNs = 0;
    Apm.spanEnded(this);
  }
  /** The trace id as 32 hex digits (W3C, OTLP, Elastic). */
  traceIdHex(): string {
    return this.trace.hi + this.trace.lo;
  }
  /** The span id as 16 hex digits. */
  spanIdHex(): string {
    return this.id;
  }
  /** Datadog's decimal ids */
  ddTraceId(): string {
    return hexToDec(this.trace.lo);
  }
  ddSpanId(): string {
    return hexToDec(this.id);
  }
}

/** Datadog's decimal id (up to 2^64 - 1) as 16 hex digits; "" when not a number. */
export function ddIdToHex(d: string): string {
  return decToHex(d);
}
/** 16 hex digits as Datadog's decimal id. */
export function hexToDdId(h: string): string {
  return hexToDec(h);
}
function isHex(s: string, n: int): boolean {
  if (s.length !== n) return false;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return s !== "0000000000000000" && s !== "00000000000000000000000000000000";
}

/** Where a span comes from: its parent here, or the trace and span of the service that called this one. */
export class ApmParent {
  traceHi: string;
  traceLo: string;
  spanId: string;
  priority: int;
  constructor(traceHi: string, traceLo: string, spanId: string, priority: int) {
    this.traceHi = traceHi;
    this.traceLo = traceLo;
    this.spanId = spanId;
    this.priority = priority;
  }
}

/** The options of startSpan(). */
export class ApmSpanOptions {
  resource: string = "";
  type: string = "";
  kind: string = "internal";
  service: string = "";
  component: string = "";
  /** the parent span (by default the active one); a remote parent comes in remote */
  childOf: ApmSpan | null = null;
  remote: ApmParent | null = null;
  /** no parent at all, even with an active span */
  root: boolean = false;
  measured: boolean = false;
}

const store: AsyncLocalStorage<ApmSpan> = new AsyncLocalStorage<ApmSpan>();

/** The tracer registry: whether an agent is running, its service and where its traces go. */
export class Apm {
  static on: boolean = false;
  static info: ApmServiceInfo = new ApmServiceInfo();
  static exporter: ApmExporter | null = null;
  static pending: ApmSpan[][] = [];
  static pendingSpans: int = 0;
  static flushing: boolean = false;
  static timer: int = 0;
  /** called with each span as it starts (agents: their own defaults, e.g. Elastic's transaction names) */
  static onStart: ((span: ApmSpan) => void) | null = null;
  static flushMs: int = 2000;
  static exitHooked: boolean = false;

  /** Starts tracing: spans are made from now on and sent to the exporter. */
  static start(info: ApmServiceInfo, exporter: ApmExporter): void {
    Apm.info = info;
    Apm.exporter = exporter;
    Apm.on = true;
    if (Apm.timer === 0) Apm.timer = setInterval(() => Apm.flush(), Apm.flushMs).unref();
    if (!Apm.exitHooked) {
      Apm.exitHooked = true;
      process.on("beforeExit", () => {
        if (Apm.pending.length > 0) Apm.flush();
      });
    }
  }
  /** How often queued traces are sent (before start()). */
  static setFlushInterval(ms: int): void {
    Apm.flushMs = ms;
  }
  /** Stops tracing (spans already ended are still sent at the next flush). */
  static stop(): void {
    Apm.on = false;
  }
  /** (internal) a span ended: its trace goes to the queue when it was the last one open */
  static spanEnded(span: ApmSpan): void {
    const t = span.trace;
    t.open--;
    if (t.open > 0) return;
    if (t.priority <= 0 || !Apm.on && Apm.exporter === null) return;
    Apm.pending.push(t.spans);
    Apm.pendingSpans += t.spans.length;
    if (Apm.pendingSpans >= 1000) Apm.flush();
  }
  /** Sends what is queued (a promise that resolves once it is sent). */
  static flush(): Promise<void> {
    const ex = Apm.exporter;
    if (ex === null || Apm.pending.length === 0) return Promise.resolve();
    const batch = Apm.pending;
    Apm.pending = [];
    Apm.pendingSpans = 0;
    return ex.send(batch);
  }
}

/** True when an agent is tracing (the instrumented packages test this first). */
export function enabled(): boolean {
  return Apm.on;
}

/** The span of the current asynchronous flow, or null. */
export function activeSpan(): ApmSpan | null {
  return store.getStore();
}

/** Starts a span: a child of the options' parent (by default the active span), or a new trace. Null when no agent
 * is tracing. */
export function startSpan(name: string, options: ApmSpanOptions | null = null): ApmSpan | null {
  if (!Apm.on) return null;
  const o = options ?? new ApmSpanOptions();
  const parent: ApmSpan | null = o.root ? null : o.childOf !== null ? o.childOf : o.remote !== null ? null : store.getStore();
  let span: ApmSpan;
  if (parent !== null) {
    span = new ApmSpan(parent.trace, randomId(), parent.id, parent, name);
  } else if (o.remote !== null) {
    const r = o.remote as ApmParent;
    const t = new ApmTrace(r.traceHi, r.traceLo);
    t.priority = r.priority;
    span = new ApmSpan(t, randomId(), r.spanId, null, name);
  } else {
    // (the high half as dd-trace makes it: the start's seconds in 32 bits, then zeros)
    const secs = Math.trunc(nowNs() / 1000000000).toString(16);
    const t = new ApmTrace("00000000".slice(secs.length) + secs + "00000000", randomId());
    t.priority = Apm.info.sampleRate >= 1 || Math.random() < Apm.info.sampleRate ? 1 : 0;
    span = new ApmSpan(t, randomId(), "", null, name);
  }
  span.trace.spans.push(span);
  span.trace.open++;
  span.resource = o.resource.length > 0 ? o.resource : name;
  span.service = o.service.length > 0 ? o.service : parent !== null ? parent.service : Apm.info.service;
  span.type = o.type;
  span.kind = o.kind;
  span.component = o.component;
  span.measured = o.measured;
  const hook = Apm.onStart;
  if (hook !== null) hook(span);
  return span;
}

/** Runs fn with span active (the asynchronous flow it starts too); its value returned. */
export function runIn<T>(span: ApmSpan | null, fn: () => T): T {
  if (span === null) return fn();
  return store.run(span, fn);
}

/** Ends span when value settles (a promise), or now (any other value); an error marks it. */
export function finishWith(span: ApmSpan, value: any): any {
  const u: unknown = value;
  if (isPromise(u)) {
    onSettle(u, (failed: boolean, err: Error | null): void => {
      if (failed && err !== null) span.setError(err as Error);
      span.finish();
    });
  } else {
    span.finish();
  }
  return value;
}

/** Runs fn inside a new span that ends with it: when it returns or throws, or when the promise it returns settles
 * (an async fn). Its value is given back as is (await it for an async fn's). */
export function trace(name: string, options: ApmSpanOptions | null, fn: (span: ApmSpan | null) => any): any {
  const span = startSpan(name, options);
  if (span === null) return fn(null);
  try {
    const v: any = store.run(span, (): any => fn(span));
    return finishWith(span, v);
  } catch (err) {
    span.setError(err as Error);
    span.finish();
    throw err;
  }
}

/** Runs an async fn inside a new span that ends when its promise settles. */
export async function traceAsync<T>(name: string, options: ApmSpanOptions | null, fn: (span: ApmSpan | null) => Promise<T>): Promise<T> {
  const span = startSpan(name, options);
  if (span === null) return await fn(null);
  try {
    return await store.run(span, async (): Promise<T> => await fn(span));
  } catch (err) {
    span.setError(err as Error);
    throw err;
  } finally {
    span.finish();
  }
}

/** The parent an incoming request carries in its headers (W3C traceparent, Datadog, Elastic), or null. Header names in
 * lower case. */
export function extract(headers: Map<string, string>): ApmParent | null {
  const tp = headers.get("traceparent") ?? headers.get("elastic-apm-traceparent");
  if (tp !== null) {
    const p = tp.toLowerCase().split("-");
    if (p.length >= 4 && isHex(p[1], 32) && isHex(p[2], 16)) return new ApmParent(p[1].slice(0, 16), p[1].slice(16), p[2], p[3] === "01" ? 1 : 0);
  }
  const dt = headers.get("x-datadog-trace-id");
  const dp = headers.get("x-datadog-parent-id");
  if (dt !== null && dp !== null) {
    const lo = decToHex(dt);
    const id = decToHex(dp);
    if (lo.length === 0 || id.length === 0) return null;
    let hi = "0000000000000000";
    const tags = headers.get("x-datadog-tags");
    if (tags !== null) {
      for (const kv of tags.split(",")) if (kv.startsWith("_dd.p.tid=") && isHex(kv.slice(10), 16)) hi = kv.slice(10);
    }
    const pr = headers.get("x-datadog-sampling-priority");
    return new ApmParent(hi, lo, id, pr !== null && Number(pr) <= 0 ? 0 : 1);
  }
  return null;
}

/** The headers that carry span to the service it calls (W3C traceparent and Datadog's). */
export function inject(span: ApmSpan, headers: Map<string, string>): void {
  const flags = span.trace.priority > 0 ? "01" : "00";
  headers.set("traceparent", `00-${span.traceIdHex()}-${span.spanIdHex()}-${flags}`);
  headers.set("x-datadog-trace-id", span.ddTraceId());
  headers.set("x-datadog-parent-id", span.ddSpanId());
  headers.set("x-datadog-sampling-priority", String(span.trace.priority));
  if (span.trace.hi !== "0000000000000000") headers.set("x-datadog-tags", `_dd.p.tid=${span.trace.hi}`);
}

/** The ids of the active span for log correlation (empty strings when none). */
export class ApmLogIds {
  traceId: string = "";
  spanId: string = "";
  /** Datadog's decimal ids (dd.trace_id, dd.span_id) */
  ddTraceId: string = "";
  ddSpanId: string = "";
  /** the id of the root span of this service (Elastic's transaction.id) */
  transactionId: string = "";
}
export function logIds(): ApmLogIds {
  const ids = new ApmLogIds();
  const s = store.getStore();
  if (s === null) return ids;
  ids.traceId = s.traceIdHex();
  ids.spanId = s.spanIdHex();
  ids.ddTraceId = s.ddTraceId();
  ids.ddSpanId = s.ddSpanId();
  let root: ApmSpan = s;
  while (root.parent !== null && (root.parent as ApmSpan).service === s.service) root = root.parent as ApmSpan;
  ids.transactionId = root.spanIdHex();
  return ids;
}

// the same as startSpan/extract/inject under names an agent package can import while it exports its own
// startSpan/extract/inject (an import renamed with `as` next to a declaration of the same name renames that one)
export function newSpan(name: string, options: ApmSpanOptions | null = null): ApmSpan | null {
  return startSpan(name, options);
}
export function extractParent(headers: Map<string, string>): ApmParent | null {
  return extract(headers);
}
export function injectHeaders(span: ApmSpan, headers: Map<string, string>): void {
  inject(span, headers);
}

/** A new random id, 16 hex digits. */
export function newId(): string {
  return randomId();
}

/** The host name, for the agents' metadata. */
export function hostName(): string {
  return hostname();
}

/** The trace's root span in this process (where an agent puts its trace-level tags). */
export function localRoot(span: ApmSpan): ApmSpan {
  let r: ApmSpan = span;
  while (r.parent !== null) r = r.parent as ApmSpan;
  return r;
}

// ---- OTLP/HTTP JSON (OpenTelemetry's protocol): New Relic, Dynatrace and AppDynamics take traces in it ----

/** a time in nanoseconds as integer digits */
export function nsText(ns: number): string {
  return Math.trunc(ns).toFixed(0);
}
function otlpKind(kind: string): int {
  return kind === "server" ? 2 : kind === "client" ? 3 : kind === "producer" ? 4 : kind === "consumer" ? 5 : 1;
}
function attr(key: string, value: string): string {
  return `{"key":${JSON.stringify(key)},"value":{"stringValue":${JSON.stringify(value)}}}`;
}
function attrNum(key: string, value: number): string {
  if (Number.isInteger(value)) return `{"key":${JSON.stringify(key)},"value":{"intValue":"${value}"}}`;
  return `{"key":${JSON.stringify(key)},"value":{"doubleValue":${value}}}`;
}

/** Sends traces as OTLP/HTTP JSON to url (…/v1/traces) with these headers (the backend's key). */
export class ApmOtlpExporter implements ApmExporter {
  url: string;
  headers: Map<string, string>;
  /** resource attributes added to service.name & co (the backend's own, e.g. Dynatrace's dt.entity.*) */
  resourceAttrs: Map<string, string> = new Map<string, string>();
  constructor(url: string, headers: Map<string, string>) {
    this.url = url;
    this.headers = headers;
  }
  /** The OTLP request body of these traces. */
  body(traces: ApmSpan[][]): string {
    const info = Apm.info;
    const res: string[] = [attr("service.name", info.service), attr("telemetry.sdk.name", "xisto-apm"), attr("telemetry.sdk.language", "nodejs")];
    if (info.version.length > 0) res.push(attr("service.version", info.version));
    if (info.env.length > 0) res.push(attr("deployment.environment", info.env));
    if (info.hostname.length > 0) res.push(attr("host.name", info.hostname));
    for (const k of this.resourceAttrs.keys()) res.push(attr(k, this.resourceAttrs.get(k) ?? ""));
    const spans: string[] = [];
    for (const t of traces) {
      for (const s of t) {
        const attrs: string[] = [];
        for (const k of info.tags.keys()) attrs.push(attr(k, info.tags.get(k) ?? ""));
        for (const k of s.tags.keys()) attrs.push(attr(k, s.tags.get(k) ?? ""));
        for (const k of s.nums.keys()) attrs.push(attrNum(k, s.nums.get(k) ?? 0));
        if (s.resource.length > 0 && s.resource !== s.name) attrs.push(attr("resource.name", s.resource));
        if (s.parent === null) for (const k of s.trace.user.keys()) attrs.push(attr(`enduser.${k}`, s.trace.user.get(k) ?? ""));
        const events: string[] = [];
        if (s.error) {
          const ea = [attr("exception.type", s.errorType), attr("exception.message", s.errorMessage)];
          if (s.errorStack.length > 0) ea.push(attr("exception.stacktrace", s.errorStack));
          events.push(`{"timeUnixNano":"${nsText(s.startNs + s.durationNs)}","name":"exception","attributes":[${ea.join(",")}]}`);
        }
        const parent = s.parentId.length > 0 ? `,"parentSpanId":"${s.parentId}"` : "";
        const status = s.error ? `{"code":2,"message":${JSON.stringify(s.errorMessage)}}` : `{"code":0}`;
        spans.push(
          `{"traceId":"${s.traceIdHex()}","spanId":"${s.spanIdHex()}"${parent},"name":${JSON.stringify(s.name)},"kind":${otlpKind(s.kind)},` +
            `"startTimeUnixNano":"${nsText(s.startNs)}","endTimeUnixNano":"${nsText(s.startNs + s.durationNs)}","attributes":[${attrs.join(",")}],` +
            `"events":[${events.join(",")}],"status":${status}}`,
        );
      }
    }
    return `{"resourceSpans":[{"resource":{"attributes":[${res.join(",")}]},"scopeSpans":[{"scope":{"name":"xisto-apm","version":"0.1.0"},"spans":[${spans.join(",")}]}]}]}`;
  }
  async send(traces: ApmSpan[][]): Promise<void> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    for (const k of this.headers.keys()) h[k] = this.headers.get(k) ?? "";
    try {
      await fetch(this.url, { method: "POST", headers: h, body: this.body(traces) });
    } catch (err) {
      // (a collector that is down loses this batch, as the agents do; the program goes on)
    }
  }
}
