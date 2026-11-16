// callTimeout: a round trip that runs past it is broken off (an in-band break, then a reset of the channel; the
// server answers it with ORA-01013 once its current operation yields, here when the sleep ends) and fails with
// NJS-123; the session stays usable, on a standalone connection and on a pooled one (whose callTimeout a
// sessionCallback set). Same lines as node-oracledb 6 thin.
import { createPool, getConnection, type Result, type ConnectionAttributes } from "oracledb";

function attrs(): ConnectionAttributes {
  const url = process.env.get("XISTO_ORACLE_URL") ?? "";
  const rest = url.slice(url.indexOf("//") + 2);
  const at = rest.lastIndexOf("@");
  const cred = rest.slice(0, at);
  const colon = cred.indexOf(":");
  return { user: cred.slice(0, colon), password: cred.slice(colon + 1), connectString: rest.slice(at + 1) };
}

async function main(): Promise<void> {
  const a = attrs();
  const conn = await getConnection(a);
  console.log(`callTimeout ${conn.callTimeout}`);
  conn.callTimeout = 700;
  const fast: Result<number[]> = await conn.execute("select 40 + :1 from dual", [2]);
  console.log(`fast query under the limit: ${fast.rows[0][0]}`);
  let t0 = Date.now();
  try {
    await conn.execute("begin dbms_session.sleep(3); end;");
    console.log("slow block: finished (wrong)");
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`slow block: ${(e as Error).message}`);
    console.log(`  not before the limit: ${ms >= 700}`);
  }
  const after: Result<string[]> = await conn.execute("select 'still usable' from dual");
  console.log(`same connection afterwards: ${after.rows[0][0]}`);
  await conn.execute("begin execute immediate 'drop table xisto_ct purge'; exception when others then null; end;");
  await conn.execute("create table xisto_ct (n number)");
  try {
    await conn.execute("insert into xisto_ct values (1)");
    try {
      await conn.execute("begin dbms_session.sleep(2); end;");
    } catch (e) {
      console.log(`inside a transaction: ${(e as Error).message}`);
    }
    await conn.commit();
    const n: Result<number[]> = await conn.execute("select count(*) from xisto_ct");
    console.log(`the insert before it is kept and committed: ${n.rows[0][0]}`);
  } finally {
    await conn.execute("drop table xisto_ct purge");
  }
  conn.callTimeout = 0;
  t0 = Date.now();
  await conn.execute("begin dbms_session.sleep(1); end;");
  console.log(`callTimeout 0: no limit, the 1 s block ends: ${Date.now() - t0 >= 900}`);
  await conn.close();

  const pool = await createPool({
    user: a.user, password: a.password, connectString: a.connectString, poolMin: 0, poolMax: 1,
    sessionCallback: (connection: { callTimeout: number }, requestedTag: string, cb: (err?: Error) => void) => {
      connection.callTimeout = 500;
      cb();
    },
  });
  for (let i = 0; i < 2; i++) {
    const c = await pool.getConnection();
    try {
      await c.execute("begin dbms_session.sleep(2); end;");
      console.log(`pool checkout ${i}: finished (wrong)`);
    } catch (e) {
      console.log(`pool checkout ${i}: ${(e as Error).message}`);
    }
    const r: Result<number[]> = await c.execute("select :1 * 2 from dual", [i + 1]);
    console.log(`  then: ${r.rows[0][0]}`);
    await c.close();
  }
  await pool.close();
}
main();
