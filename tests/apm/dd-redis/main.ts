// dd-trace with ioredis: the redis.command spans (service "<service>-redis", resource, tags) under a trace() span, as
// the real dd-trace's ioredis integration makes them. Config from DD_* (Node: dd-trace/initialize.mjs reads them).
import tracer from "dd-trace";
import Redis from "ioredis";

tracer.init({ flushInterval: 50, startupLogs: false, runtimeMetrics: false });

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const r = new Redis({ host: "127.0.0.1", port: 56379 });
  await tracer.trace("cache.refresh", { resource: "refresh" }, async () => {
    await r.set("apm:k", "v1");
    const v = await r.get("apm:k");
    console.log("got", v);
    await r.del("apm:k");
  });
  await r.quit();
  await sleep(400);
}
main();
