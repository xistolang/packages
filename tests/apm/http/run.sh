#!/bin/sh
# dd-trace with node:http (server and client) and fetch, through node:diagnostics_channel: the spans, sent to a fake
# Datadog Agent and normalized (ports out; Node's own TCP spans and user agents out), compared with what the real
# dd-trace 5.131.1 sends for the same program on Node (its http and fetch integrations)
set -e
cd "$(dirname "$0")"
OUT=${OUT:-../../../build/tests/apm-http}
mkdir -p "$OUT"
"$XISTO" build -o "$OUT/prog" main.ts > "$OUT/build.log" 2>&1 || { cat "$OUT/build.log"; exit 1; }
export DD_SERVICE=shop DD_ENV=test DD_VERSION=1.2.3 DD_TRACE_AGENT_PORT=18126
sh ../run_dd_compare.sh main.ts "$OUT" | sed -E 's/127\.0\.0\.1:[0-9]+/127.0.0.1:PORT/g; s/"network.destination.port": [0-9]+/"network.destination.port": "P"/g' > "$OUT/spans.norm"
cmp -s "$OUT/prog.out" stdout.expected || { echo "stdout differs"; diff stdout.expected "$OUT/prog.out"; exit 1; }
cmp -s "$OUT/spans.norm" spans.expected || { echo "spans differ"; diff spans.expected "$OUT/spans.norm"; exit 1; }
echo "ok: http and fetch spans as the real dd-trace's"
