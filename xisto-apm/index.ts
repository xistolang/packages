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
import dc from "node:diagnostics_channel";

declare function isPromise(v: unknown): boolean;
declare function onSettle(p: unknown, cb: (failed: boolean, err: Error | null) => void): void;
declare function randomId(): string;
declare function hexToDec(h: string): string;
declare function decToHex(d: string): string;
declare function nowNs(): number;
declare function monoNs(): number;
declare function hostname(): string;
declare function udpSend(host: string, port: int, payload: string): boolean;

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
  /** new traces get a 128-bit id (dd-trace's DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED); else the high half is 0 */
  trace128: boolean = true;
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
    // (the built-in TypeError & co: their .stack is not readable through Error in xisto yet, a compiler bug reported to
    // the compiler session; their stack is left out)
    const builtin = err.name === "TypeError" || err.name === "RangeError" || err.name === "SyntaxError" || err.name === "ReferenceError" ||
      err.name === "URIError" || err.name === "EvalError" || err.name === "AggregateError";
    this.errorStack = builtin ? "" : (err.stack ?? "");
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
  /** an exporter's request gives up after this long (a collector that hangs must not hold the program) */
  static sendTimeoutMs: int = 2000;
  /** at most this many spans wait while a send is in flight; the oldest traces are dropped past it */
  static maxQueuedSpans: int = 20000;
  static flushSoonSet: boolean = false;
  /** the program is ending: one last send, with this shorter limit */
  static exitTimeoutMs: int = 1000;
  static exiting: boolean = false;
  /** The limit of an exporter's request now (shorter once the program is ending). */
  static timeoutMs(): int {
    return Apm.exiting ? Apm.exitTimeoutMs : Apm.sendTimeoutMs;
  }
  /** traces dropped because the collector could not keep up (or was down) */
  static dropped: int = 0;
  /** the next fetch is an exporter's own (not traced, as the agents leave their own requests out) */
  static untracedNext: boolean = false;
  static exitHooked: boolean = false;
  /** sees every finished trace, sampled or not (an exporter's metrics count them all) */
  static observer: ((spans: ApmSpan[]) => void) | null = null;
  /** decides, once a trace has ended, whether it is sent (an agent's sampler; null: every kept trace is sent) */
  static keepTrace: ((spans: ApmSpan[]) => boolean) | null = null;
  /** (another module assigns it through this: a static of function type is read-only outside its class's module) */
  static setKeepTrace(f: ((spans: ApmSpan[]) => boolean) | null): void {
    Apm.keepTrace = f;
  }

  /** Starts tracing: spans are made from now on and sent to the exporter. */
  static start(info: ApmServiceInfo, exporter: ApmExporter): void {
    Apm.info = info;
    Apm.exporter = exporter;
    Apm.on = true;
    instrumentHttp();
    if (Apm.timer === 0) Apm.timer = setInterval(() => Apm.flush(), Apm.flushMs).unref();
    if (!Apm.exitHooked) {
      Apm.exitHooked = true;
      process.on("beforeExit", () => {
        // one last send, bounded: a collector that is down or hangs must not hold the end of the program
        if (Apm.exiting) return;
        Apm.exiting = true;
        if (Apm.pending.length > 0 || ApmLogs.queue.length > 0) Apm.flush();
      });
    }
  }
  /** The next fetch is an exporter's own: not traced (call right before it). */
  static skipNextFetch(): void {
    Apm.untracedNext = true;
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
    const obs = Apm.observer;
    if (obs !== null) obs(t.spans);
    const keep = Apm.keepTrace;
    if (t.priority <= 0 || !Apm.on && Apm.exporter === null || (keep !== null && !keep(t.spans))) {
      t.spans = []; // (the trace and its spans point at each other: let go of them now, not in the cycle collector)
      return;
    }
    Apm.pending.push(t.spans);
    Apm.pendingSpans += t.spans.length;
    if (Apm.pendingSpans >= 1000 && !Apm.flushSoonSet) {
      // (from a timer, not here: a send started inside a request would be part of that request, and a collector
      // that hangs would hold the request's answer)
      Apm.flushSoonSet = true;
      setTimeout(() => {
        Apm.flushSoonSet = false;
        Apm.flush();
      }, 0);
    }
  }
  /** Sends what is queued (a promise that resolves once it is sent). */
  static flush(): Promise<void> {
    const ex = Apm.exporter;
    // (with an observer, the exporter has metrics to send even when no trace was kept; forwarded logs go with them)
    if (ex === null || Apm.pending.length === 0 && Apm.observer === null && ApmLogs.queue.length === 0) return Promise.resolve();
    if (Apm.flushing) {
      // one send at a time: while the collector is slow the queue waits, bounded (the oldest traces go first)
      while (Apm.pendingSpans > Apm.maxQueuedSpans && Apm.pending.length > 0) {
        const old = Apm.pending.shift();
        if (old !== undefined) {
          Apm.pendingSpans -= old.length;
          if (old.length > 0) old[0].trace.spans = [];
        }
        Apm.dropped++;
      }
      return Promise.resolve();
    }
    const batch = Apm.pending;
    Apm.pending = [];
    Apm.pendingSpans = 0;
    Apm.flushing = true;
    return Apm.sendBatch(ex, batch);
  }
  static async sendBatch(ex: ApmExporter, batch: ApmSpan[][]): Promise<void> {
    try {
      await ex.send(batch);
    } catch (err) {
      // (the exporters catch their own errors; nothing reaches the program)
    }
    for (const t of batch) if (t.length > 0) t[0].trace.spans = []; // (sent: break the trace <-> spans cycle)
    Apm.flushing = false;
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
    const t = new ApmTrace(Apm.info.trace128 ? "00000000".slice(secs.length) + secs + "00000000" : "0000000000000000", randomId());
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

/** Makes span the active one for the rest of the current execution and what it starts (null: none), as Elastic's
 * startTransaction()/startSpan() do. */
export function enterSpan(span: ApmSpan | null): void {
  if (span === null) store.disable();
  else store.enterWith(span);
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

// ---- logs in context: what the agent adds to the application's log lines, and the lines it forwards ----
// The loggers (nestjs-pino) ask here, once per line and only with an agent started: dd-trace's logInjection adds a
// "dd" object at the end of each JSON line; New Relic's local decorating appends " NR-LINKING|..." to the message and
// its forwarding queues the line for the exporter (OTLP /v1/logs, with the active span's traceId and spanId); the
// Elastic agent's ECS fields (trace.id, transaction.id, span.id) go on ECS lines.

/** One forwarded log line: OTLP LogRecord's fields, its attributes as OTLP JSON. */
export class ApmLogRecord {
  timeNs: number;
  /** pino's level label (info, warn...) */
  level: string;
  message: string;
  /** the active span's ids (hex), "" outside a span */
  traceId: string = "";
  spanId: string = "";
  attrs: string[] = [];
  constructor(timeNs: number, level: string, message: string) {
    this.timeNs = timeNs;
    this.level = level;
    this.message = message;
  }
}

/** The log settings the agent started with. */
export class ApmLogs {
  /** dd-trace's logInjection (DD_LOGS_INJECTION) */
  static ddInjection: boolean = false;
  /** dd.trace_id as the 128-bit id in hex when the trace has a high half (DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED);
   * else the low 64 bits in decimal */
  static dd128: boolean = true;
  /** New Relic's application_logging.local_decorating */
  static nrDecorating: boolean = false;
  /** the Elastic agent's ids on ECS lines */
  static ecsIds: boolean = false;
  /** lines are queued for the exporter (New Relic's application_logging.forwarding) */
  static forwarding: boolean = false;
  /** at most this many lines wait between two sends; the newest are dropped past it */
  static maxQueued: int = 10000;
  static queue: ApmLogRecord[] = [];
  static dropped: int = 0;
  // (the agents set these through the methods: a static is read-only outside its class's module)
  /** dd-trace's settings */
  static setDatadog(injection: boolean, logs128: boolean): void {
    ApmLogs.ddInjection = injection;
    ApmLogs.dd128 = logs128;
  }
  /** New Relic's application_logging settings */
  static setNewRelic(forwarding: boolean, decorating: boolean, maxQueued: int): void {
    ApmLogs.forwarding = forwarding;
    ApmLogs.nrDecorating = decorating;
    ApmLogs.maxQueued = maxQueued;
  }
  /** the Elastic agent's ECS ids */
  static setEcs(on: boolean): void {
    ApmLogs.ecsIds = on;
  }
  /** The queued lines, and an empty queue. */
  static take(): ApmLogRecord[] {
    const q = ApmLogs.queue;
    ApmLogs.queue = [];
    return q;
  }
}

/** dd-trace's "dd" field as ',"dd":{...}' (trace_id and span_id of the active span, then service, version and env), or
 * "" when log injection is off or there is nothing to put in it. */
export function ddLogField(): string {
  if (!Apm.on || !ApmLogs.ddInjection) return "";
  const parts: string[] = [];
  const s = store.getStore();
  if (s !== null) {
    const traceId = ApmLogs.dd128 && s.trace.hi !== "0000000000000000" ? s.traceIdHex() : s.ddTraceId();
    parts.push(`"trace_id":${JSON.stringify(traceId)}`);
    parts.push(`"span_id":${JSON.stringify(s.ddSpanId())}`);
  }
  const info = Apm.info;
  if (info.service.length > 0) parts.push(`"service":${JSON.stringify(info.service)}`);
  if (info.version.length > 0) parts.push(`"version":${JSON.stringify(info.version)}`);
  if (info.env.length > 0) parts.push(`"env":${JSON.stringify(info.env)}`);
  return parts.length === 0 ? "" : `,"dd":{${parts.join(",")}}`;
}

/** New Relic's local decorating: the message with " NR-LINKING|entity.guid|hostname|trace.id|span.id|entity.name|"
 * appended (the entity guid is the collector's, never known here: empty), or the message as is when it is off. */
export function decorateLogMessage(message: string): string {
  if (!Apm.on || !ApmLogs.nrDecorating) return message;
  const s = store.getStore();
  const traceId = s === null ? "" : s.traceIdHex();
  const spanId = s === null ? "" : s.spanIdHex();
  return `${message} NR-LINKING||${Apm.info.hostname}|${traceId}|${spanId}|${encodeURIComponent(Apm.info.service)}|`;
}

/** The Elastic agent's ids for an ECS line as ',"k":v' pairs: trace.id, transaction.id and, inside a span of the
 * transaction, span.id; "" when that agent is not running or no span is active. */
export function ecsLogIds(): string {
  if (!Apm.on || !ApmLogs.ecsIds) return "";
  if (store.getStore() === null) return "";
  const ids = logIds();
  let out = `,"trace.id":${JSON.stringify(ids.traceId)},"transaction.id":${JSON.stringify(ids.transactionId)}`;
  if (ids.spanId !== ids.transactionId) out += `,"span.id":${JSON.stringify(ids.spanId)}`;
  return out;
}

/** True when the agent forwards log lines (the logger then calls forwardLog for each line it writes). */
export function forwardingLogs(): boolean {
  return Apm.on && ApmLogs.forwarding;
}

/** Queues a log line for the exporter, with the active span's ids. fields: the line's other fields as a JSON object
 * text ('{"pid":1,"context":"Users"}'; "" for none), sent as attributes. */
export function forwardLog(level: string, message: string, fields: string): void {
  if (!Apm.on || !ApmLogs.forwarding) return;
  if (ApmLogs.queue.length >= ApmLogs.maxQueued) {
    ApmLogs.dropped++;
    return;
  }
  const r = new ApmLogRecord(nowNs(), level, message);
  const s = store.getStore();
  if (s !== null) {
    r.traceId = s.traceIdHex();
    r.spanId = s.spanIdHex();
  }
  if (fields.length > 2) {
    try {
      const obj = JSON.parse(fields) as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === "string") r.attrs.push(attr(k, v as string));
        else if (typeof v === "number") r.attrs.push(attrNum(k, v as number));
        else if (typeof v === "boolean") r.attrs.push(`{"key":${JSON.stringify(k)},"value":{"boolValue":${v ? "true" : "false"}}}`);
        else if (v !== null && v !== undefined) r.attrs.push(attr(k, JSON.stringify(v)));
      }
    } catch (err) {
      // (not JSON: the line goes without its fields)
    }
  }
  ApmLogs.queue.push(r);
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
/** One UDP datagram (DogStatsD); false when it could not be sent (never blocks, never throws). */
export function sendUdp(host: string, port: int, payload: string): boolean {
  return udpSend(host, port, payload);
}
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
  return ns.toFixed(0); // (no int on the way: past 2^53 an int stops)
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

// ---- OpenTelemetry's semantic conventions (the OTLP exporters) ----
// The spans keep the Datadog-style model the instrumentations fill (http.method, http.url, db.type, out.host...);
// OTLP backends read OpenTelemetry's conventions instead (New Relic's Transactions, Databases and External services
// pages, Dynatrace's services): otelName/otelAttrs translate one span, and the same view feeds the metrics below.
// Only the stable conventions (db.system.name, db.operation.name, db.collection.name, db.query.text): with the older
// db.system & co on the spans too, New Relic derived each database call twice (from the metric and from the span).

/** db.type (Datadog's) to db.system (OpenTelemetry's) */
function dbSystem(t: string): string {
  return t === "postgres" ? "postgresql" : t === "sqlserver" ? "mssql" : t;
}
/** the SQL statement's operation (SELECT, INSERT...), or "" */
function sqlOperation(q: string): string {
  const m = /^\s*(?:\/\*[\s\S]*?\*\/\s*)?([A-Za-z]+)/.exec(q);
  return m === null ? "" : m[1].toUpperCase();
}
/** the first table the statement names (FROM, INTO, UPDATE, JOIN), or "" */
function sqlTable(q: string): string {
  const m = /\b(?:from|into|update|join)\s+([A-Za-z0-9_."$]+)/i.exec(q);
  return m === null ? "" : m[1].replace(/"/g, "");
}
/** the route of a server span: http.route, or a "METHOD /pattern" resource (Nest's), or "" */
function routeOf(s: ApmSpan): string {
  const r = s.tags.get("http.route") ?? "";
  if (r.length > 0) return r;
  const m = /^[A-Z]+ (\/\S*)$/.exec(s.resource);
  return m === null ? "" : m[1];
}
function isDb(s: ApmSpan): boolean {
  return (s.tags.get("db.type") ?? "").length > 0;
}
/** The span's OpenTelemetry name: "GET /users/:id" for a server span, "GET" for an HTTP client, "SELECT orders" for SQL. */
export function otelName(s: ApmSpan): string {
  const method = s.tags.get("http.method") ?? "";
  if (s.kind === "server" && method.length > 0) {
    const route = routeOf(s);
    return route.length > 0 ? `${method} ${route}` : method;
  }
  if (s.kind === "client" && method.length > 0) return method;
  if (isDb(s)) {
    const sys = dbSystem(s.tags.get("db.type") ?? "");
    const q = s.resource;
    const op = sqlOperation(q);
    const table = sqlTable(q);
    if (sys === "redis" || sys === "mongodb") return q.length > 0 && q.length < 80 ? q : s.name;
    return op.length > 0 ? (table.length > 0 ? `${op} ${table}` : op) : s.name;
  }
  return s.name;
}
/** host and port of a URL ("" and 0 when it has none) */
function urlHostPort(u: string): [string, int] {
  const m = /^[a-z]+:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d+))?/i.exec(u);
  if (m === null) return ["", 0];
  const port = m[2] !== undefined && m[2] !== null && m[2].length > 0 ? Math.trunc(Number(m[2])) : u.startsWith("https") ? 443 : 80;
  return [m[1], port];
}
/** The OpenTelemetry attributes of a span (added to its own), as OTLP JSON attribute strings. */
function otelAttrs(s: ApmSpan): string[] {
  const out: string[] = [];
  const method = s.tags.get("http.method") ?? "";
  const status = Number(s.tags.get("http.status_code") ?? "0");
  if (method.length > 0) {
    out.push(attr("http.request.method", method));
    if (status > 0) out.push(attrNum("http.response.status_code", status));
    const url = s.tags.get("http.url") ?? "";
    if (s.kind === "server") {
      const route = routeOf(s);
      if (route.length > 0 && !s.tags.has("http.route")) out.push(attr("http.route", route));
      const pathOnly = url.replace(/^[a-z]+:\/\/[^/]*/i, "").replace(/[?#].*$/, "");
      if (pathOnly.length > 0) out.push(attr("url.path", pathOnly));
    } else if (s.kind === "client") {
      if (url.length > 0) out.push(attr("url.full", url));
      const hp = urlHostPort(url);
      const host = hp[0].length > 0 ? hp[0] : s.tags.get("out.host") ?? "";
      if (host.length > 0) out.push(attr("server.address", host));
      if (hp[1] > 0) out.push(attrNum("server.port", hp[1]));
    }
    if (status >= 500 || (s.kind === "client" && status >= 400)) out.push(attr("error.type", String(status)));
  }
  if (isDb(s)) {
    const sys = dbSystem(s.tags.get("db.type") ?? "");
    out.push(attr("db.system.name", sys));
    const q = s.resource;
    if (sys !== "redis" && sys !== "mongodb") {
      const op = sqlOperation(q);
      const table = sqlTable(q);
      if (q.length > 0) out.push(attr("db.query.text", q));
      if (op.length > 0) out.push(attr("db.operation.name", op));
      if (table.length > 0) out.push(attr("db.collection.name", table));
    } else if (q.length > 0) {
      const sp = q.indexOf(" ");
      const op = sp > 0 ? q.slice(0, sp) : q;
      out.push(attr("db.operation.name", op));
      if (sys === "mongodb" && sp > 0) {
        const ns = q.slice(sp + 1);
        const dot = ns.indexOf(".");
        if (dot > 0) out.push(attr("db.collection.name", ns.slice(dot + 1)));
      }
    }
    const host = s.tags.get("out.host") ?? "";
    if (host.length > 0) out.push(attr("server.address", host));
    const dbName = s.tags.get("db.name") ?? s.tags.get("db.instance") ?? "";
    if (dbName.length > 0) out.push(attr("db.namespace", dbName));
  }
  return out;
}

/** OTLP's SeverityNumber of a level label (TRACE 1, DEBUG 5, INFO 9, WARN 13, ERROR 17, FATAL 21; any other 0,
 * unspecified). */
function severityOf(label: string): int {
  const l = label.toLowerCase();
  return l === "trace" ? 1 : l === "debug" ? 5 : l === "info" ? 9 : l === "warn" || l === "warning" ? 13 : l === "error" ? 17 : l === "fatal" ? 21 : 0;
}

/** One histogram series of a metric: its attributes and its buckets for the current window (delta temporality). */
class ApmHist {
  attrs: string[];
  count: int = 0;
  sum: number = 0;
  min: number = 0;
  max: number = 0;
  buckets: int[];
  constructor(attrs: string[], n: int) {
    this.attrs = attrs;
    this.buckets = [];
    for (let i = 0; i <= n; i++) this.buckets.push(0);
  }
}
/** OpenTelemetry's default bounds for HTTP and database durations, in seconds */
const DURATION_BOUNDS: number[] = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

/**
 * The metrics an OTLP exporter derives from the spans it sends (http.server.request.duration,
 * http.client.request.duration, db.client.operation.duration) plus the agent's custom metrics, as OTLP delta
 * metrics: each send covers the window since the previous one.
 */
export class ApmOtlpMetrics {
  hists: Map<string, Map<string, ApmHist>> = new Map<string, Map<string, ApmHist>>();
  gauges: Map<string, number> = new Map<string, number>();
  counts: Map<string, number> = new Map<string, number>();
  windowStartNs: number = nowNs();

  private observe(metric: string, attrs: string[], seconds: number): void {
    let byKey = this.hists.get(metric);
    if (byKey === undefined || byKey === null) {
      byKey = new Map<string, ApmHist>();
      this.hists.set(metric, byKey);
    }
    const key = attrs.join("|");
    let h = byKey.get(key);
    if (h === undefined || h === null) {
      h = new ApmHist(attrs, DURATION_BOUNDS.length);
      byKey.set(key, h);
    }
    let i = 0;
    while (i < DURATION_BOUNDS.length && seconds > DURATION_BOUNDS[i]) i++;
    h.buckets[i] = h.buckets[i] + 1;
    if (h.count === 0 || seconds < h.min) h.min = seconds;
    if (h.count === 0 || seconds > h.max) h.max = seconds;
    h.count = h.count + 1;
    h.sum = h.sum + seconds;
  }
  /** Adds a finished span to the window's metrics. */
  record(s: ApmSpan): void {
    const secs = s.durationNs / 1e9;
    const method = s.tags.get("http.method") ?? "";
    const status = Number(s.tags.get("http.status_code") ?? "0");
    if (method.length > 0 && (s.kind === "server" || s.kind === "client")) {
      const a: string[] = [attr("http.request.method", method)];
      if (status > 0) a.push(attrNum("http.response.status_code", status));
      if (s.kind === "server") {
        const route = routeOf(s);
        if (route.length > 0) a.push(attr("http.route", route));
        if (status >= 500 || (s.error && s.errorMessage.length > 0)) a.push(attr("error.type", status >= 500 ? String(status) : s.errorType.length > 0 ? s.errorType : "_OTHER"));
        this.observe("http.server.request.duration", a, secs);
      } else {
        const hp = urlHostPort(s.tags.get("http.url") ?? "");
        const host = hp[0].length > 0 ? hp[0] : s.tags.get("out.host") ?? "";
        if (host.length > 0) a.push(attr("server.address", host));
        if (hp[1] > 0) a.push(attrNum("server.port", hp[1]));
        if (status >= 400) a.push(attr("error.type", String(status)));
        this.observe("http.client.request.duration", a, secs);
      }
      return;
    }
    if (isDb(s)) {
      const sys = dbSystem(s.tags.get("db.type") ?? "");
      const a: string[] = [attr("db.system.name", sys)];
      const q = s.resource;
      const op = sys === "redis" || sys === "mongodb" ? (q.indexOf(" ") > 0 ? q.slice(0, q.indexOf(" ")) : q) : sqlOperation(q);
      const table = sys === "redis" ? "" : sys === "mongodb" ? (q.indexOf(".") > 0 ? q.slice(q.indexOf(".") + 1) : "") : sqlTable(q);
      if (op.length > 0) {
        a.push(attr("db.operation.name", op));
      }
      if (table.length > 0) {
        a.push(attr("db.collection.name", table));
      }
      const host = s.tags.get("out.host") ?? "";
      if (host.length > 0) a.push(attr("server.address", host));
      if (s.error) a.push(attr("error.type", s.errorType.length > 0 ? s.errorType : "_OTHER"));
      this.observe("db.client.operation.duration", a, secs);
    }
  }
  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }
  count(name: string, n: number): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + n);
  }
  /** The OTLP metrics body for the window, and a new window; "" when there is nothing to send. */
  take(resource: string): string {
    const end = nowNs();
    const startText = nsText(this.windowStartNs);
    const endText = nsText(end);
    const metrics: string[] = [];
    for (const name of this.hists.keys()) {
      const byKey = this.hists.get(name) ?? new Map<string, ApmHist>();
      const pts: string[] = [];
      for (const h of byKey.values()) {
        const b: string[] = [];
        for (const c of h.buckets) b.push(`"${c}"`);
        pts.push(
          `{"attributes":[${h.attrs.join(",")}],"startTimeUnixNano":"${startText}","timeUnixNano":"${endText}","count":"${h.count}",` +
            `"sum":${h.sum},"min":${h.min},"max":${h.max},"bucketCounts":[${b.join(",")}],"explicitBounds":[${DURATION_BOUNDS.join(",")}]}`,
        );
      }
      if (pts.length > 0) metrics.push(`{"name":${JSON.stringify(name)},"unit":"s","histogram":{"aggregationTemporality":1,"dataPoints":[${pts.join(",")}]}}`);
    }
    for (const name of this.gauges.keys()) {
      metrics.push(`{"name":${JSON.stringify(name)},"gauge":{"dataPoints":[{"timeUnixNano":"${endText}","asDouble":${this.gauges.get(name) ?? 0}}]}}`);
    }
    for (const name of this.counts.keys()) {
      metrics.push(
        `{"name":${JSON.stringify(name)},"sum":{"aggregationTemporality":1,"isMonotonic":true,"dataPoints":[{"startTimeUnixNano":"${startText}","timeUnixNano":"${endText}","asDouble":${this.counts.get(name) ?? 0}}]}}`,
      );
    }
    this.hists = new Map<string, Map<string, ApmHist>>();
    this.gauges = new Map<string, number>();
    this.counts = new Map<string, number>();
    this.windowStartNs = end;
    if (metrics.length === 0) return "";
    return `{"resourceMetrics":[{"resource":{"attributes":[${resource}]},"scopeMetrics":[{"scope":{"name":"xisto-apm","version":"0.1.0"},"metrics":[${metrics.join(",")}]}]}]}`;
  }
}

/**
 * A sampler that keeps at most `spansPerMinute` spans a minute (whole traces; a trace with an error is always kept,
 * up to twice that), as New Relic's agent keeps 2000 span events a minute (span_events.max_samples_stored): the
 * metrics still count every request, so the throughput and response times stay exact.
 */
export function spanBudgetSampler(spansPerMinute: int): (spans: ApmSpan[]) => boolean {
  let windowStart = 0;
  let used = 0;
  let usedErrors = 0;
  return (spans: ApmSpan[]): boolean => {
    const now = Math.trunc(Date.now() / 60000);
    if (now !== windowStart) {
      windowStart = now;
      used = 0;
      usedErrors = 0;
    }
    let err = false;
    for (const s of spans) if (s.error) err = true;
    if (used + spans.length <= spansPerMinute) {
      used += spans.length;
      return true;
    }
    if (err && usedErrors + spans.length <= spansPerMinute) {
      usedErrors += spans.length;
      return true;
    }
    return false;
  };
}

/** Sends traces as OTLP/HTTP JSON to url (…/v1/traces) with these headers (the backend's key). */
export class ApmOtlpExporter implements ApmExporter {
  url: string;
  headers: Map<string, string>;
  /** resource attributes added to service.name & co (the backend's own, e.g. Dynatrace's dt.entity.*) */
  resourceAttrs: Map<string, string> = new Map<string, string>();
  /** metrics derived from the spans and the agent's custom metrics, sent to …/v1/metrics (null: traces only) */
  metrics: ApmOtlpMetrics | null = null;
  /** HTTP statuses the collector already refused with (each is reported once on stderr) */
  private refused: Map<string, boolean> = new Map<string, boolean>();
  constructor(url: string, headers: Map<string, string>) {
    this.url = url;
    this.headers = headers;
  }
  /** Turns on the metrics: http.server/client.request.duration, db.client.operation.duration and custom ones. */
  withMetrics(): ApmOtlpMetrics {
    if (this.metrics === null) {
      const m = new ApmOtlpMetrics();
      this.metrics = m;
      // every finished trace counts, also the ones a sampler leaves out
      Apm.observer = (spans: ApmSpan[]): void => {
        for (const s of spans) m.record(s);
      };
    }
    return this.metrics as ApmOtlpMetrics;
  }
  private resourceJson(): string {
    const info = Apm.info;
    const res: string[] = [attr("service.name", info.service), attr("telemetry.sdk.name", "xisto-apm"), attr("telemetry.sdk.language", "nodejs")];
    if (info.version.length > 0) res.push(attr("service.version", info.version));
    if (info.env.length > 0) res.push(attr("deployment.environment", info.env));
    if (info.env.length > 0) res.push(attr("deployment.environment.name", info.env));
    if (info.hostname.length > 0) res.push(attr("host.name", info.hostname));
    for (const k of this.resourceAttrs.keys()) res.push(attr(k, this.resourceAttrs.get(k) ?? ""));
    return res.join(",");
  }
  /** The OTLP request body of these traces. */
  body(traces: ApmSpan[][]): string {
    const info = Apm.info;
    const spans: string[] = [];
    for (const t of traces) {
      for (const s of t) {
        const attrs: string[] = [];
        for (const k of info.tags.keys()) attrs.push(attr(k, info.tags.get(k) ?? ""));
        for (const k of s.tags.keys()) attrs.push(attr(k, s.tags.get(k) ?? ""));
        for (const k of s.nums.keys()) attrs.push(attrNum(k, s.nums.get(k) ?? 0));
        if (s.resource.length > 0 && s.resource !== s.name) attrs.push(attr("resource.name", s.resource));
        if (s.parent === null) for (const k of s.trace.user.keys()) attrs.push(attr(`enduser.${k}`, s.trace.user.get(k) ?? ""));
        for (const a of otelAttrs(s)) attrs.push(a);
        const events: string[] = [];
        // OTLP's status follows OpenTelemetry's HTTP conventions: a client span is an error for any 4xx or 5xx answer
        // (dd-trace's own rule, kept by the Datadog exporter, counts only the 4xx on the client side)
        const httpStatus = Number(s.tags.get("http.status_code") ?? "0");
        const clientError = s.kind === "client" && httpStatus >= 400;
        // an exception event only for a real error (an Error or noticeError), never an empty one for a status code
        if (s.error && (s.errorType.length > 0 || s.errorMessage.length > 0)) {
          const ea = [attr("exception.type", s.errorType), attr("exception.message", s.errorMessage)];
          if (s.errorStack.length > 0) ea.push(attr("exception.stacktrace", s.errorStack));
          events.push(`{"timeUnixNano":"${nsText(s.startNs + s.durationNs)}","name":"exception","attributes":[${ea.join(",")}]}`);
        }
        const parent = s.parentId.length > 0 ? `,"parentSpanId":"${s.parentId}"` : "";
        const isError = s.error || clientError;
        const statusMessage = s.errorMessage.length > 0 ? s.errorMessage : clientError ? `HTTP ${httpStatus}` : "";
        const status = isError ? `{"code":2,"message":${JSON.stringify(statusMessage)}}` : `{"code":0}`;
        spans.push(
          `{"traceId":"${s.traceIdHex()}","spanId":"${s.spanIdHex()}"${parent},"name":${JSON.stringify(otelName(s))},"kind":${otlpKind(s.kind)},` +
            `"startTimeUnixNano":"${nsText(s.startNs)}","endTimeUnixNano":"${nsText(s.startNs + s.durationNs)}","attributes":[${attrs.join(",")}],` +
            `"events":[${events.join(",")}],"status":${status}}`,
        );
      }
    }
    return `{"resourceSpans":[{"resource":{"attributes":[${this.resourceJson()}]},"scopeSpans":[{"scope":{"name":"xisto-apm","version":"0.1.0"},"spans":[${spans.join(",")}]}]}]}`;
  }
  /** The OTLP logs request body of these lines: each LogRecord with its time, severity (pino's level), body, the
   * active span's traceId and spanId, and the line's fields as attributes. */
  logsBody(logs: ApmLogRecord[]): string {
    const recs: string[] = [];
    for (const r of logs) {
      const t = nsText(r.timeNs);
      const ids = r.traceId.length > 0 ? `,"traceId":"${r.traceId}","spanId":"${r.spanId}"` : "";
      recs.push(
        `{"timeUnixNano":"${t}","observedTimeUnixNano":"${t}","severityNumber":${severityOf(r.level)},"severityText":${JSON.stringify(r.level)},` +
          `"body":{"stringValue":${JSON.stringify(r.message)}},"attributes":[${r.attrs.join(",")}]${ids}}`,
      );
    }
    return `{"resourceLogs":[{"resource":{"attributes":[${this.resourceJson()}]},"scopeLogs":[{"scope":{"name":"xisto-apm","version":"0.1.0"},"logRecords":[${recs.join(",")}]}]}]}`;
  }
  async send(traces: ApmSpan[][]): Promise<void> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    for (const k of this.headers.keys()) h[k] = this.headers.get(k) ?? "";
    // traces, then metrics, within one request's limit together: a collector that hangs holds the program's exit no
    // longer than with traces alone (the metrics get what is left of it; with nothing left this window is lost)
    const limit = Apm.timeoutMs();
    const t0 = Date.now();
    if (traces.length > 0) await this.post(this.url, h, this.body(traces), limit);
    const logs = ApmLogs.take();
    if (logs.length > 0) {
      const left = limit - (Date.now() - t0);
      if (left >= 50) await this.post(this.url.replace(/\/v1\/traces$/, "/v1/logs"), h, this.logsBody(logs), Math.trunc(left));
    }
    const m = this.metrics;
    if (m !== null) {
      const mb = (m as ApmOtlpMetrics).take(this.resourceJson());
      const left = limit - (Date.now() - t0);
      if (mb.length > 0 && left >= 50) await this.post(this.url.replace(/\/v1\/traces$/, "/v1/metrics"), h, mb, Math.trunc(left));
    }
  }
  private async post(url: string, h: Record<string, string>, body: string, limitMs: int): Promise<void> {
    try {
      Apm.skipNextFetch();
      const r = await fetch(url, { method: "POST", headers: h, body: body, signal: AbortSignal.timeout(limitMs) });
      if (!r.ok) {
        // a refused key or payload says so once (the agents write it to their log); the program goes on
        const k = String(r.status);
        if (!this.refused.has(k)) {
          this.refused.set(k, true);
          const why = r.status === 401 || r.status === 403 ? ": check the license/API key" : "";
          console.error(`xisto-apm: ${url.replace(/^([a-z]+:\/\/[^/]*).*$/, "$1")} refused the data (HTTP ${r.status})${why}`);
        }
      }
    } catch (err) {
      // (a collector that is down loses this batch, as the agents do; the program goes on)
    }
  }
}

// ---- HTTP through node:diagnostics_channel (the compiler's node:http and fetch publish to Node's channels) ----
// fetch: an http.request client span (component fetch), the trace headers added to the request; node:http's client:
// the same (component http); node:http's server (http.createServer, not Nest, which instruments itself): a web.request
// server span, active during the handler, its parent from the request's headers. As dd-trace: a client span fails on
// 4xx, a server span on 5xx.

let httpHooked = false;

function clientSpan(component: string, method: string, url: string, host: string): ApmSpan | null {
  const o = new ApmSpanOptions();
  o.kind = "client";
  o.type = "http";
  o.component = component;
  o.resource = method;
  const s = startSpan("http.request", o);
  if (s === null) return null;
  s.setText("http.method", method);
  s.setText("http.url", url);
  s.setText("out.host", host);
  return s;
}
function endClient(s: ApmSpan | null, status: int, err: Error | null): void {
  if (s === null) return;
  if (err !== null) s.setError(err);
  else {
    s.setText("http.status_code", String(status));
    if (status >= 400 && status < 500) s.error = true;
  }
  s.finish();
}

function instrumentHttp(): void {
  if (httpHooked) return;
  httpHooked = true;
  dc.subscribe("undici:request:create", (msg: any): void => {
    if (Apm.untracedNext) {
      Apm.untracedNext = false;
      return;
    }
    const req = msg.request;
    const origin: string = req.origin;
    const path: string = req.path;
    const method: string = req.method;
    const hostPort = origin.replace("http://", "").replace("https://", "").split(":");
    const host = hostPort[0];
    const s = clientSpan("fetch", method, origin + path.split("?")[0], host);
    if (s === null) return;
    const port = hostPort.length > 1 ? Number(hostPort[1]) : origin.startsWith("https:") ? 443 : 80;
    s.setNumber("network.destination.port", port);
    const h = new Map<string, string>();
    inject(s, h);
    for (const k of h.keys()) req.addHeader(k, h.get(k) ?? "");
    req.context = s;
  });
  dc.subscribe("undici:request:headers", (msg: any): void => {
    const sp: any = msg.request.context;
    if (sp === null) return;
    endClient(sp as ApmSpan, Math.trunc(msg.response.statusCode as number), null);
  });
  dc.subscribe("undici:request:error", (msg: any): void => {
    const sp: any = msg.request.context;
    if (sp === null) return;
    endClient(sp as ApmSpan, 0, msg.error as Error);
  });
  dc.subscribe("http.client.request.start", (msg: any): void => {
    const req = msg.request;
    const method: string = req.method;
    const host: string = req.host;
    const path: string = req.path;
    const protocol: string = req.protocol;
    const port: string = req.port;
    const s = clientSpan("http", method, `${protocol}//${host}${port.length > 0 ? ":" + port : ""}${path.split("?")[0]}`, host);
    if (s === null) return;
    s.setNumber("network.destination.port", port.length > 0 ? Number(port) : protocol === "https:" ? 443 : 80);
    const h = new Map<string, string>();
    inject(s, h);
    for (const k of h.keys()) req.setHeader(k, h.get(k) ?? "");
    req._diag = s;
  });
  dc.subscribe("http.client.response.finish", (msg: any): void => {
    const sp: any = msg.request._diag;
    if (sp === null) return;
    endClient(sp as ApmSpan, Math.trunc(msg.response.statusCode as number), null);
  });
  dc.subscribe("http.client.request.error", (msg: any): void => {
    const sp: any = msg.request._diag;
    if (sp === null) return;
    endClient(sp as ApmSpan, 0, msg.error as Error);
  });
  dc.subscribe("http.server.request.start", (msg: any): void => {
    const req = msg.request;
    const headers = req.headers as Record<string, string>;
    const h = new Map<string, string>();
    for (const k of Object.keys(headers)) h.set(k.toLowerCase(), headers[k] ?? "");
    const o = new ApmSpanOptions();
    o.kind = "server";
    o.type = "web";
    o.component = "http";
    o.root = true;
    const parent = extract(h);
    if (parent !== null) {
      o.root = false;
      o.remote = parent;
    }
    const method: string = req.method;
    const url: string = req.url;
    o.resource = method;
    const s = startSpan("web.request", o);
    if (s === null) return;
    s.setText("http.method", method);
    s.setText("http.url", `http://${h.get("host") ?? "localhost"}${url}`);
    const ua = h.get("user-agent");
    if (ua !== null) s.setText("http.useragent", ua);
    req._diag = s;
    enterSpan(s); // (the handler runs in this request's task: its spans are children of this one)
  });
  dc.subscribe("http.server.response.finish", (msg: any): void => {
    const sp: any = msg.request._diag;
    if (sp === null) return;
    const s = sp as ApmSpan;
    const status = Math.trunc(msg.response.statusCode as number);
    s.setText("http.status_code", String(status));
    if (status >= 500) s.error = true;
    s.finish();
  });
}
