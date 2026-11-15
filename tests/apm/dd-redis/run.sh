#!/bin/sh
# dd-trace + ioredis: the redis.command spans inside a trace() span, sent to a fake Datadog Agent and compared with what
# the real dd-trace 5.131.1 (its ioredis integration) sends for the same program on Node (spans.expected; the
# connection's own commands, which Node's ioredis sends and this port does not, are left out). Needs Redis on
# 127.0.0.1:56379 (skips otherwise).
set -e
cd "$(dirname "$0")"
if ! nc -z 127.0.0.1 56379 2>/dev/null; then echo "skip: no Redis on 127.0.0.1:56379"; exit 0; fi
OUT=${OUT:-../../../build/tests/apm-dd-redis}
mkdir -p "$OUT"
"$XISTO" build -o "$OUT/prog" main.ts > "$OUT/build.log" 2>&1 || { cat "$OUT/build.log"; exit 1; }
export DD_SERVICE=shop DD_ENV=test DD_VERSION=1.2.3 DD_TRACE_AGENT_PORT=18126
sh ../run_dd_compare.sh main.ts "$OUT" | grep '"root": "cache.refresh"' > "$OUT/spans.norm" || true
cmp -s "$OUT/prog.out" stdout.expected || { echo "stdout differs"; diff stdout.expected "$OUT/prog.out"; exit 1; }
cmp -s "$OUT/spans.norm" spans.expected || { echo "spans differ"; diff spans.expected "$OUT/spans.norm"; exit 1; }
echo "ok: dd-trace ioredis spans as the real dd-trace's"
