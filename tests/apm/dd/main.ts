// dd-trace's manual API as an app uses it (an ApmService/@Trace style wrapper): trace() sync and async, nested
// spans, startSpan with childOf, scope().activate/active, tags (an Error as the error tag), setUser, wrap
import tracer from "dd-trace";

tracer.init({
  service: "shop",
  env: "test",
  version: "1.2.3",
  hostname: "127.0.0.1",
  port: Number(process.env.APM_DD_PORT ?? "8126"),
  flushInterval: 50,
  startupLogs: false,
  runtimeMetrics: false,
  plugins: false,
});

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

tracer.trace("checkout", { resource: "POST /checkout", type: "web", tags: { "custom.cart": 3 } }, (span) => {
  span.setTag("user.id", "u1");
  tracer.setUser({ id: "42", name: "ana" });
  tracer.trace("db.query", { resource: "SELECT * FROM cart", type: "sql" }, (q) => {
    q.setTag("db.rows", 2);
  });
  console.log("active is checkout:", tracer.scope().active() === span);
});

async function job(): Promise<void> {
  await tracer.trace("nightly.job", { resource: "rebuild-index" }, async () => {
    await sleep(5);
    tracer.trace("job.step", {}, () => {});
  });
}

const parent = tracer.startSpan("manual.parent", { tags: { "custom.kind": "manual" } });
const child = tracer.startSpan("manual.child", { childOf: parent, tags: { a: "b" } });
child.finish();
parent.setTag("error", new Error("payment declined"));
parent.finish();

try {
  tracer.trace("boom", {}, () => {
    throw new Error("bad thing");
  });
} catch (err) {
  console.log("caught:", (err as Error).message);
}

const add = tracer.wrap("math.add", (a: number, b: number): number => a + b);
console.log("wrapped:", add(2, 3));

const outer = tracer.startSpan("activated");
tracer.scope().activate(outer, () => {
  console.log("activated is active:", tracer.scope().active() === outer);
});
outer.finish();
console.log("no active span outside:", tracer.scope().active() === null);

job().then(() => sleep(400));
