// xisto-apm/otlp: the OTLP/HTTP JSON exporter (OpenTelemetry's protocol: New Relic, Dynatrace and AppDynamics take
// traces, metrics and logs in it), with OpenTelemetry's semantic conventions and the metrics derived from the spans.
// Apart from xisto-apm's core so that only the agents that send OTLP import it: the instrumented packages import the
// core, and a program built with them but without an OTLP agent carries none of this code, nor the TLS library that its
// fetch of a URL known only at run time (https://) links.
import { Apm, ApmExporter, ApmLogRecord, ApmLogs, ApmSpan, attr, attrNum, epochNs, nsText } from "./index";

function otlpKind(kind: string): int {
  return kind === "server" ? 2 : kind === "client" ? 3 : kind === "producer" ? 4 : kind === "consumer" ? 5 : 1;
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
  windowStartNs: number = epochNs();

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
    const end = epochNs();
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
      Apm.setObserver((spans: ApmSpan[]): void => {
        for (const s of spans) m.record(s);
      });
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
