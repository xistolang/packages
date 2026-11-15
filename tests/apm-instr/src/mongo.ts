// mongodb under an agent (XISTO_MONGO_URL): a command, writes and reads of a collection, a failed command.
import { MongoClient } from "mongodb";
import { ApmSpanOptions, newSpan, runIn } from "xisto-apm";
import { startApm } from "./exporter";

async function main(): Promise<void> {
  const ex = startApm();
  const url = process.env.get("XISTO_MONGO_URL") ?? "mongodb://127.0.0.1:27017";
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  ex.mask(client.options.hosts[0].host, "<host>");
  ex.mask(String(client.options.hosts[0].port), "<port>");
  const db = client.db("xisto_apm_test");
  const items = db.collection("items");
  const parent = newSpan("job", new ApmSpanOptions());
  await runIn(parent, async (): Promise<void> => {
    await items.deleteMany({});
    await items.insertOne({ name: "a", n: 1 });
    const found = await items.find({ n: 1 }).toArray();
    console.log("found:", found.length);
  });
  if (parent !== null) parent.finish();
  await db.command({ ping: 1 });
  try {
    await db.command({ noSuchCommand: 1 });
  } catch (e) {
    console.log("failed:", (e as Error).name);
  }
  await client.close();
  await ex.print(false);
}
main();
