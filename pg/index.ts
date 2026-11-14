// node-postgres: Pool and query(text, values), protocol 3.0 with SCRAM-SHA-256 (native/pg.c).
// A result is an object (JSON) that a typed declaration decodes: const r: QueryResult<Row> = await pool.query(...)
// APM: with an agent started (xisto-apm), each query is a client span "pg.query" (type sql, resource the SQL, db.type
// postgres, db.name, db.user, out.host, network.destination.port), as dd-trace's pg plugin; a failed query marks it.
import { ApmSpanOptions, enabled, newSpan } from "xisto-apm";

export interface PoolConfig {
  host?: string;
  port?: int;
  user?: string;
  password?: string;
  database?: string;
  max?: int;
}

export interface QueryResult<T> {
  rows: T[];
  rowCount: int;
}

declare class NativePool {
  constructor(config: object);
  query(text: string, values: unknown[]): object;
}

export class Pool {
  private native: NativePool;
  private host: string;
  private port: int;
  private user: string;
  private database: string;

  constructor(config: PoolConfig) {
    this.native = new NativePool(config);
    this.host = config.host ?? "localhost";
    this.port = config.port ?? 5432;
    this.user = config.user ?? "";
    this.database = config.database ?? "";
  }

  async query(text: string, values: unknown[]): Promise<object> {
    if (!enabled()) return this.native.query(text, values);
    return this.traced(text, values);
  }

  private traced(text: string, values: unknown[]): object {
    const o = new ApmSpanOptions();
    o.resource = text;
    o.type = "sql";
    o.kind = "client";
    o.component = "pg";
    o.measured = true;
    const span = newSpan("pg.query", o);
    if (span === null) return this.native.query(text, values);
    span.setText("db.type", "postgres");
    if (this.database.length > 0) span.setText("db.name", this.database);
    if (this.user.length > 0) span.setText("db.user", this.user);
    span.setText("out.host", this.host);
    span.setNumber("network.destination.port", this.port);
    try {
      const r = this.native.query(text, values);
      span.finish();
      return r;
    } catch (e) {
      span.setError(e as Error);
      span.finish();
      throw e;
    }
  }
}
