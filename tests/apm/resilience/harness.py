# An app under an APM agent whose collector is down, hangs, answers 500 after 5 s, or sits behind an address that
# never answers: its requests must all be answered as fast as without the agent, and it must exit within 4 s.
import http.server, os, socket, statistics, subprocess, sys, threading, time, urllib.request
PROG, MODE = sys.argv[1], sys.argv[2]
AGENT = os.environ.get("AGENT", "dd"); DURATION = float(os.environ.get("DURATION", "0"))
APP = 9180
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_PUT(self): self.do_POST()
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); self.rfile.read(n)
        if MODE == "slow500": time.sleep(5); self.send_response(500)
        else: self.send_response(200)
        self.send_header("Content-Length", "0"); self.end_headers()
env = dict(os.environ, PORT=str(APP), DD_TRACE_AGENT_PORT="0")
if MODE == "off": env["DD_TRACE_ENABLED"] = "false"; env["DD_TRACE_AGENT_URL"] = "http://127.0.0.1:1"
elif MODE == "down": env["DD_TRACE_AGENT_URL"] = "http://127.0.0.1:1"
elif MODE == "blackhole": env["DD_TRACE_AGENT_URL"] = "http://10.255.255.1:8126"
elif MODE == "hang":
    ls = socket.socket(); ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); ls.bind(("127.0.0.1", 18199)); ls.listen(512)
    held = []
    def acc():
        while True:
            try: c, _ = ls.accept(); held.append(c)  # accept, never read nor answer
            except OSError: return
    threading.Thread(target=acc, daemon=True).start()
    env["DD_TRACE_AGENT_URL"] = "http://127.0.0.1:18199"
else:  # ok, slow500
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 18198), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env["DD_TRACE_AGENT_URL"] = "http://127.0.0.1:18198"
if AGENT != "dd":
    u = env.pop("DD_TRACE_AGENT_URL")
    if AGENT == "elastic": env["ELASTIC_APM_SERVER_URL"] = u
    else: env["NEW_RELIC_OTLP_URL"] = u + "/v1/traces"; env["NEW_RELIC_LICENSE_KEY"] = "0123456789abcdef0123456789abcdef01234567"; env["NEW_RELIC_NO_CONFIG_FILE"] = "true"
    if MODE == "off": env.pop("NEW_RELIC_LICENSE_KEY", None); env["ELASTIC_APM_ACTIVE"] = "false"
p = subprocess.Popen([PROG], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
for _ in range(100):
    try: socket.create_connection(("127.0.0.1", APP), timeout=0.2).close(); break
    except OSError: time.sleep(0.05)
def rss(): return int(subprocess.run(["ps", "-o", "rss=", "-p", str(p.pid)], capture_output=True, text=True).stdout.strip() or 0) / 1024
lat = []; bad = 0; t0 = time.time(); peak = 0
i = 0
while (i < 2000) if DURATION == 0 else (time.time() - t0 < DURATION):
    i += 1
    s = time.perf_counter()
    try:
        r = urllib.request.urlopen(f"http://127.0.0.1:{APP}/item/{i}", timeout=5).read()
        if r != b"ok": bad += 1
    except Exception: bad += 1
    lat.append((time.perf_counter() - s) * 1000)
    if i % 200 == 0: peak = max(peak, rss())
    if DURATION: time.sleep(0.001)
dur = time.time() - t0; peak = max(peak, rss())
q = time.time()
try: urllib.request.urlopen(f"http://127.0.0.1:{APP}/quit", timeout=5).read()
except Exception: pass
try: p.wait(15); ex = f"exit {p.returncode} in {time.time() - q:.2f}s"
except subprocess.TimeoutExpired: p.kill(); ex = "DID NOT EXIT in 15s (killed)"
lat.sort()
print(f"{AGENT:7s} {MODE:9s} {i} req in {dur:5.2f}s  p50 {statistics.median(lat):6.2f} ms  p99 {lat[int(len(lat)*0.99)]:7.2f} ms  max {lat[-1]:8.2f} ms  "
      f"bad {bad}  peak RSS {peak:5.1f} MB  {ex}  stderr: {p.stderr.read().strip()[:120]!r}")
