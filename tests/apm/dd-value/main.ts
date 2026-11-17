// dd-trace's tracer.trace(name, options, fn) gives back fn's value (dd-trace types it trace<T>(..., fn: (span) => T): T):
// a number, nothing, a promise (awaited by the caller), and through a generic helper that wraps an async callback,
// as an app's own span helper does. First with tracing off (no init), then on (an Agent that is not there).
import tracer from "dd-trace";

interface SpanTags {
  setTag(key: string, value: unknown): void;
}

function withSpan<T>(name: string, tags: Record<string, unknown>, fn: (span: SpanTags | null) => Promise<T>): Promise<T> {
  return tracer.trace(name, { resource: name, type: "worker", tags }, (span) => fn(span));
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function round(label: string): Promise<void> {
  const n = tracer.trace("sync.value", {}, () => 6 * 7);
  console.log(label, "sync:", n);
  const s = tracer.trace("sync.text", { resource: "r" }, (span) => {
    span.setTag("k", 1);
    return "text";
  });
  console.log(label, "text:", s);
  let ran = false;
  tracer.trace("sync.void", {}, () => {
    ran = true;
  });
  console.log(label, "void ran:", ran);
  const p = tracer.trace("async.value", {}, async () => {
    await sleep(2);
    return 5;
  });
  console.log(label, "async:", await p);
  const w = await withSpan("helper.number", { job: 1 }, async (span) => {
    if (span !== null) span.setTag("step", "one");
    await sleep(1);
    return 10;
  });
  console.log(label, "helper number:", w);
  let order = "";
  await withSpan("helper.void", {}, async () => {
    await sleep(1);
    order += "inside ";
  });
  order += "after";
  console.log(label, "helper void:", order);
  try {
    await withSpan("helper.throws", {}, async () => {
      await sleep(1);
      throw new Error("failed job");
    });
  } catch (err) {
    console.log(label, "helper rejected:", (err as Error).message);
  }
}

async function main(): Promise<void> {
  await round("off");
  tracer.init({ hostname: "127.0.0.1", port: 1, startupLogs: false, runtimeMetrics: false, plugins: false, flushInterval: 50 });
  await round("on");
}
main();
