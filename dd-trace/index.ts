// dd-trace (Datadog's tracer) for xisto: the tracer API on xisto-apm's core, sending traces to the Datadog Agent
// (PUT /v0.4/traces, JSON) as dd-trace 5 does (it sends msgpack; the Agent takes both). The spans carry the tags
// dd-trace puts (env, version, language, runtime-id, process_id, _dd.p.tid, _dd.p.dm, _sampling_priority_v1,
// _dd.top_level, _dd.measured, usr.*), so the Datadog UI shows them as from dd-trace.
// The packages that dd-trace instruments on Node (express/Nest requests, pg, oracledb, mongodb, redis, ioredis,
// elasticsearch, pino logs) are instrumented by those packages themselves (xisto-apm hooks): nothing is patched.
// Configuration: init(options) and the DD_* variables (DD_SERVICE, DD_ENV, DD_VERSION, DD_AGENT_HOST,
// DD_TRACE_AGENT_PORT, DD_TRACE_AGENT_URL, DD_TRACE_ENABLED, DD_TRACE_SAMPLE_RATE, DD_TAGS).
// Differences from dd-trace: tracing starts at init() (Node: also through --require dd-trace/init); use() accepts a
// plugin name and options and does nothing (every integration is on); runtime metrics, profiling, AppSec, remote
// configuration and telemetry are not sent; the payload is JSON, not msgpack; the default service is the program's
// name (Node: package.json's name).
import { newSpan, extractParent, injectHeaders } from "xisto-apm";
import { Apm, ApmSpan, ApmServiceInfo, ApmExporter, ApmTrace, ApmSpanOptions, ApmParent, finishWith, runIn, activeSpan, localRoot, hostName, nsText, newId, hexToDdId } from "xisto-apm";


/** The options of init(). */
export interface TracerOptions {
  service?: string;
  env?: string;
  version?: string;
  hostname?: string;
  port?: number;
  url?: string;
  flushInterval?: number;
  sampleRate?: number;
  logInjection?: boolean;
  runtimeMetrics?: boolean;
  profiling?: boolean;
  startupLogs?: boolean;
  plugins?: boolean;
  enabled?: boolean;
  tags?: Record<string, string>;
}

/** The options of startSpan(). */
export interface StartSpanOptions {
  childOf?: Span | SpanContext | null;
  tags?: Record<string, any>;
  startTime?: number;
}

/** The options of trace() and wrap(). */
export interface TraceOptions {
  resource?: string;
  type?: string;
  service?: string;
  tags?: Record<string, any>;
  childOf?: Span | SpanContext | null;
}

/** A user, for setUser(). */
export interface User {
  id: string;
  name?: string;
  email?: string;
  role?: string;
  scope?: string;
}

/** A span's ids: Datadog's decimal trace and span ids. */
export class SpanContext {
  core: ApmSpan | null;
  constructor(core: ApmSpan | null) {
    this.core = core;
  }
  /** The trace id, decimal (its low 64 bits), "0" when tracing is off. */
  toTraceId(): string {
    const c = this.core;
    return c === null ? "0" : c.ddTraceId();
  }
  toSpanId(): string {
    const c = this.core;
    return c === null ? "0" : c.ddSpanId();
  }
  /** The W3C traceparent of this span. */
  toTraceparent(): string {
    const c = this.core;
    if (c === null) return "00-00000000000000000000000000000000-0000000000000000-00";
    return `00-${c.traceIdHex()}-${c.spanIdHex()}-${c.trace.priority > 0 ? "01" : "00"}`;
  }
}

/** A span: tags, finish() and its context. With tracing off (no init()), it records nothing. */
export class Span {
  core: ApmSpan | null;
  constructor(core: ApmSpan | null) {
    this.core = core;
  }
  /** A tag; an Error (or true for "error") marks the span failed; numbers are kept as numbers. */
  setTag(key: string, value: any): Span {
    const c = this.core;
    if (c === null) return this;
    if (key === "resource.name") c.resource = String(value);
    else if (key === "service.name") c.service = String(value);
    else if (key === "span.type") c.type = String(value);
    else c.setTag(key, value);
    return this;
  }
  addTags(tags: Record<string, any>): Span {
    for (const k of Object.keys(tags)) this.setTag(k, tags[k]);
    return this;
  }
  /** Ends the span (now, or at a time in milliseconds since the epoch). */
  finish(finishTime: number = -1): void {
    const c = this.core;
    if (c !== null) c.finish(finishTime);
  }
  context(): SpanContext {
    return new SpanContext(this.core);
  }
}

/** The facade object of a core span (made once). */
function wrapSpan(core: ApmSpan | null): Span | null {
  if (core === null) return null;
  if (core.facade === null) core.facade = new Span(core);
  return core.facade as Span;
}

/** The active span (scope().active()), activate(span, fn) and bind(fn, span). */
export class Scope {
  /** The span of the current asynchronous flow, or null. */
  active(): Span | null {
    return wrapSpan(activeSpan());
  }
  /** Runs fn with span active; its value returned. */
  activate(span: Span | null, fn: () => any): any {
    return runIn(span === null ? null : span.core, fn);
  }
  /** fn, made to run with span (by default the active one) active whenever it is called. */
  bind(fn: (...args: any[]) => any, span: Span | null = null): (...args: any[]) => any {
    const s = span === null ? activeSpan() : span.core;
    return (...args: any[]): any => runIn(s, (): any => fn(...args));
  }
}

const theScope = new Scope();

function parentOf(childOf: Span | SpanContext | null): ApmSpan | null {
  if (childOf === null) return null;
  if (childOf instanceof Span) return (childOf as Span).core;
  return (childOf as SpanContext).core;
}

function envOr(name: string, dflt: string): string {
  const v = process.env[name];
  return v !== null && v.length > 0 ? v : dflt;
}

/** dd-trace's own exporter: the Datadog Agent's v0.4 traces endpoint. */
export class AgentExporter implements ApmExporter {
  url: string;
  pid: int;
  rid: string;
  constructor(url: string) {
    this.url = url;
    this.pid = process.pid;
    const a = newId();
    const b = newId();
    this.rid = `${a.slice(0, 8)}-${a.slice(8, 12)}-4${a.slice(13, 16)}-a${b.slice(1, 4)}-${b.slice(4, 16)}`; // (a v4 uuid)
  }
  /** The service a span is shown under: dd-trace 5's (schema v0) integrations of databases and caches have one of
   * their own, the program's service with the system's name ("shop-postgres"). */
  serviceOf(s: ApmSpan): string {
    const info = Apm.info;
    if (s.service !== info.service) return s.service;
    const suffix = s.component === "pg" ? "-postgres" : s.component === "oracledb" ? "-oracle" : s.component === "mongodb" ? "-mongodb"
      : s.component === "redis" || s.component === "ioredis" ? "-redis" : s.component === "elasticsearch" ? "-elasticsearch" : "";
    return s.service + suffix;
  }
  /** The JSON of one span, with the tags dd-trace adds. */
  span(s: ApmSpan, first: boolean): string {
    const info = Apm.info;
    const service = this.serviceOf(s);
    const meta = new Map<string, string>();
    const metrics = new Map<string, number>();
    if (s.component.length === 0) meta.set("_dd.integration", "opentracing");
    else {
      meta.set("_dd.integration", s.component);
      meta.set("component", s.component);
    }
    if (info.env.length > 0) meta.set("env", info.env);
    if (info.version.length > 0) meta.set("version", info.version);
    meta.set("language", "javascript");
    meta.set("runtime-id", this.rid);
    meta.set("service", s.service);
    if (service !== s.service) { /* (an integration's own service: dd-trace says where it comes from) */
      meta.set("_dd.base_service", s.service);
      meta.set("_dd.svc_src", service.slice(s.service.length + 1));
    }
    for (const k of info.tags.keys()) meta.set(k, info.tags.get(k) ?? "");
    if (s.kind !== "internal") meta.set("span.kind", s.kind); // (dd-trace tags every span but internal ones)
    for (const k of s.tags.keys()) meta.set(k, s.tags.get(k) ?? "");
    if (s.error) {
      meta.set("error.message", s.errorMessage);
      meta.set("error.type", s.errorType);
      if (s.errorStack.length > 0) meta.set("error.stack", s.errorStack);
    }
    for (const k of s.nums.keys()) metrics.set(k, s.nums.get(k) ?? 0);
    metrics.set("process_id", this.pid);
    metrics.set("_sampling_priority_v1", s.trace.priority);
    if (s.measured || s.component.length > 0) metrics.set("_dd.measured", 1);
    if (s.parent === null) metrics.set("_dd.top_level", 1); // (dd-trace 5 marks the local root only)
    if (first) {
      meta.set("_dd.p.dm", "-0");
      if (s.trace.hi !== "0000000000000000") meta.set("_dd.p.tid", s.trace.hi);
      meta.set("_dd.sdk.otlp_export", "false");
      metrics.set("_dd.agent_psr", 1);
      if (s.trace.user.size > 0) {
        meta.set("_dd.appsec.user.collection_mode", "sdk");
        for (const k of s.trace.user.keys()) meta.set(`usr.${k}`, s.trace.user.get(k) ?? "");
      }
    }
    const m: string[] = [];
    for (const k of meta.keys()) m.push(`${JSON.stringify(k)}:${JSON.stringify(meta.get(k) ?? "")}`);
    const n: string[] = [];
    for (const k of metrics.keys()) n.push(`${JSON.stringify(k)}:${metrics.get(k) ?? 0}`);
    const type = s.type.length > 0 ? `,"type":${JSON.stringify(s.type)}` : "";
    const parentId = s.parentId.length > 0 ? s.parentId : "0000000000000000";
    return (
      `{"trace_id":${s.ddTraceId()},"span_id":${s.ddSpanId()},"parent_id":${hexToDdId(parentId)},"name":${JSON.stringify(s.name)},` +
      `"resource":${JSON.stringify(s.resource)},"service":${JSON.stringify(service)}${type},"start":${nsText(s.startNs)},` +
      `"duration":${nsText(s.durationNs)},"error":${s.error ? 1 : 0},"meta":{${m.join(",")}},"metrics":{${n.join(",")}}}`
    );
  }
  async send(traces: ApmSpan[][]): Promise<void> {
    const parts: string[] = [];
    for (const t of traces) {
      const spans: string[] = [];
      for (let i = 0; i < t.length; i++) spans.push(this.span(t[i], i === 0));
      parts.push(`[${spans.join(",")}]`);
    }
    const body = `[${parts.join(",")}]`;
    try {
      await fetch("http://" + this.url.slice(7), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Datadog-Meta-Lang": "nodejs",
          "Datadog-Meta-Tracer-Version": "5.131.1",
          "X-Datadog-Trace-Count": String(traces.length),
        },
        body: body,
      });
    } catch (err) {
      // (an Agent that is not there loses the batch, as dd-trace does)
    }
  }
}

let started = false;

/** Starts tracing (once; later calls change nothing) and gives the tracer. */
export function init(options: TracerOptions = {}): Tracer {
  if (started) return tracer;
  started = true;
  const enabledEnv = envOr("DD_TRACE_ENABLED", "true");
  if (options.enabled === false || enabledEnv === "false" || enabledEnv === "0") return tracer;
  const info = new ApmServiceInfo();
  const argv0 = process.argv.length > 1 ? process.argv[1] : "node";
  const slash = argv0.lastIndexOf("/");
  info.service = options.service ?? envOr("DD_SERVICE", slash >= 0 ? argv0.slice(slash + 1) : argv0);
  info.env = options.env ?? envOr("DD_ENV", "");
  info.version = options.version ?? envOr("DD_VERSION", "");
  info.hostname = hostName();
  info.sampleRate = options.sampleRate ?? Number(envOr("DD_TRACE_SAMPLE_RATE", "1"));
  const ddTags = envOr("DD_TAGS", "");
  for (const kv of ddTags.split(/[ ,]/)) {
    const i = kv.indexOf(":");
    if (i > 0) info.tags.set(kv.slice(0, i), kv.slice(i + 1));
  }
  const tags = options.tags;
  if (tags !== null) for (const k of Object.keys(tags)) info.tags.set(k, tags[k] ?? "");
  const host = options.hostname ?? envOr("DD_AGENT_HOST", "127.0.0.1");
  const port = options.port ?? Number(envOr("DD_TRACE_AGENT_PORT", "8126"));
  let url = options.url ?? envOr("DD_TRACE_AGENT_URL", `http://${host}:${port}`);
  if (url.endsWith("/")) url = url.slice(0, url.length - 1);
  if (options.flushInterval !== null) Apm.setFlushInterval(Math.trunc(options.flushInterval as number));
  Apm.start(info, new AgentExporter(url + "/v0.4/traces"));
  return tracer;
}

/** use(plugin, options): every integration is on in xisto (they are in the packages); accepted. */
export function use(plugin: string, options: any = null): Tracer {
  return tracer;
}

/** A span, child of options.childOf (by default the active span). Not active: activate() makes it so. */
export function startSpan(name: string, opts: StartSpanOptions | null = null): Span {
  const options: StartSpanOptions = opts ?? {};
  const o = new ApmSpanOptions();
  const childOf = options.childOf ?? null;
  if (childOf !== null) {
    o.childOf = parentOf(childOf);
    if (o.childOf === null) o.root = true;
  }
  const core = newSpan(name, o);
  const span = wrapSpan(core) ?? new Span(null);
  const tags = options.tags;
  if (tags !== null) span.addTags(tags);
  return span;
}

function traceOptions(name: string, options: TraceOptions): ApmSpanOptions {
  const o = new ApmSpanOptions();
  o.resource = options.resource ?? name;
  o.type = options.type ?? "";
  o.service = options.service ?? "";
  o.measured = true;
  const childOf = options.childOf ?? null;
  if (childOf !== null) o.childOf = parentOf(childOf);
  return o;
}

/** Runs fn in a new active span that ends when fn returns or throws, or when the promise it returns settles. */
export function trace(name: string, options: TraceOptions, fn: (span: Span) => any): any {
  const core = newSpan(name, traceOptions(name, options));
  if (core === null) return fn(new Span(null));
  const span = wrapSpan(core) as Span;
  const tags = options.tags;
  if (tags !== null) span.addTags(tags);
  try {
    const v: any = runIn(core, (): any => fn(span));
    return finishWith(core, v);
  } catch (err) {
    core.setError(err as Error);
    core.finish();
    throw err;
  }
}

/** fn, made to run in a new span each time it is called (named name, ended as trace() ends its span). */
export function wrap(name: string, fn: (...args: any[]) => any): (...args: any[]) => any {
  return (...args: any[]): any => trace(name, {}, (span: Span): any => fn(...args));
}

/** The user of the current trace (usr.* tags on its root span). */
export function setUser(user: User): Tracer {
  const s = activeSpan();
  if (s === null) return tracer;
  const u = s.trace.user;
  u.set("id", user.id);
  if (user.name !== null) u.set("name", user.name as string);
  if (user.email !== null) u.set("email", user.email as string);
  if (user.role !== null) u.set("role", user.role as string);
  if (user.scope !== null) u.set("scope", user.scope as string);
  return tracer;
}

export function scope(): Scope {
  return theScope;
}

/** inject(span, "http_headers", carrier): the headers that carry the span to a service it calls. */
export function inject(span: Span | SpanContext, format: string, carrier: Record<string, string>): void {
  const core = parentOf(span);
  if (core === null) return;
  const h = new Map<string, string>();
  injectHeaders(core, h);
  for (const k of h.keys()) carrier[k] = h.get(k) ?? "";
}

/** extract("http_headers", carrier): the context an incoming request carries, or null. */
export function extract(format: string, carrier: Record<string, string>): SpanContext | null {
  const h = new Map<string, string>();
  for (const k of Object.keys(carrier)) h.set(k.toLowerCase(), carrier[k] ?? "");
  const p: ApmParent | null = extractParent(h);
  if (p === null) return null;
  // (a span that stands for the remote parent: startSpan(name, { childOf: extract(...) }) continues its trace)
  const t = new ApmTrace(p.traceHi, p.traceLo);
  t.priority = p.priority;
  const ghost = new ApmSpan(t, p.spanId, "", null, "");
  return new SpanContext(ghost);
}

/** The tracer: the same functions, for import tracer from "dd-trace" and require("dd-trace").init(). */
export class Tracer {
  init(options: TracerOptions = {}): Tracer {
    return init(options);
  }
  use(plugin: string, options: any = null): Tracer {
    return tracer;
  }
  startSpan(name: string, options: StartSpanOptions | null = null): Span {
    return startSpan(name, options);
  }
  trace(name: string, options: TraceOptions, fn: (span: Span) => any): any {
    return trace(name, options, fn);
  }
  wrap(name: string, fn: (...args: any[]) => any): (...args: any[]) => any {
    return wrap(name, fn);
  }
  setUser(user: User): Tracer {
    return setUser(user);
  }
  scope(): Scope {
    return theScope;
  }
  inject(span: Span | SpanContext, format: string, carrier: Record<string, string>): void {
    inject(span, format, carrier);
  }
  extract(format: string, carrier: Record<string, string>): SpanContext | null {
    return extract(format, carrier);
  }
}

const tracer: Tracer = new Tracer();
export default tracer;
