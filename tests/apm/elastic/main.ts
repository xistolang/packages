// elastic-apm-node's manual API as an app uses it: start with options, transactions, spans (sync, across awaits,
// nested), labels, user and custom context, outcome and result, captureError, currentTraceIds, flush.
import apm from "elastic-apm-node";

apm.start({
  serviceName: "shop",
  serverUrl: "http://127.0.0.1:" + (process.env.APM_ELASTIC_PORT ?? "8200"),
  secretToken: "s3cret",
  environment: "test",
  serviceVersion: "1.2.3",
  logLevel: "off",
  centralConfig: false,
  metricsInterval: "0s",
  cloudProvider: "none",
  captureExceptions: false,
});
console.log("started:", apm.isStarted());

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const t = apm.startTransaction("POST /checkout", "request");
console.log("current is t:", apm.currentTransaction === t, "name:", t.name, "type:", t.type);
apm.setLabel("cart", 3);
apm.addLabels({ region: "eu", vip: true });
apm.setUserContext({ id: "42", username: "ana", email: "ana@example.com" });
apm.setCustomContext({ coupon: "X1" });
const s = apm.startSpan("SELECT * FROM cart", "db", "postgresql", "query");
if (s !== null) {
  s.setLabel("rows", 2);
  console.log("current span is s:", apm.currentSpan === s, "span name:", s.name, "type:", s.type);
  s.end();
}
const ids = apm.currentTraceIds;
console.log("trace ids keys:", Object.keys(ids).join(","), "trace id length:", String(ids["trace.id"]).length);
console.log("traceparent:", /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(t.traceparent));
apm.captureError(new Error("payment declined"));
t.result = "HTTP 2xx";
apm.setTransactionOutcome("success");
t.end();
console.log("outcome:", t.outcome, "result:", t.result);

async function job(): Promise<void> {
  const j = apm.startTransaction("nightly", "job");
  apm.setTransactionName("nightly-rebuild");
  const outer = apm.startSpan("rebuild", "app");
  await sleep(5);
  const inner = apm.startSpan("write", "storage", "fs", "write");
  console.log("after await current is inner:", apm.currentSpan === inner);
  if (inner !== null) inner.end();
  if (outer !== null) outer.end();
  apm.setTransactionOutcome("failure");
  j.result = "error";
  j.end();
}

async function main(): Promise<void> {
  await job();
  const b = apm.startTransaction("bad", "task");
  const err = new TypeError("bad input");
  apm.captureError(err);
  b.end();
  await new Promise<void>((resolve) => apm.flush(() => resolve()));
  console.log("flushed");
}
main();
