// oracledb under an agent (XISTO_ORACLE_URL=oracle://user:password@host:port/service): pool and standalone
// connections, binds by position and by name, a failed statement.
import { createPool, getConnection, ConnectionAttributes } from "oracledb";
import { ApmSpanOptions, newSpan, runIn } from "xisto-apm";
import { startApm } from "./exporter";

async function main(): Promise<void> {
  const ex = startApm();
  const url = process.env.get("XISTO_ORACLE_URL") ?? "";
  const rest = url.slice(url.indexOf("//") + 2);
  const at = rest.lastIndexOf("@");
  const cred = rest.slice(0, at);
  const colon = cred.indexOf(":");
  const cs = rest.slice(at + 1);
  const a: ConnectionAttributes = { user: cred.slice(0, colon), password: cred.slice(colon + 1), connectString: cs };
  const hp = cs.slice(0, cs.indexOf("/"));
  ex.mask(cs.slice(cs.indexOf("/") + 1), "<service>");
  ex.mask(hp.slice(0, hp.lastIndexOf(":")), "<host>");
  ex.mask(cred.slice(0, colon), "<user>");
  ex.mask(cred.slice(0, colon).toUpperCase(), "<USER>");
  const pool = await createPool({ user: a.user, password: a.password, connectString: cs, poolMax: 2 });
  const parent = newSpan("job", new ApmSpanOptions());
  await runIn(parent, async (): Promise<void> => {
    const conn = await pool.getConnection();
    await conn.execute("select 1 from dual", []);
    await conn.execute("select :n from dual", { n: 2 });
    await conn.close();
  });
  if (parent !== null) parent.finish();
  const solo = await getConnection(a);
  try {
    await solo.execute("select * from no_such_table", []);
  } catch (e) {
    console.log("failed:", (e as Error).message.slice(0, 9));
  }
  await solo.close();
  await pool.close();
  await ex.print(false);
}
main();
