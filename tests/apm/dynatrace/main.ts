// @dynatrace/oneagent and @dynatrace/oneagent-sdk: oneagent({...}) starts tracing to Dynatrace's OTLP ingest; the
// SDK's tracers (incoming remote call continuing a caller's tag, SQL request with result data, outgoing remote call
// with its tag and an error, outgoing message, custom service across an await), request attributes, trace context.
import oneagent from "@dynatrace/oneagent";
import { tracesUrl } from "@dynatrace/oneagent";
import { createInstance, DatabaseVendor, MessageDestinationType } from "@dynatrace/oneagent-sdk";

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
const hex = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

console.log("urls:", tracesUrl("abc12345", ""));
console.log("urls:", tracesUrl("abc12345", "https://abc12345.live.dynatrace.com/communication"));
console.log("urls:", tracesUrl("abc12345", "https://ag.local:9999/e/abc12345/api/v2/otlp"));
console.log("urls:", tracesUrl("abc12345", "https://managed.local/e/abc12345/"));
console.log("started:", oneagent({ environmentid: "abc12345", apitoken: "dt0c01.TOKEN" }));
const sdk = createInstance();
console.log("state:", sdk.getCurrentState());

const tin = sdk.traceIncomingRemoteCall({
  serviceMethod: "placeOrder",
  serviceName: "OrderService",
  serviceEndpoint: "/orders",
  protocolName: "grpc",
  dynatraceTag: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
});
const total = tin.start(() => {
  sdk.addCustomRequestAttribute("order.id", "o-1");
  const info = sdk.getTraceContextInfo();
  console.log("in call:", info.isValid, info.traceid === "0af7651916cd43dd8448eb211c80319c", info.spanid.length);
  const db = sdk.traceSQLDatabaseRequest({ name: "shop", vendor: DatabaseVendor.POSTGRESQL, host: "db.local", port: 5432 }, { statement: "SELECT * FROM orders WHERE id = $1" });
  db.start(() => {});
  db.setResultData({ rowsReturned: 1, roundTripCount: 1 });
  db.end();
  const out = sdk.traceOutgoingRemoteCall({ serviceMethod: "charge", serviceName: "PaymentService", serviceEndpoint: "/pay", protocolName: "http", host: "pay.local", port: 443 });
  out.start(() => {
    const tag = out.getDynatraceStringTag();
    console.log("tag:", hex.test(tag), tag.slice(3, 35) === "0af7651916cd43dd8448eb211c80319c");
  });
  out.error(new Error("card declined"));
  out.end();
  const msg = sdk.traceOutgoingMessage({ vendorName: "Kafka", destinationName: "orders", destinationType: MessageDestinationType.TOPIC, host: "kafka.local", port: 9092 });
  msg.start(() => {});
  msg.setVendorMessageId("m-1");
  msg.end();
  return 99;
});
tin.end();
console.log("value:", total);

async function main(): Promise<void> {
  const c = sdk.traceCustomService({ serviceMethod: "nightly", serviceName: "Jobs" });
  await c.start(async () => {
    await sleep(3);
    console.log("custom service active:", sdk.getTraceContextInfo().isValid);
  });
  c.end();
  sdk.createIntegerCounterMetric("orders.count").increaseBy(1);
  const after = sdk.getTraceContextInfo();
  console.log("outside:", after.isValid, after.traceid, after.spanid);
}
main();
