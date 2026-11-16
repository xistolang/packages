#!/usr/bin/env python3
"""Errors and limits, end to end: a global @Catch() filter that reads each exception's body (an object, or the text
ThrottlerException and new HttpException("text") carry), the throttler's headers and its 429, Nest's 404 for what no
route takes, HEAD and a trailing slash as Express routes them, and the lines a logging interceptor (rxjs tap and
catchError) writes while the server runs. One line per request: method, path, the status line, the headers that
matter and the body as sent; then the interceptor's lines as the server's output had them.
Run it against the Node build and the xisto build of the same source and compare the outputs.
Usage: scenario.py http://127.0.0.1:3196 SERVER_OUTPUT_FILE"""
import http.client, re, sys, time, urllib.parse

BASE = urllib.parse.urlparse(sys.argv[1])
LOG = sys.argv[2]
HEADERS = ["content-type", "content-length", "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]

def call(method, path):
    conn = http.client.HTTPConnection(BASE.hostname, BASE.port, timeout=10)
    conn.request(method, path)
    r = conn.getresponse()
    body = r.read().decode()
    shown = []
    for h in HEADERS:
        v = r.getheader(h)
        if v is not None:
            shown.append(f"{h}={v.lower().replace(' ', '') if h == 'content-type' else v}")
    conn.close()
    print(f"{method} {path} {r.status} {r.reason} [{'; '.join(shown)}] {body!r}")

call("GET", "/api/health")
call("GET", "/api/items")
call("GET", "/api/items")
call("GET", "/api/items")
call("GET", "/api/items")
call("GET", "/api/items/1?x=1&y=%20z")
call("GET", "/api/items/2")
call("GET", "/api/items/boom")
call("GET", "/api/items/plain")
call("GET", "/api/items/invalid")
call("GET", "/api/nope")
call("GET", "/api/nope?x=1")
call("POST", "/api/items")
call("DELETE", "/api/items/1")
call("GET", "/nope")
call("HEAD", "/api/health")
call("HEAD", "/api/items/1")
call("GET", "/api/health/")
call("GET", "/api/items/1/")

# what the interceptor wrote, read while the server still runs (a server that waits for the next request has
# written its lines out, as Node's has)
time.sleep(0.5)
ansi = re.compile(r"\x1b\[[0-9;]*m")
with open(LOG, encoding="utf-8") as f:
    for line in f:
        line = ansi.sub("", line.rstrip("\n"))
        m = re.match(r"^\[Nest\] \d+\s+- .*?\s+(LOG|WARN|ERROR) (\[HTTP\] .*)$", line)
        if m:
            print("log", m.group(1), m.group(2))
