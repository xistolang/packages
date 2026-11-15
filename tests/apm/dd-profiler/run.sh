#!/bin/sh
# dd-trace's profiler: tracer.init({ profiling: true }) in a CPU-bound app (main.ts), uploads every second
# (DD_PROFILING_UPLOAD_PERIOD=1) to a fake Datadog Agent. The first upload's event.json, normalized
# (normalize_dd_profile.py), is compared with what the real dd-trace 5.131.1 sends for the same program on Node
# (event.expected: main.ts run by Node 26 with dd-trace 5.131.1 against collectors.py, then normalized); the profile
# itself must be a gzip pprof of CPU time whose functions include the app's hot one. Then agentless: the same
# multipart to the intake's /api/v2/profile with DD-API-KEY (DD_PROFILING_INTAKE_URL points it at the fake), and
# no upload at all when DD_API_KEY is missing.
cd "$(dirname "$0")/.." || exit 1
. ../env.sh
. ./lib.sh
cd dd-profiler || exit 1
OUT=$ROOT/build/tests/apm-dd-profiler
mkdir -p "$OUT"
$X build -o "$OUT/prog" main.ts > "$OUT/build.log" 2>&1 || { cat "$OUT/build.log"; exit 1; }

collectors agent
APM_DD_PORT=$DDPORT DD_PROFILING_UPLOAD_PERIOD=1 APP_SECONDS=2.5 "$OUT/prog" > "$OUT/prog.out" 2>&1
sleep 0.3
python3 -I ../normalize_dd_profile.py "$OUT/agent.jsonl" > "$OUT/event.norm" || { echo "FAIL: $(cat "$OUT/event.norm")"; exit 1; }
cmp -s "$OUT/event.norm" event.expected || { echo "FAIL: the event differs from dd-trace's"; diff event.expected "$OUT/event.norm"; exit 1; }
# the profiles: gzip pprof, CPU time, the hot function, one upload per second numbered from 0
python3 -I - "$OUT/agent.jsonl" <<'EOF' || { echo "FAIL: the profiles (agent)"; exit 1; }
import json, sys
recs = [json.loads(l) for l in open(sys.argv[1])]
profs = [r for r in recs if r["kind"] == "dd-profile"]
assert len(profs) >= 2, "uploads: %d" % len(profs)
seqs = [int(t.split(":")[1]) for r in profs for t in r["event"]["tags_profiler"].split(",") if t.startswith("profile_seq:")]
assert seqs == list(range(len(profs))), seqs
hot = 0
for r in profs:
    assert [f["name"] for f in r["files"]] == ["cpu.pprof"] and r["event"]["attachments"] == ["cpu.pprof"], r["files"]
    f = r["files"][0]
    assert f["filename"] == "cpu.pprof" and f["content_type"] == "application/octet-stream" and f["compression"] == "gzip", f
    assert f["pprof"]["sample_types"] == [["sample", "count"], ["cpu", "nanoseconds"]], f["pprof"]
    hot += "checksum" in f["pprof"]["functions"]
assert hot >= len(profs) - 1, "checksum in %d of %d profiles" % (hot, len(profs))
assert not any(r["kind"] == "dd" and any(s.get("meta", {}).get("http.url", "").endswith("/profiling/v1/input") for t in r["traces"] for s in t) for r in recs), "the upload was traced"
EOF

collectors agentless
APM_DD_PORT=1 DD_PROFILING_UPLOAD_PERIOD=1 APP_SECONDS=1.2 DD_PROFILING_AGENTLESS=true DD_API_KEY=xisto-test-key \
  DD_PROFILING_INTAKE_URL="http://127.0.0.1:$DDPORT/api/v2/profile" "$OUT/prog" > "$OUT/agentless.out" 2>&1
sleep 0.3
python3 -I - "$OUT/agentless.jsonl" <<'EOF' || { echo "FAIL: agentless"; exit 1; }
import json, sys
profs = [json.loads(l) for l in open(sys.argv[1])]
profs = [r for r in profs if r["kind"] == "dd-profile"]
assert profs, "agentless: no upload"
for r in profs:
    assert r["path"] == "/api/v2/profile" and r["headers"].get("dd-api-key") == "<present>", (r["path"], r["headers"])
    assert r["files"][0]["pprof"]["sample_types"] == [["sample", "count"], ["cpu", "nanoseconds"]]
EOF
APM_DD_PORT=1 DD_PROFILING_UPLOAD_PERIOD=1 APP_SECONDS=0.2 DD_PROFILING_AGENTLESS=true DD_API_KEY= "$OUT/prog" > "$OUT/nokey.out" 2>&1
grep -q "DD_PROFILING_AGENTLESS needs DD_API_KEY" "$OUT/nokey.out" || { echo "FAIL: no message without DD_API_KEY"; cat "$OUT/nokey.out"; exit 1; }
echo "ok: dd-trace profiles as the real dd-trace's (agent and agentless)"
