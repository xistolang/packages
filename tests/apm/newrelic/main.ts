// newrelic's API as an app uses it: web and background transactions (sync, async, ended by hand, ignored, failing),
// segments, custom attributes, noticeError, names, distributed trace headers, trace and linking metadata, metrics
// (accepted), shutdown. The ids are printed by their form, so that Node (the real agent, which never connects in
// this test) and xisto print the same.
import newrelic from "newrelic";

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
function form(m: Record<string, string>): string {
  const parts: string[] = [];
  for (const k of Object.keys(m)) {
    const v = String(m[k]);
    parts.push(k + "=" + (/^[0-9a-f]{32}$/.test(v) ? "<32 hex>" : /^[0-9a-f]{16}$/.test(v) ? "<16 hex>" : k === "hostname" ? "<host>" : v));
  }
  return "{" + parts.join(", ") + "}";
}

console.log("outside:", form(newrelic.getTraceMetadata()));
const v = newrelic.startWebTransaction("/checkout", () => {
  newrelic.addCustomAttribute("cart", 3);
  newrelic.addCustomAttributes({ region: "eu", coupon: "X1" });
  const meta = newrelic.getTraceMetadata();
  console.log("in web tx:", form(meta));
  console.log("linking:", form(newrelic.getLinkingMetadata()));
  newrelic.startSegment("db.query", true, () => {
    newrelic.addCustomSpanAttribute("db.rows", 2);
    const seg = newrelic.getTraceMetadata();
    console.log("segment: same trace", seg["traceId"] === meta["traceId"], "other span", seg["spanId"] !== meta["spanId"]);
  });
  newrelic.recordMetric("Custom/cart/size", 3);
  newrelic.incrementMetric("Custom/checkouts");
  return 42;
});
console.log("web tx value:", v);

async function main(): Promise<void> {
  const r = await newrelic.startBackgroundTransaction("rebuild", "jobs", async () => {
    await sleep(5);
    await newrelic.startSegment("step", false, async () => {
      await sleep(2);
    });
    newrelic.noticeError(new Error("disk full"), { disk: "sda" });
    return "done";
  });
  console.log("background value:", r);

  await new Promise<void>((resolve) => {
    newrelic.startBackgroundTransaction("manual", () => {
      const tx = newrelic.getTransaction();
      const h: Record<string, string> = {};
      tx.insertDistributedTraceHeaders(h);
      const tp = String(h["traceparent"]);
      console.log("outgoing traceparent:", /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(tp), "same trace", tp.slice(3, 35) === newrelic.getTraceMetadata()["traceId"]);
      setTimeout(() => {
        tx.end();
        resolve();
      }, 5);
    });
  });

  newrelic.startWebTransaction("/remote", () => {
    const tx = newrelic.getTransaction();
    tx.acceptDistributedTraceHeaders("HTTP", { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" });
    console.log("continued trace:", newrelic.getTraceMetadata()["traceId"] === "0af7651916cd43dd8448eb211c80319c");
    tx.end();
  });

  newrelic.startBackgroundTransaction("ignored", () => {
    newrelic.getTransaction().ignore();
  });

  newrelic.startWebTransaction("/users/42", () => {
    newrelic.setTransactionName("users/show");
  });

  try {
    newrelic.startWebTransaction("/fail", () => {
      throw new Error("boom");
    });
  } catch (err) {
    console.log("caught:", (err as Error).message);
  }
  await sleep(10);
  newrelic.shutdown((err: Error | null) => {
    console.log("shut down:", !err);
    process.exit(0);
  });
}
main();
