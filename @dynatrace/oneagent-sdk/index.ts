// @dynatrace/oneagent-sdk for xisto: the OneAgent SDK for Node.js API (^1) on the xisto-apm core. Its tracers make
// spans that go wherever xisto-apm sends them: to Dynatrace as OTLP when @dynatrace/oneagent started it (or, on the
// first createInstance(), from the DT_* variables, see that package), or to another agent's backend (dd-trace,
// newrelic...) when that one is tracing.
//
// Spans (OpenTelemetry's semantic conventions, which Dynatrace's OTLP ingest reads):
// - traceIncomingRemoteCall: kind server, named serviceMethod; rpc.system (protocolName), rpc.service
//   (serviceName), rpc.method, dt.service.endpoint (serviceEndpoint). Its dynatraceTag continues the caller's trace.
// - traceOutgoingRemoteCall: kind client, the same attributes and server.address/server.port (host, port) or
//   network.transport (unix, pipe, inproc); getDynatraceStringTag() gives the tag to send.
// - traceSQLDatabaseRequest: kind client, named "<first word of the statement> <database name>"; db.system (the
//   vendor in lower case), db.name, db.statement, server.address/port; setResultData adds
//   db.response.returned_rows and db.response.round_trip_count.
// - traceIncomingMessage / traceOutgoingMessage: kind consumer / producer, named "<destination> receive|send";
//   messaging.system, messaging.destination.name, messaging.destination.kind (queue, topic),
//   messaging.message.id, messaging.message.conversation_id.
// - traceCustomService: kind server, named serviceMethod; code.namespace (serviceName), code.function.
// - addCustomRequestAttribute: an attribute of the service's request (the local root span).
// - tracer.error(err): status ERROR and an "exception" event.
//
// Differences from the npm package:
// - The tag (getDynatraceStringTag, getDynatraceByteTag) is a W3C traceparent ("00-<trace>-<span>-01"), not
//   Dynatrace's proprietary FW4 tag; traceIncoming* accept one (or any header format xisto-apm reads). A real
//   OneAgent on the other side understands the traceparent header, not this value as x-dynatrace.
// - A tracer's span starts when the tracer is made (trace*()), not at start().
// - tracer.start(handler) takes the handler only (pass arguments with a closure); startWithContext(handler, thisObj)
//   calls handler without binding this. end(callback) calls callback with no arguments.
// - passContext(fn) gives fn back: xisto-apm's context already follows callbacks, timers and awaits.
// - traceCustomService is not in the Node SDK 1.5 (Dynatrace's other SDKs have it); it is here for ports.
// - The metrics (create*Metric) are accepted and send nothing. setLoggingCallbacks is accepted (nothing is logged).
// - getCurrentState() is ACTIVE when an xisto-apm agent is tracing, else PERMANENTLY_INACTIVE (as the SDK with no
//   OneAgent); getTraceContextInfo() then gives the invalid ids, as the real SDK.
import { Apm, ApmSpan, ApmSpanOptions, ApmParent, activeSpan, newSpan, runIn, extractParent, localRoot } from "xisto-apm";
import { startOneAgent } from "@dynatrace/oneagent";

/** SDKState as the npm package's (a const enum there). */
export class SDKState {
  static ACTIVE: int = 0;
  static TEMPORARILY_INACTIVE: int = 1;
  static PERMANENTLY_INACTIVE: int = 2;
}
/** ChannelType as the npm package's. */
export class ChannelType {
  static OTHER: int = 0;
  static TCP_IP: int = 1;
  static UNIX_DOMAIN_SOCKET: int = 2;
  static NAMED_PIPE: int = 3;
  static IN_PROCESS: int = 4;
}
/** MessageDestinationType as the npm package's. */
export class MessageDestinationType {
  static QUEUE: int = 0;
  static TOPIC: int = 1;
}
/** Some of the well-known database vendors (DatabaseVendor). */
export class DatabaseVendor {
  static POSTGRESQL: string = "PostgreSQL";
  static MYSQL: string = "MySQL";
  static ORACLE: string = "Oracle";
  static SQLSERVER: string = "SQL Server";
  static MONGODB: string = "MongoDB";
  static MARIADB: string = "MariaDB";
  static DB2: string = "DB2";
  static SQLITE: string = "SQLite";
  static REDIS: string = "Redis";
  static CASSANDRA: string = "Cassandra";
  static ELASTICSEARCH: string = "Elasticsearch";
}
/** Some of the well-known messaging vendors (MessageSystemVendor). */
export class MessageSystemVendor {
  static KAFKA: string = "Kafka";
  static RABBIT_MQ: string = "RabbitMQ";
  static ACTIVE_MQ: string = "ActiveMQ";
  static AWS_SQS: string = "AWS SQS";
  static AWS_SNS: string = "AWS SNS";
}

export const invalidSpanId = "0000000000000000";
export const invalidTraceId = "00000000000000000000000000000000";

/** Where a database or a remote service is (ConnectionInfo and the start data that extend it). */
export interface ConnectionInfo {
  host?: string;
  port?: number;
  socketPath?: string;
  pipeName?: string;
  channelType?: int;
}
export interface DatabaseInfo {
  name: string;
  vendor: string;
  host?: string;
  port?: number;
  socketPath?: string;
  pipeName?: string;
  channelType?: int;
}
export interface SQLDatabaseRequestStartData {
  statement: string;
}
export interface SQLDatabaseRequestResultData {
  rowsReturned?: number;
  roundTripCount?: number;
}
export interface IncomingRemoteCallStartData {
  serviceMethod: string;
  serviceName: string;
  serviceEndpoint: string;
  protocolName?: string;
  dynatraceTag?: string;
}
export interface OutgoingRemoteCallStartData {
  serviceMethod: string;
  serviceName: string;
  serviceEndpoint: string;
  protocolName?: string;
  host?: string;
  port?: number;
  socketPath?: string;
  pipeName?: string;
  channelType?: int;
}
export interface MessageStartData {
  vendorName: string;
  destinationName: string;
  destinationType: int;
  dynatraceTag?: string;
  host?: string;
  port?: number;
  socketPath?: string;
  pipeName?: string;
  channelType?: int;
}
export interface CustomServiceStartData {
  serviceMethod: string;
  serviceName: string;
}
export interface TraceContextInfo {
  isValid: boolean;
  traceid: string;
  spanid: string;
}
export interface LoggingCallbacks {
  warning?: (message: string) => void;
  error?: (message: string) => void;
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

/** A tracer: start(handler) runs handler with its span active (started then), end() ends it. */
export class Tracer {
  span: ApmSpan | null;
  started: boolean = false;
  constructor(span: ApmSpan | null) {
    this.span = span;
  }
  start(handler: () => any): any {
    this.started = true;
    const s = this.span;
    if (s === null) return handler();
    const sp = s as ApmSpan;
    try {
      return runIn(sp, (): any => handler());
    } catch (err) {
      markError(sp, err);
      throw err;
    }
  }
  startWithContext(handler: () => any, thisObj: any = null): any {
    return this.start(handler);
  }
  /** Marks the span failed with err. */
  error(err: any): Tracer {
    const s = this.span;
    if (s !== null && err !== null) markError(s as ApmSpan, err);
    return this;
  }
  /** Ends the span; callback (when given) is called after and its value returned. */
  end(callback: (() => any) | null = null): any {
    const s = this.span;
    if (s !== null) (s as ApmSpan).finish();
    if (callback === null) return null;
    return (callback as () => any)();
  }
  endWithContext(callback: () => any, thisObj: any = null): any {
    return this.end(callback);
  }
  /** The tag to send to the service called (a W3C traceparent; "" when not tracing). */
  getDynatraceStringTag(): string {
    const s = this.span;
    if (s === null) return "";
    const sp = s as ApmSpan;
    return `00-${sp.traceIdHex()}-${sp.spanIdHex()}-${sp.trace.priority > 0 ? "01" : "00"}`;
  }
  getDynatraceByteTag(): Buffer {
    return Buffer.from(this.getDynatraceStringTag());
  }
  /** (database requests) rows returned and round trips. */
  setResultData(data: SQLDatabaseRequestResultData): Tracer {
    const s = this.span;
    if (s === null) return this;
    const sp = s as ApmSpan;
    if (data.rowsReturned !== null) sp.setNumber("db.response.returned_rows", data.rowsReturned as number);
    if (data.roundTripCount !== null) sp.setNumber("db.response.round_trip_count", data.roundTripCount as number);
    return this;
  }
  /** (messages) the message's id and correlation id. */
  setVendorMessageId(id: string): Tracer {
    const s = this.span;
    if (s !== null) (s as ApmSpan).setText("messaging.message.id", id);
    return this;
  }
  setCorrelationId(id: string): Tracer {
    const s = this.span;
    if (s !== null) (s as ApmSpan).setText("messaging.message.conversation_id", id);
    return this;
  }
}

/** A metric that sends nothing (the SDK's create*Metric). */
export class Metric {
  increaseBy(value: number, dimensionValue: string | null = null): void {}
  setValue(value: number, dimensionValue: string | null = null): void {}
  addValue(value: number, dimensionValue: string | null = null): void {}
}

function where(sp: ApmSpan, host: string | null, port: number | null, socketPath: string | null, pipeName: string | null, channelType: int | null): void {
  if (host !== null) sp.setText("server.address", host as string);
  if (port !== null) sp.setNumber("server.port", port as number);
  if (socketPath !== null) {
    sp.setText("network.transport", "unix");
    sp.setText("server.address", socketPath as string);
  } else if (pipeName !== null) {
    sp.setText("network.transport", "pipe");
    sp.setText("server.address", pipeName as string);
  } else if (channelType !== null && (channelType as int) === 4) {
    sp.setText("network.transport", "inproc");
  }
}

function makeSpan(name: string, kind: string, tag: string | null): ApmSpan | null {
  if (!Apm.on) return null;
  const o = new ApmSpanOptions();
  o.kind = kind;
  o.component = "oneagent-sdk";
  if (tag !== null && (tag as string).length > 0) {
    const h = new Map<string, string>();
    h.set("traceparent", tag as string);
    const p = extractParent(h);
    if (p !== null) o.remote = p as ApmParent;
  }
  return newSpan(name, o);
}

/** The SDK object (createInstance()). */
export class OneAgentSDK {
  passContext(func: any): any {
    return func;
  }
  getCurrentState(): int {
    return Apm.on ? 0 : 2;
  }
  setLoggingCallbacks(callbacks: LoggingCallbacks | null = null): void {}
  getTraceContextInfo(): TraceContextInfo {
    const s = activeSpan();
    if (s === null || !Apm.on) return { isValid: false, traceid: invalidTraceId, spanid: invalidSpanId };
    const sp = s as ApmSpan;
    return { isValid: true, traceid: sp.traceIdHex(), spanid: sp.spanIdHex() };
  }
  traceIncomingRemoteCall(d: IncomingRemoteCallStartData): Tracer {
    const sp = makeSpan(d.serviceMethod, "server", d.dynatraceTag ?? null);
    if (sp !== null) {
      const s = sp as ApmSpan;
      if (d.protocolName !== null) s.setText("rpc.system", d.protocolName as string);
      s.setText("rpc.service", d.serviceName);
      s.setText("rpc.method", d.serviceMethod);
      s.setText("dt.service.endpoint", d.serviceEndpoint);
    }
    return new Tracer(sp);
  }
  traceOutgoingRemoteCall(d: OutgoingRemoteCallStartData): Tracer {
    const sp = makeSpan(d.serviceMethod, "client", null);
    if (sp !== null) {
      const s = sp as ApmSpan;
      if (d.protocolName !== null) s.setText("rpc.system", d.protocolName as string);
      s.setText("rpc.service", d.serviceName);
      s.setText("rpc.method", d.serviceMethod);
      s.setText("dt.service.endpoint", d.serviceEndpoint);
      where(s, d.host ?? null, d.port ?? null, d.socketPath ?? null, d.pipeName ?? null, d.channelType ?? null);
    }
    return new Tracer(sp);
  }
  traceSQLDatabaseRequest(db: DatabaseInfo, d: SQLDatabaseRequestStartData): Tracer {
    const st = d.statement.trim();
    const sp = makeSpan(`${st.split(" ")[0].toUpperCase()} ${db.name}`, "client", null);
    if (sp !== null) {
      const s = sp as ApmSpan;
      s.type = "sql";
      s.setText("db.system", db.vendor.toLowerCase().replace(/ /g, ""));
      s.setText("db.name", db.name);
      s.setText("db.statement", d.statement);
      where(s, db.host ?? null, db.port ?? null, db.socketPath ?? null, db.pipeName ?? null, db.channelType ?? null);
    }
    return new Tracer(sp);
  }
  traceIncomingMessage(d: MessageStartData): Tracer {
    return this.message(d, "consumer", "receive", d.dynatraceTag ?? null);
  }
  traceOutgoingMessage(d: MessageStartData): Tracer {
    return this.message(d, "producer", "send", null);
  }
  private message(d: MessageStartData, kind: string, op: string, tag: string | null): Tracer {
    const sp = makeSpan(`${d.destinationName} ${op}`, kind, tag);
    if (sp !== null) {
      const s = sp as ApmSpan;
      s.setText("messaging.system", d.vendorName.toLowerCase());
      s.setText("messaging.destination.name", d.destinationName);
      s.setText("messaging.destination.kind", d.destinationType === 1 ? "topic" : "queue");
      s.setText("messaging.operation", op);
      where(s, d.host ?? null, d.port ?? null, d.socketPath ?? null, d.pipeName ?? null, d.channelType ?? null);
    }
    return new Tracer(sp);
  }
  traceCustomService(d: CustomServiceStartData): Tracer {
    const sp = makeSpan(d.serviceMethod, "server", null);
    if (sp !== null) {
      const s = sp as ApmSpan;
      s.setText("code.namespace", d.serviceName);
      s.setText("code.function", d.serviceMethod);
    }
    return new Tracer(sp);
  }
  /** An attribute of the current request (the service's local root span). */
  addCustomRequestAttribute(key: string, value: any): void {
    const s = activeSpan();
    if (s === null) return;
    localRoot(s as ApmSpan).setTag(key, value);
  }
  createIntegerCounterMetric(name: string, options: any = null): Metric {
    return new Metric();
  }
  createFloatCounterMetric(name: string, options: any = null): Metric {
    return new Metric();
  }
  createIntegerGaugeMetric(name: string, options: any = null): Metric {
    return new Metric();
  }
  createFloatGaugeMetric(name: string, options: any = null): Metric {
    return new Metric();
  }
  createIntegerStatisticsMetric(name: string, options: any = null): Metric {
    return new Metric();
  }
  createFloatStatisticsMetric(name: string, options: any = null): Metric {
    return new Metric();
  }
}

/** The SDK; starts tracing to Dynatrace from the DT_* variables when no agent is tracing yet. */
export function createInstance(): OneAgentSDK {
  if (!Apm.on) startOneAgent(null);
  return new OneAgentSDK();
}
