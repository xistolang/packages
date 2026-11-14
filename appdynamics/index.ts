// appdynamics for xisto: the AppDynamics Node.js agent's API (profile, startTransaction, getTransaction, the
// transaction's end/markError/startExitCall/endExitCall/addSnapshotData/addAnalyticsData, correlation headers) on
// the xisto-apm core, exporting OTLP/HTTP JSON to AppDynamics' OpenTelemetry ingest with the header
// "x-api-key: <accountAccessKey>".
//
// Resource (AppDynamics' mapping of OpenTelemetry): service.namespace = applicationName (the application),
// service.name = tierName (the tier), service.instance.id = nodeName (the node), plus appdynamics.controller.account,
// appdynamics.controller.host and appdynamics.controller.port.
// Spans: a business transaction is a root span (kind server) named as given; an exit call is a client span named
// label (or backendName, or the exit type) with appd.exit.type, peer.service (backendName) and its identifying
// properties: HOST → server.address, PORT → server.port, URL → url.full, DATABASE → db.name, VENDOR → db.system
// (lower case), any other → appd.<property in lower case>. addSnapshotData and addAnalyticsData add span attributes
// (their key as given) to the transaction; markError/end(err) set status ERROR and an "exception" event.
//
// Where the traces go: APPDYNAMICS_OTLP_URL (xisto's) or the profile option otlpUrl (xisto's); else, for a SaaS
// controller (*.saas.appdynamics.com), https://pdx-sls-agent-api.saas.appdynamics.com/v1/traces (set the URL for
// another region); else an OpenTelemetry Collector beside an on-premises controller:
// http(s)://<controllerHostName>:4318/v1/traces.
// Configuration: the profile() options win over the agent's variables APPDYNAMICS_CONTROLLER_HOST_NAME,
// APPDYNAMICS_CONTROLLER_PORT, APPDYNAMICS_CONTROLLER_SSL_ENABLED, APPDYNAMICS_AGENT_ACCOUNT_NAME,
// APPDYNAMICS_AGENT_ACCOUNT_ACCESS_KEY, APPDYNAMICS_AGENT_APPLICATION_NAME, APPDYNAMICS_AGENT_TIER_NAME,
// APPDYNAMICS_AGENT_NODE_NAME; without an access key and a controller (or an OTLP URL) nothing starts.
//
// Differences from the npm package:
// - No agent proxy, no controller connection, no automatic instrumentation by patching modules: the ported
//   packages call xisto-apm's hooks, and the traces go out as OTLP (so AppDynamics shows them as OpenTelemetry
//   services, with its OTel licensing).
// - Call profile() as `appd.profile({...})` after `import appd from "appdynamics"` (a top-level
//   `require("appdynamics")` is read as `import * as`, whose profile() is the same function).
// - getTransaction(req) gives the transaction of the current asynchronous context (the request's span made by the
//   instrumented HTTP server), not one looked up by req; null outside one.
// - The correlation header (exitCall.getCorrelationHeader()) is a W3C traceparent; parseCorrelationInfo(header)
//   reads one (or another header format xisto-apm reads) for startTransaction(info) to continue that trace.
// - Not implemented: __agent, the agent's own logger options, custom metrics (addMetric/reportMetric accepted,
//   nothing sent), tx.beforeExitCall/exitCallCompleted callbacks (accepted, never called), tx.resume() (does
//   nothing: the context already follows awaits).
import { Apm, ApmOtlpExporter, ApmServiceInfo, ApmSpan, ApmSpanOptions, ApmParent, activeSpan, newSpan, enterSpan, extractParent, localRoot, hostName } from "xisto-apm";

/** The options of profile() (the ones used here; the others are accepted). */
export interface ProfileOptions {
  controllerHostName?: string;
  controllerPort?: number;
  controllerSslEnabled?: boolean;
  accountName?: string;
  accountAccessKey?: string;
  applicationName?: string;
  tierName?: string;
  nodeName?: string;
  /** xisto's: the whole OTLP traces URL */
  otlpUrl?: string;
  reuseNode?: boolean;
  reuseNodePrefix?: string;
  noNodeNameSuffix?: boolean;
  debug?: boolean;
  logging?: any;
  proxyHost?: string;
  proxyPort?: number;
  analytics?: any;
  libagent?: boolean;
}

/** An exit call's description (startExitCall). */
export interface ExitCallInfo {
  exitType: string;
  label?: string;
  backendName?: string;
  identifyingProperties?: Record<string, string>;
}

function env(name: string): string | null {
  const v = process.env[name];
  return v === null || v === "" ? null : v;
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

let profiled = false;

/** Starts the agent (once). */
export function profile(options: ProfileOptions | null = null): void {
  if (profiled) return;
  profiled = true;
  const o: ProfileOptions = options ?? {};
  const host = o.controllerHostName ?? env("APPDYNAMICS_CONTROLLER_HOST_NAME") ?? "";
  const portEnv = env("APPDYNAMICS_CONTROLLER_PORT");
  const sslEnv = env("APPDYNAMICS_CONTROLLER_SSL_ENABLED");
  const ssl = o.controllerSslEnabled ?? (sslEnv !== null ? sslEnv === "true" : false);
  const port = o.controllerPort ?? (portEnv !== null ? Number(portEnv) : ssl ? 443 : 8090);
  const account = o.accountName ?? env("APPDYNAMICS_AGENT_ACCOUNT_NAME") ?? "";
  const key = o.accountAccessKey ?? env("APPDYNAMICS_AGENT_ACCOUNT_ACCESS_KEY") ?? "";
  const app = o.applicationName ?? env("APPDYNAMICS_AGENT_APPLICATION_NAME") ?? "";
  const tier = o.tierName ?? env("APPDYNAMICS_AGENT_TIER_NAME") ?? "";
  const node = o.nodeName ?? env("APPDYNAMICS_AGENT_NODE_NAME") ?? hostName();
  let url = o.otlpUrl ?? env("APPDYNAMICS_OTLP_URL") ?? "";
  if (url.length === 0 && host.length > 0) {
    url = host.endsWith(".saas.appdynamics.com") ? "https://pdx-sls-agent-api.saas.appdynamics.com/v1/traces" : `${ssl ? "https" : "http"}://${host}:4318/v1/traces`;
  }
  if (key.length === 0 || url.length === 0 || Apm.on) return;
  const info = new ApmServiceInfo();
  info.service = tier.length > 0 ? tier : app;
  info.hostname = hostName();
  const h = new Map<string, string>();
  h.set("x-api-key", key);
  const ex = new ApmOtlpExporter(url, h);
  if (app.length > 0) ex.resourceAttrs.set("service.namespace", app);
  ex.resourceAttrs.set("service.instance.id", node);
  if (account.length > 0) ex.resourceAttrs.set("appdynamics.controller.account", account);
  if (host.length > 0) {
    ex.resourceAttrs.set("appdynamics.controller.host", host);
    ex.resourceAttrs.set("appdynamics.controller.port", String(port));
  }
  Apm.start(info, ex);
}

/** The trace an incoming correlation header carries (parseCorrelationInfo). */
export class CorrelationInfo {
  parent: ApmParent | null;
  businessTransactionName: string | null = null;
  constructor(parent: ApmParent | null) {
    this.parent = parent;
  }
}

/** An exit call in progress (startExitCall). */
export class ExitCall {
  span: ApmSpan | null;
  exitType: string;
  label: string;
  backendName: string;
  constructor(span: ApmSpan | null, exitType: string, label: string, backendName: string) {
    this.span = span;
    this.exitType = exitType;
    this.label = label;
    this.backendName = backendName;
  }
  /** The header to send to the service called (a W3C traceparent; "" when not tracing). */
  getCorrelationHeader(): string {
    const s = this.span;
    if (s === null) return "";
    const sp = s as ApmSpan;
    return `00-${sp.traceIdHex()}-${sp.spanIdHex()}-${sp.trace.priority > 0 ? "01" : "00"}`;
  }
}

/** A business transaction (TimePromise in the npm package). */
export class TimePromise {
  span: ApmSpan | null;
  constructor(span: ApmSpan | null) {
    this.span = span;
  }
  /** Ends it (err: it failed; statusCode: the HTTP status, an attribute). */
  end(error: any = null, statusCode: number | null = null): void {
    const s = this.span;
    if (s === null) return;
    const sp = s as ApmSpan;
    if (error !== null) markError(sp, error);
    if (statusCode !== null) sp.setNumber("http.response.status_code", statusCode as number);
    sp.finish();
    if (activeSpan() === sp) enterSpan(null);
  }
  /** Marks it failed (without ending it). */
  markError(error: any, statusCode: number | null = null): void {
    const s = this.span;
    if (s === null) return;
    markError(s as ApmSpan, error);
    if (statusCode !== null) (s as ApmSpan).setNumber("http.response.status_code", statusCode as number);
  }
  addSnapshotData(key: string, value: any, ifEnabled: any = null): void {
    const s = this.span;
    if (s !== null) (s as ApmSpan).setTag(key, typeof value === "boolean" ? String(value) : value);
  }
  addAnalyticsData(key: string, value: any): void {
    const s = this.span;
    if (s !== null) (s as ApmSpan).setTag(key, typeof value === "boolean" ? String(value) : value);
  }
  /** An exit call of this transaction (a child span of it). */
  startExitCall(info: ExitCallInfo): ExitCall {
    const backend = info.backendName ?? "";
    const label = info.label ?? (backend.length > 0 ? backend : info.exitType);
    const s = this.span;
    if (s === null || !Apm.on) return new ExitCall(null, info.exitType, label, backend);
    const o = new ApmSpanOptions();
    o.childOf = s as ApmSpan;
    o.kind = "client";
    o.component = "appdynamics";
    const sp = newSpan(label, o) as ApmSpan;
    sp.setText("appd.exit.type", info.exitType);
    if (backend.length > 0) sp.setText("peer.service", backend);
    const props = info.identifyingProperties;
    if (props !== null) {
      const p = props as Record<string, string>;
      for (const k of Object.keys(p)) {
        const v = String(p[k]);
        const u = k.toUpperCase();
        if (u === "HOST") sp.setText("server.address", v);
        else if (u === "PORT") sp.setNumber("server.port", Number(v));
        else if (u === "URL") sp.setText("url.full", v);
        else if (u === "DATABASE") sp.setText("db.name", v);
        else if (u === "VENDOR") sp.setText("db.system", v.toLowerCase());
        else sp.setText(`appd.${k.toLowerCase()}`, v);
      }
    }
    return new ExitCall(sp, info.exitType, label, backend);
  }
  /** Ends an exit call (error: it failed). */
  endExitCall(exitCall: ExitCall | null, error: any = null): void {
    if (exitCall === null) return;
    const s = (exitCall as ExitCall).span;
    if (s === null) return;
    if (error !== null) markError(s as ApmSpan, error);
    (s as ApmSpan).finish();
  }
  beforeExitCall(cb: any): void {}
  exitCallCompleted(cb: any): void {}
  resume(): void {}
}

/** Starts a business transaction named name (or continuing the trace of a CorrelationInfo); it becomes the current
 * one. */
export function startTransaction(info: string | CorrelationInfo | null = null): TimePromise {
  if (!Apm.on) return new TimePromise(null);
  const o = new ApmSpanOptions();
  o.root = true;
  o.kind = "server";
  o.component = "appdynamics";
  let name = "transaction";
  if (typeof info === "string") name = info as string;
  else if (info !== null) {
    const ci = info as CorrelationInfo;
    if (ci.businessTransactionName !== null) name = ci.businessTransactionName as string;
    if (ci.parent !== null) {
      o.root = false;
      o.remote = ci.parent as ApmParent;
    }
  }
  const sp = newSpan(name, o) as ApmSpan;
  enterSpan(sp);
  return new TimePromise(sp);
}

/** The transaction of the current asynchronous context (req is not looked at); null outside one. */
export function getTransaction(req: any = null): TimePromise | null {
  const s = activeSpan();
  if (s === null) return null;
  return new TimePromise(localRoot(s as ApmSpan));
}

/** Reads a correlation header (a W3C traceparent, or another format xisto-apm reads). */
export function parseCorrelationInfo(header: any): CorrelationInfo {
  const m = new Map<string, string>();
  if (typeof header === "string") m.set("traceparent", header as string);
  return new CorrelationInfo(extractParent(m));
}

export function addMetric(name: string, op: any = null): void {}
export function reportMetric(name: string, value: number): void {}

/** The agent: `import appd from "appdynamics"`. */
export class AppDynamics {
  profile(options: ProfileOptions | null = null): AppDynamics {
    profile(options);
    return this;
  }
  startTransaction(info: string | CorrelationInfo | null = null): TimePromise {
    return startTransaction(info);
  }
  getTransaction(req: any = null): TimePromise | null {
    return getTransaction(req);
  }
  parseCorrelationInfo(header: any): CorrelationInfo {
    return parseCorrelationInfo(header);
  }
  addMetric(name: string, op: any = null): void {}
  reportMetric(name: string, value: number): void {}
}

const appd = new AppDynamics();
export default appd;
