#!/usr/bin/env python3
# Fake APM collectors for the tests: a Datadog Agent (PUT/POST /v0.4/traces, msgpack or JSON), an Elastic APM Server
# (POST /intake/v2/events, ndjson, gzip or deflate or plain) and an OTLP/HTTP receiver (POST /v1/traces, JSON).
# Every payload received is appended, decoded, as one JSON line to OUT ({"kind": "dd" | "elastic" | "otlp", ...}).
# usage: collectors.py OUT DD_PORT ELASTIC_PORT OTLP_PORT   (prints "ready" when listening)
import gzip, json, sys, threading, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OUT = sys.argv[1]
lock = threading.Lock()


def record(obj):
    with lock, open(OUT, "a") as f:
        f.write(json.dumps(obj, sort_keys=True) + "\n")


def unpack(data):
    """msgpack, the subset the Datadog Agent API uses (no extension types)"""
    pos = 0

    def rd(n):
        nonlocal pos
        b = data[pos:pos + n]
        pos += n
        return b

    def val():
        c = rd(1)[0]
        if c <= 0x7F: return c
        if c >= 0xE0: return c - 0x100
        if 0x80 <= c <= 0x8F: return {val(): val() for _ in range(c & 0x0F)}
        if 0x90 <= c <= 0x9F: return [val() for _ in range(c & 0x0F)]
        if 0xA0 <= c <= 0xBF: return rd(c & 0x1F).decode("utf-8", "replace")
        if c == 0xC0: return None
        if c == 0xC2: return False
        if c == 0xC3: return True
        if c in (0xC4, 0xC5, 0xC6): return rd(int.from_bytes(rd(1 << (c - 0xC4)), "big")).hex()
        if c == 0xCA: import struct; return struct.unpack(">f", rd(4))[0]
        if c == 0xCB: import struct; return struct.unpack(">d", rd(8))[0]
        if 0xCC <= c <= 0xCF: return int.from_bytes(rd(1 << (c - 0xCC)), "big")
        if 0xD0 <= c <= 0xD3: return int.from_bytes(rd(1 << (c - 0xD0)), "big", signed=True)
        if c in (0xD9, 0xDA, 0xDB): return rd(int.from_bytes(rd(1 << (c - 0xD9)), "big")).decode("utf-8", "replace")
        if c in (0xDC, 0xDD): return [val() for _ in range(int.from_bytes(rd(2 if c == 0xDC else 4), "big"))]
        if c in (0xDE, 0xDF):
            n = int.from_bytes(rd(2 if c == 0xDE else 4), "big")
            return {val(): val() for _ in range(n)}
        raise ValueError("msgpack type 0x%02x" % c)

    return val()


def make_handler(kind):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n:
                data = self.rfile.read(n)
            elif self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                data = b""
                while True:
                    size = int(self.rfile.readline().strip() or b"0", 16)
                    if size == 0:
                        self.rfile.readline()
                        break
                    data += self.rfile.read(size)
                    self.rfile.readline()
            else:
                data = b""
            enc = self.headers.get("Content-Encoding", "")
            if enc == "gzip": data = gzip.decompress(data)
            elif enc == "deflate": data = zlib.decompress(data)
            return data

        def reply(self, code, obj):
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            if kind == "elastic" and self.path.split("?")[0] in ("/", ""):
                return self.reply(200, {"version": "8.15.0", "build_date": "2024-01-01T00:00:00Z", "build_sha": "x"})
            if kind == "elastic" and self.path.startswith("/config/v1/agents"):
                return self.reply(200, {})
            if kind == "dd" and self.path == "/info":
                return self.reply(404, {})
            self.reply(404, {})

        def handle_any(self):
            data = self.body()
            path = self.path.split("?")[0]
            hdr = {k.lower(): v for k, v in self.headers.items() if k.lower() in ("content-type", "api-key", "authorization", "x-datadog-trace-count", "datadog-meta-lang")}
            if kind == "dd" and path.startswith("/v0.4/traces"):
                ct = self.headers.get("Content-Type", "")
                traces = json.loads(data) if "json" in ct else unpack(data)
                record({"kind": "dd", "path": path, "headers": hdr, "traces": traces})
                return self.reply(200, {"rate_by_service": {}})
            if kind == "elastic" and path == "/intake/v2/events":
                events = [json.loads(l) for l in data.decode().splitlines() if l.strip()]
                record({"kind": "elastic", "headers": hdr, "events": events})
                return self.reply(202, {})
            if kind == "otlp" and path == "/v1/traces":
                record({"kind": "otlp", "headers": hdr, "body": json.loads(data or b"{}")})
                return self.reply(200, {})
            self.reply(404 if kind != "dd" else 200, {})

        do_POST = handle_any
        do_PUT = handle_any

    return H


servers = []
for kind, port in (("dd", int(sys.argv[2])), ("elastic", int(sys.argv[3])), ("otlp", int(sys.argv[4]))):
    s = ThreadingHTTPServer(("127.0.0.1", port), make_handler(kind))
    threading.Thread(target=s.serve_forever, daemon=True).start()
    servers.append(s)
print("ready", flush=True)
threading.Event().wait()
