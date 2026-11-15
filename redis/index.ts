// redis (node-redis v4): createClient({ url }), connect(), then await client.get/set/del/... as in Node.
// RESP2 over TCP in native/redis.c, with a connection pool per worker thread. Server errors are thrown Errors.
// APM: with an agent started (xisto-apm), each command is a client span "redis.command" (type redis, resource the
// command, db.type redis, redis.raw_command, out.host, network.destination.port), as dd-trace's redis plugin; an
// error marks it. ioredis makes its spans with redisSpan() and endSpan() below.
import { ApmSpan, ApmSpanOptions, newSpan } from "xisto-apm";
import { enabled } from "xisto-apm";
export interface RedisSocketOptions {
  host?: string;
  port?: int;
  reconnectStrategy?: boolean;
}

export interface RedisClientOptions {
  url?: string;
  username?: string;
  password?: string;
  database?: int;
  socket?: RedisSocketOptions;
}

export interface SetOptions {
  EX?: int;
  PX?: int;
  NX?: boolean;
  XX?: boolean;
}

/**
 * The connection the clients of this package and of ioredis share (native/redis.c): RESP2 over TCP, pipelined, one
 * connection per worker thread. The config is the options object, read as JSON (url, host, port, db/database,
 * username, password, connectTimeout, commandTimeout, socket: { host, port, connectTimeout }). Every command
 * throws: a server error with the server's text, a refused or lost connection, or "Command timed out".
 */
export declare class NativeRedis {
  constructor(config: object);
  connect(): void;
  str(args: string[]): string | null;
  int(args: string[]): int;
  strs(args: string[]): string[];
  strsn(args: string[]): (string | null)[];
  /** any reply as JSON text: integers as numbers, nil as null, arrays as arrays */
  json(args: string[]): string;
  /** whether the connection is open (a failed connection or a lost one leaves it closed) */
  isOpen(): boolean;
  close(): void;
}


/** (APM) the server of a client's options: [host, port] from url, host/port or socket */
export function redisServer(url: string | null, host: string | null, port: int): [string, int] {
  let h = host ?? "localhost";
  let p = port > 0 ? port : 6379;
  if (url !== null && url.length > 0) {
    let rest = url.slice(url.indexOf("//") + 2);
    const at = rest.lastIndexOf("@");
    if (at >= 0) rest = rest.slice(at + 1);
    const slash = rest.indexOf("/");
    if (slash >= 0) rest = rest.slice(0, slash);
    const colon = rest.lastIndexOf(":");
    if (colon >= 0) {
      h = rest.slice(0, colon);
      p = Math.trunc(Number(rest.slice(colon + 1)));
    } else if (rest.length > 0) {
      h = rest;
    }
  }
  return [h, p];
}

// dd-trace's redis.raw_command: the command and its arguments (each cut at 100 characters, the whole at 1000)
function rawCommand(args: string[]): string {
  let out = args.length > 0 ? args[0].toUpperCase() : "";
  if (out === "AUTH") return out;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    out = out + " " + (a.length > 100 ? a.slice(0, 97) + "..." : a);
    if (out.length > 1000) return out.slice(0, 997) + "...";
  }
  return out;
}

/** (APM) starts the "redis.command" span of one command (null with no agent); resource is the command as the
 * client names it (redis: GET, ioredis: get). */
export function redisSpan(component: string, resource: string, args: string[], host: string, port: int): ApmSpan | null {
  const o = new ApmSpanOptions();
  o.resource = resource;
  o.type = "redis";
  o.kind = "client";
  o.component = component;
  o.measured = true;
  const span = newSpan("redis.command", o);
  if (span === null) return null;
  span.setText("db.type", "redis");
  span.setText("redis.raw_command", rawCommand(args));
  span.setText("out.host", host);
  span.setNumber("network.destination.port", port);
  return span;
}

/** (APM) ends a command's span; err (when the command failed) marks it. */
export function endSpan(span: ApmSpan | null, err: Error | null): void {
  if (span === null) return;
  if (err !== null) span.setError(err);
  span.finish();
}

export class RedisClient {
  private readonly native: NativeRedis;
  isOpen: boolean = false;
  isReady: boolean = false;

  private readonly server: [string, int];

  constructor(options: RedisClientOptions) {
    this.native = new NativeRedis(options);
    const sock = options.socket;
    this.server = redisServer(options.url ?? null, sock !== undefined && sock !== null ? sock.host ?? null : null, sock !== undefined && sock !== null ? sock.port ?? 0 : 0);
  }

  // the native calls, each a span under an agent
  private str(args: string[]): string | null {
    if (!enabled()) return this.native.str(args);
    const span = redisSpan("redis", args[0], args, this.server[0], this.server[1]);
    try {
      const r = this.native.str(args);
      endSpan(span, null);
      return r;
    } catch (e) {
      endSpan(span, e as Error);
      throw e;
    }
  }
  private int(args: string[]): int {
    if (!enabled()) return this.native.int(args);
    const span = redisSpan("redis", args[0], args, this.server[0], this.server[1]);
    try {
      const r = this.native.int(args);
      endSpan(span, null);
      return r;
    } catch (e) {
      endSpan(span, e as Error);
      throw e;
    }
  }
  private strs(args: string[]): string[] {
    if (!enabled()) return this.native.strs(args);
    const span = redisSpan("redis", args[0], args, this.server[0], this.server[1]);
    try {
      const r = this.native.strs(args);
      endSpan(span, null);
      return r;
    } catch (e) {
      endSpan(span, e as Error);
      throw e;
    }
  }
  private strsn(args: string[]): (string | null)[] {
    if (!enabled()) return this.native.strsn(args);
    const span = redisSpan("redis", args[0], args, this.server[0], this.server[1]);
    try {
      const r = this.native.strsn(args);
      endSpan(span, null);
      return r;
    } catch (e) {
      endSpan(span, e as Error);
      throw e;
    }
  }

  // node-redis reports connection errors as events; here every command throws them, so listeners are not called
  on(event: string, listener: (err: Error) => void): RedisClient {
    return this;
  }

  async connect(): Promise<RedisClient> {
    this.native.connect();
    this.isOpen = true;
    this.isReady = true;
    return this;
  }

  async ping(): Promise<string> {
    const r = this.str(["PING"]);
    return r || "";
  }

  async get(key: string): Promise<string | null> {
    return this.str(["GET", key]);
  }

  async set(key: string, value: string, options?: SetOptions): Promise<string | null> {
    const args: string[] = ["SET", key, value];
    if (options !== null) {
      const ex = options.EX;
      const px = options.PX;
      if (ex !== null) {
        args.push("EX");
        args.push(`${ex}`);
      }
      if (px !== null) {
        args.push("PX");
        args.push(`${px}`);
      }
      if (options.NX === true) {
        args.push("NX");
      }
      if (options.XX === true) {
        args.push("XX");
      }
    }
    return this.str(args);
  }

  async del(key: string): Promise<number> {
    return Number(this.int(["DEL", key]));
  }

  async exists(key: string): Promise<number> {
    return Number(this.int(["EXISTS", key]));
  }

  async incr(key: string): Promise<number> {
    return Number(this.int(["INCR", key]));
  }

  async incrBy(key: string, by: int): Promise<number> {
    return Number(this.int(["INCRBY", key, `${by}`]));
  }

  async expire(key: string, seconds: int): Promise<boolean> {
    return this.int(["EXPIRE", key, `${seconds}`]) === 1;
  }

  async ttl(key: string): Promise<number> {
    return Number(this.int(["TTL", key]));
  }

  async mGet(keys: string[]): Promise<(string | null)[]> {
    const args: string[] = ["MGET"];
    for (const k of keys) {
      args.push(k);
    }
    return this.strsn(args);
  }

  async keys(pattern: string): Promise<string[]> {
    return this.strs(["KEYS", pattern]);
  }

  async flushDb(): Promise<string> {
    const r = this.str(["FLUSHDB"]);
    return r || "";
  }

  // any command, for what the typed methods do not cover: string replies (integers as text), or null
  async sendCommand(args: string[]): Promise<string | null> {
    return this.str(args);
  }

  async quit(): Promise<string> {
    this.native.close();
    this.isOpen = false;
    this.isReady = false;
    return "OK";
  }

  async disconnect(): Promise<void> {
    this.native.close();
    this.isOpen = false;
    this.isReady = false;
  }
}

export function createClient(options: RedisClientOptions = {}): RedisClient {
  return new RedisClient(options);
}
