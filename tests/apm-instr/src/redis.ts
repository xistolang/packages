// redis and ioredis under an agent (Redis on 127.0.0.1:56379): commands inside a parent span and on their own, a
// pipeline, a failed command.
import { createClient } from "redis";
import Redis from "ioredis";
import { ApmSpanOptions, newSpan, runIn } from "xisto-apm";
import { startApm } from "./exporter";

async function main(): Promise<void> {
  const ex = startApm();
  const c = createClient({ url: "redis://127.0.0.1:56379" });
  await c.connect();
  const parent = newSpan("job", new ApmSpanOptions());
  await runIn(parent, async (): Promise<void> => {
    await c.set("apm:k", "v1");
    console.log("get:", await c.get("apm:k"));
    await c.del("apm:k");
  });
  if (parent !== null) parent.finish();
  const r = new Redis({ host: "127.0.0.1", port: 56379 });
  await r.set("apm:i", "1");
  await r.incr("apm:i");
  const res = await r.pipeline().get("apm:i").del("apm:i").exec();
  console.log("pipeline:", res === null ? 0 : res.length);
  try {
    await r.call("NOSUCHCMD", "x");
  } catch (e) {
    console.log("failed:", (e as Error).name);
  }
  await r.quit();
  await c.quit();
  await ex.print(false);
}
main();
