// @elastic/elasticsearch under an agent, against the fake cluster of tests/elasticsearch (server.mjs, port in
// argv[2]): an index, a get, a search inside a parent span, and a call that fails (404).
import { Client } from "@elastic/elasticsearch";
import { ApmSpanOptions, newSpan, runIn } from "xisto-apm";
import { startApm } from "./exporter";

async function main(): Promise<void> {
  const ex = startApm();
  const client = new Client({ node: `http://127.0.0.1:${process.argv[2]}`, maxRetries: 0 });
  const parent = newSpan("job", new ApmSpanOptions());
  await runIn(parent, async (): Promise<void> => {
    await client.index({ index: "items", id: "42", document: { name: "a" }, refresh: true });
    await client.search({ index: "items", query: { match: { name: "a" } } });
  });
  if (parent !== null) parent.finish();
  try {
    await client.get({ index: "nope", id: "7" });
  } catch (e) {
    console.log("failed:", (e as Error).name);
  }
  await ex.print(false);
}
main();
