// pg under an agent: queries inside a parent span and on their own, and a failed one.
import { Pool } from "pg";
import { ApmSpanOptions, newSpan, runIn } from "xisto-apm";
import { startApm } from "./exporter";

async function main(): Promise<void> {
  const ex = startApm();
  const port = Number(process.env.get("PGPORT_TEST") ?? "55432");
  const pool = new Pool({ host: "127.0.0.1", port: Math.trunc(port), user: "xisto", password: "xisto", database: "conduit", max: 2 });
  const parent = newSpan("job", new ApmSpanOptions());
  await runIn(parent, async (): Promise<void> => {
    await pool.query("SELECT 1 AS n", []);
    await pool.query("SELECT $1::text AS s", ["a"]);
  });
  if (parent !== null) parent.finish();
  await pool.query("SELECT 2 AS n", []);
  try {
    await pool.query("SELECT * FROM no_such_table", []);
  } catch (e) {
    console.log("failed:", (e as Error).message);
  }
  await ex.print(false);
}
main();
