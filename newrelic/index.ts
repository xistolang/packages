// newrelic for xisto: the New Relic Node agent's API (newrelic ^12 / ^14) on the xisto-apm core. The agent's own
// protocol to New Relic's collector is closed, so the traces go to New Relic's OpenTelemetry entry instead:
// OTLP/HTTP JSON to https://otlp.nr-data.net:4318/v1/traces (EU accounts, license key starting with "eu" or an
// eu01 NEW_RELIC_HOST: otlp.eu01.nr-data.net; FedRAMP, a "gov" NEW_RELIC_HOST: gov-otlp.nr-data.net), with the
// header "api-key: <license key>".
//
// Model (New Relic's OTLP conventions): a transaction is a root span (startWebTransaction: kind server, attribute
// url.path; startBackgroundTransaction: kind internal, attribute transaction.group), a segment is a child span
// (internal); custom attributes are span attributes (addCustomAttribute(s) on the transaction's span,
// addCustomSpanAttribute(s) on the current one); noticeError marks the current span failed (status ERROR and an
// "exception" event, from which New Relic counts errors) and adds its custom attributes to that span. The resource
// carries service.name (the first NEW_RELIC_APP_NAME) and host.name.
//
// Configuration: NEW_RELIC_LICENSE_KEY (without one the agent does not start, as the real one), NEW_RELIC_APP_NAME
// (";"-separated, the first is used), NEW_RELIC_ENABLED, NEW_RELIC_HOST (picks the region, see above),
// NEW_RELIC_LABELS ("k:v;k2:v2", attributes of every span) and, xisto's own, NEW_RELIC_OTLP_URL (the whole OTLP
// traces URL, e.g. a local OpenTelemetry Collector).
//
// Differences from the npm package:
// - Starting: the real agent starts when the module is first required. Here it starts when this module is
//   initialized (an import that binds a name, `import newrelic from "newrelic"`) or, at the latest, on the first
//   call of its API; `start()` (xisto's) starts it explicitly. A bare `import "newrelic"` does not run module code
//   in xisto, so it starts nothing by itself.
// - The newrelic.js config file is not read (only the NEW_RELIC_* variables above).
// - No automatic instrumentation by patching modules: the ported packages call xisto-apm's hooks.
// - Transaction names are the span names as given (url, setTransactionName's name, "controller/action"); New
//   Relic's "WebTransaction/..." and "OtherTransaction/..." prefixes are New Relic's own naming of OTLP spans.
// - insertDistributedTraceHeaders writes traceparent only (as the agent before it has connected: no tracestate
//   nor "newrelic" header, which need the account's trusted key); acceptDistributedTraceHeaders reads traceparent
//   (and xisto-apm's other formats).
// - Metrics: OTLP delta metrics to …/v1/metrics, sent with the traces: http.server.request.duration,
//   http.client.request.duration and db.client.operation.duration (from the spans, OpenTelemetry's semantic
//   conventions: what New Relic's Summary, Transactions, Databases and External services pages read), recordMetric
//   (a gauge) and incrementMetric (a count).
// - recordCustomEvent, recordLogEvent, setDispatcher, setIgnoreTransaction & the instrument* functions are accepted
//   and send nothing.
// - noticeError outside a transaction is dropped (OTLP has no error without a span).
// - shutdown always sends what is pending (collectPendingData is not needed).
// - startSegment's callback argument is accepted; the segment ends when the handler returns (or its promise
//   settles).
// - getLinkingMetadata has no entity.guid (the agent learns it from the collector).
import {
  Apm,
  ApmOtlpExporter,
  spanBudgetSampler,
  ApmServiceInfo,
  ApmSpan,
  ApmSpanOptions,
  activeSpan,
  newSpan,
  runIn,
  extractParent,
  localRoot,
  hostName,
} from "xisto-apm";

/** What a transaction keeps beside its span: whether the code took it over (getTransaction: ended by hand). */
export class TransactionState {
  span: ApmSpan;
  taken: boolean = false;
  constructor(span: ApmSpan) {
    this.span = span;
  }
}

let startedOnce = false;
let exporter: ApmOtlpExporter | null = null;

function env(name: string): string | null {
  const v = process.env[name];
  return v === null || v === "" ? null : v;
}

/** (xisto) Starts the agent from the NEW_RELIC_* variables; done on import and on first use, once. */
export function start(): void {
  if (startedOnce) return;
  startedOnce = true;
  const enabled = env("NEW_RELIC_ENABLED");
  if (enabled !== null && (enabled === "false" || enabled === "0")) return;
  const key = env("NEW_RELIC_LICENSE_KEY");
  if (key === null) return;
  const info = new ApmServiceInfo();
  const names = env("NEW_RELIC_APP_NAME") ?? "";
  info.service = names.length > 0 ? names.split(";")[0].trim() : "My Application";
  info.hostname = hostName();
  const labels = env("NEW_RELIC_LABELS");
  if (labels !== null) {
    for (const kv of labels.split(";")) {
      const c = kv.indexOf(":");
      if (c > 0) info.tags.set(kv.slice(0, c).trim(), kv.slice(c + 1).trim());
    }
  }
  const host = env("NEW_RELIC_HOST") ?? "";
  let otlpHost = "otlp.nr-data.net";
  if (host.indexOf("otlp") >= 0) otlpHost = host;
  else if (host.indexOf("gov") >= 0) otlpHost = "gov-otlp.nr-data.net";
  else if (key.startsWith("eu") || host.indexOf("eu01") >= 0) otlpHost = "otlp.eu01.nr-data.net";
  const url = env("NEW_RELIC_OTLP_URL") ?? `https://${otlpHost}:4318/v1/traces`;
  const h = new Map<string, string>();
  h.set("api-key", key);
  const ex = new ApmOtlpExporter(url, h);
  // New Relic's APM pages (Summary, Transactions, Databases, External services) are drawn from OTLP metrics
  ex.withMetrics();
  // the traces themselves are sampled as the agent does: NEW_RELIC_SPAN_EVENTS_MAX_SAMPLES_STORED spans a minute
  // (default 2000), errors always kept; the metrics above count every request
  const budget = Math.trunc(Number(env("NEW_RELIC_SPAN_EVENTS_MAX_SAMPLES_STORED") ?? "2000"));
  if (budget > 0) Apm.setKeepTrace(spanBudgetSampler(budget));
  exporter = ex;
  Apm.start(info, ex);
}
start();

// ---- transactions and segments ----

/** Ends span when v settles (a promise) or right after (any other value), unless the code took the transaction. */
function endWith(span: ApmSpan, st: TransactionState | null, v: any): any {
  (async (): Promise<void> => {
    try {
      await v;
    } catch (err) {
      markError(span, err);
    }
    if (st === null || !(st as TransactionState).taken) span.finish();
  })();
  return v;
}

function markError(span: ApmSpan, err: any): void {
  span.error = true;
  if (err instanceof Error) {
    const e = err as Error;
    span.errorType = e.name;
    span.errorMessage = e.message;
    const n = e.name;
    // (xisto gives the built-in TypeError, RangeError... no stack to read)
    span.errorStack = n === "TypeError" || n === "RangeError" || n === "SyntaxError" || n === "ReferenceError" || n === "EvalError" || n === "URIError" ? "" : e.stack ?? "";
  } else {
    span.errorType = "Error";
    span.errorMessage = String(err);
  }
}

function runTransaction(name: string, kind: string, attrKey: string, attrValue: string, handle: () => any): any {
  start();
  if (!Apm.on) return handle();
  const o = new ApmSpanOptions();
  o.root = true;
  o.kind = kind;
  o.component = "newrelic";
  const span = newSpan(name, o) as ApmSpan;
  span.setText(attrKey, attrValue);
  const st = new TransactionState(span);
  span.facade = st;
  let v: any = null;
  try {
    v = runIn(span, (): any => handle());
  } catch (err) {
    markError(span, err);
    if (!st.taken) span.finish();
    throw err;
  }
  return endWith(span, st, v);
}

/** Runs handle in a new web transaction named url; it ends when handle returns (or its promise settles), or, when
 * handle called getTransaction(), when that transaction's end() is called. handle's value is returned. */
export function startWebTransaction(url: string, handle: () => any): any {
  return runTransaction(url, "server", "url.path", url, handle);
}

/** Runs handle in a new background (non-web) transaction; group defaults to "Nodejs". */
export function startBackgroundTransaction(name: string, group: string | (() => any), handle: (() => any) | null = null): any {
  if (typeof group === "string") {
    const h = handle;
    if (h === null) return null;
    return runTransaction(name, "internal", "transaction.group", group as string, h as () => any);
  }
  return runTransaction(name, "internal", "transaction.group", "Nodejs", group as () => any);
}

/** Runs handler in a segment (a child span of the current one) named name; it ends when handler returns or its
 * promise settles. Outside a transaction handler just runs. */
export function startSegment(name: string, record: boolean, handler: () => any, callback: (() => void) | null = null): any {
  start();
  const cur = activeSpan();
  if (!Apm.on || cur === null) return handler();
  const o = new ApmSpanOptions();
  o.component = "newrelic";
  const span = newSpan(name, o) as ApmSpan;
  let v: any = null;
  try {
    v = runIn(span, (): any => handler());
  } catch (err) {
    markError(span, err);
    span.finish();
    throw err;
  }
  return endWith(span, null, v);
}

/** The current transaction, taken over by the code: it ends when its end() is called. */
export class TransactionHandle {
  span: ApmSpan | null;
  constructor(span: ApmSpan | null) {
    this.span = span;
  }
  /** Ends the transaction (cb runs after). */
  end(callback: (() => void) | null = null): void {
    const s = this.span;
    if (s !== null) (s as ApmSpan).finish();
    if (callback !== null) (callback as () => void)();
  }
  /** Drops the transaction: nothing of it is sent. */
  ignore(): void {
    const s = this.span;
    if (s === null) return;
    const sp = s as ApmSpan;
    const t = sp.trace;
    t.priority = 0;
  }
  isSampled(): boolean {
    const s = this.span;
    return s !== null && (s as ApmSpan).trace.priority > 0;
  }
  /** Writes the W3C traceparent of the current span into headers. */
  insertDistributedTraceHeaders(headers: Record<string, string>): void {
    const s = this.span;
    if (s === null) return;
    const cur = activeSpan();
    const from: ApmSpan = cur !== null && (cur as ApmSpan).trace === (s as ApmSpan).trace ? (cur as ApmSpan) : (s as ApmSpan);
    headers["traceparent"] = `00-${from.traceIdHex()}-${from.spanIdHex()}-${from.trace.priority > 0 ? "01" : "00"}`;
  }
  /** Continues the trace these incoming headers carry (traceparent): the transaction becomes its child. */
  acceptDistributedTraceHeaders(transportType: string, headers: Record<string, string>): void {
    const s = this.span;
    if (s === null) return;
    const m = new Map<string, string>();
    for (const k of Object.keys(headers)) m.set(k.toLowerCase(), String(headers[k]));
    const p = extractParent(m);
    if (p === null) return;
    const sp = s as ApmSpan;
    sp.trace.hi = p.traceHi;
    sp.trace.lo = p.traceLo;
    sp.parentId = p.spanId;
    sp.setText("transport.type", transportType);
  }
}

/** The current transaction, handled by the code from now on (its end() ends it); a handle that does nothing
 * outside a transaction. */
export function getTransaction(): TransactionHandle {
  start();
  const cur = activeSpan();
  if (cur === null) return new TransactionHandle(null);
  const root = localRoot(cur as ApmSpan);
  if (root.facade !== null) {
    const f: any = root.facade;
    const st = f as TransactionState;
    st.taken = true;
  }
  return new TransactionHandle(root);
}

function txSpan(): ApmSpan | null {
  const cur = activeSpan();
  if (cur === null) return null;
  return localRoot(cur as ApmSpan);
}

// ---- attributes, errors, names ----

/** A custom attribute of the current transaction. */
export function addCustomAttribute(key: string, value: any): void {
  start();
  const s = txSpan();
  if (s !== null) (s as ApmSpan).setTag(key, typeof value === "boolean" ? String(value) : value);
}
export function addCustomAttributes(atts: Record<string, any>): void {
  for (const k of Object.keys(atts)) addCustomAttribute(k, atts[k]);
}
/** A custom attribute of the current segment (span). */
export function addCustomSpanAttribute(key: string, value: any): void {
  start();
  const s = activeSpan();
  if (s !== null) (s as ApmSpan).setTag(key, typeof value === "boolean" ? String(value) : value);
}
export function addCustomSpanAttributes(atts: Record<string, any>): void {
  for (const k of Object.keys(atts)) addCustomSpanAttribute(k, atts[k]);
}
/** The user of the current transaction (enduser.id). */
export function setUserID(id: string): void {
  const s = txSpan();
  if (s !== null) (s as ApmSpan).setText("enduser.id", id);
}

/** Records err on the current span (status ERROR, an exception event) with these custom attributes. */
export function noticeError(err: any, customAttributes: any = null, expected: boolean = false): void {
  start();
  const s = activeSpan();
  if (s === null) return;
  const sp = s as ApmSpan;
  markError(sp, err);
  if (expected) sp.setText("error.expected", "true");
  if (customAttributes !== null) {
    const a: Record<string, any> = customAttributes;
    for (const k of Object.keys(a)) sp.setTag(k, typeof a[k] === "boolean" ? String(a[k]) : a[k]);
  }
}

/** Renames the current transaction. */
export function setTransactionName(name: string): void {
  start();
  const s = txSpan();
  if (s === null) return;
  const sp = s as ApmSpan;
  sp.name = name;
  sp.resource = name;
}
/** Names the current transaction "name/action" (action: the request's method; "GET" by default). */
export function setControllerName(name: string, action: string | null = null): void {
  start();
  const s = txSpan();
  if (s === null) return;
  const sp = s as ApmSpan;
  sp.name = `${name}/${action ?? "GET"}`;
  sp.resource = sp.name;
}

/** {traceId, spanId} of the current span; {} outside a transaction ({"traceId": "", "spanId": ""} when the agent
 * is off, as the real one). */
export function getTraceMetadata(): Record<string, string> {
  start();
  const r: Record<string, string> = {};
  if (!Apm.on) {
    r["traceId"] = "";
    r["spanId"] = "";
    return r;
  }
  const s = activeSpan();
  if (s === null) return r;
  r["traceId"] = (s as ApmSpan).traceIdHex();
  r["spanId"] = (s as ApmSpan).spanIdHex();
  return r;
}

/** The ids and entity of the current span for logs: trace.id, span.id, entity.name, entity.type, hostname. */
export function getLinkingMetadata(omitSupportability: boolean = false): Record<string, string> {
  start();
  const r: Record<string, string> = {};
  if (!Apm.on) return r;
  const s = activeSpan();
  if (s !== null) {
    r["trace.id"] = (s as ApmSpan).traceIdHex();
    r["span.id"] = (s as ApmSpan).spanIdHex();
  }
  r["entity.name"] = Apm.info.service;
  r["entity.type"] = "SERVICE";
  r["hostname"] = Apm.info.hostname;
  return r;
}

// ---- custom metrics: OTLP metrics with the name given (a gauge; incrementMetric a delta count) ----

export function recordMetric(name: string, value: any): void {
  start();
  const ex = exporter;
  if (ex === null || ex.metrics === null) return;
  // a number, or the agent's summary object ({ count, total, min, max, sumOfSquares }): its total
  const v = typeof value === "number" ? (value as number) : Number((value as Record<string, any>)["total"] ?? 0);
  ex.withMetrics().gauge(name, v);
}
export function incrementMetric(name: string, value: number = 1): void {
  start();
  const ex = exporter;
  if (ex === null || ex.metrics === null) return;
  ex.withMetrics().count(name, value);
}

// ---- accepted, not exported ----

export function recordCustomEvent(eventType: string, attributes: any): void {}
export function recordLogEvent(logEvent: any): void {}
export function setDispatcher(name: string, version: string | null = null): void {}
export function setIgnoreTransaction(ignored: boolean): void {
  if (ignored) getTransaction().ignore();
}
export function instrument(moduleName: any, onRequire: any = null, onError: any = null): void {}
export function instrumentDatastore(moduleName: any, onRequire: any = null, onError: any = null): void {}
export function instrumentWebframework(moduleName: any, onRequire: any = null, onError: any = null): void {}
export function instrumentMessages(moduleName: any, onRequire: any = null, onError: any = null): void {}
export function instrumentLoadedModule(moduleName: string, module: any): boolean {
  return false;
}

/** Sends what is queued (with collectPendingData; always here) and stops the agent; cb(err) after. */
export function shutdown(options: Record<string, any> | ((err: Error | null) => void) | null = null, cb: ((err: Error | null) => void) | null = null): void {
  start();
  let callback = cb;
  if (callback === null && typeof options === "function") callback = options as (err: Error | null) => void;
  (async (): Promise<void> => {
    await Apm.flush();
    Apm.stop();
    if (callback !== null) {
      const f = callback as (err: Error | null) => void;
      f(null);
    }
  })();
}

/** The agent's API object: `import newrelic from "newrelic"` (the named exports serve `import * as` and require). */
export class NewRelicApi {
  start(): void {
    start();
  }
  startWebTransaction(url: string, handle: () => any): any {
    return startWebTransaction(url, handle);
  }
  startBackgroundTransaction(name: string, group: string | (() => any), handle: (() => any) | null = null): any {
    return startBackgroundTransaction(name, group, handle);
  }
  startSegment(name: string, record: boolean, handler: () => any, callback: (() => void) | null = null): any {
    return startSegment(name, record, handler, callback);
  }
  getTransaction(): TransactionHandle {
    return getTransaction();
  }
  addCustomAttribute(key: string, value: any): void {
    addCustomAttribute(key, value);
  }
  addCustomAttributes(atts: Record<string, any>): void {
    addCustomAttributes(atts);
  }
  addCustomSpanAttribute(key: string, value: any): void {
    addCustomSpanAttribute(key, value);
  }
  addCustomSpanAttributes(atts: Record<string, any>): void {
    addCustomSpanAttributes(atts);
  }
  setUserID(id: string): void {
    setUserID(id);
  }
  noticeError(err: any, customAttributes: any = null, expected: boolean = false): void {
    noticeError(err, customAttributes, expected);
  }
  setTransactionName(name: string): void {
    setTransactionName(name);
  }
  setControllerName(name: string, action: string | null = null): void {
    setControllerName(name, action);
  }
  getTraceMetadata(): Record<string, string> {
    return getTraceMetadata();
  }
  getLinkingMetadata(omitSupportability: boolean = false): Record<string, string> {
    return getLinkingMetadata(omitSupportability);
  }
  recordMetric(name: string, value: any): void {
    recordMetric(name, value);
  }
  incrementMetric(name: string, value: number = 1): void {
    incrementMetric(name, value);
  }
  recordCustomEvent(eventType: string, attributes: any): void {}
  recordLogEvent(logEvent: any): void {}
  setDispatcher(name: string, version: string | null = null): void {}
  setIgnoreTransaction(ignored: boolean): void {
    setIgnoreTransaction(ignored);
  }
  instrument(moduleName: any, onRequire: any = null, onError: any = null): void {}
  instrumentDatastore(moduleName: any, onRequire: any = null, onError: any = null): void {}
  instrumentWebframework(moduleName: any, onRequire: any = null, onError: any = null): void {}
  instrumentMessages(moduleName: any, onRequire: any = null, onError: any = null): void {}
  instrumentLoadedModule(moduleName: string, module: any): boolean {
    return false;
  }
  shutdown(options: Record<string, any> | ((err: Error | null) => void) | null = null, cb: ((err: Error | null) => void) | null = null): void {
    shutdown(options, cb);
  }
}

const api = new NewRelicApi();
export default api;
