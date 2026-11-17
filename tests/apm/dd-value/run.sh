#!/bin/sh
# dd-trace's tracer.trace gives back the callback's value (a number, nothing, a promise; through a generic helper that
# wraps an async callback): main.ts built with xisto, plain and with --tsc-checked (XISTO_TSC_CHECKED=1), must print
# stdout.expected, the same program's output on Node with dd-trace 5.131.1 (tracing off, then on with no Agent there).
cd "$(dirname "$0")/.." || exit 1
. ../env.sh
cd dd-value || exit 1
OUT=$ROOT/build/tests/apm-dd-value
mkdir -p "$OUT"
for m in 0 1; do
  XISTO_TSC_CHECKED=$m $X build -o "$OUT/main$m" main.ts > "$OUT/build$m.txt" 2>&1 || { cat "$OUT/build$m.txt"; exit 1; }
  XISTO_RC_STATS=1 perl -e 'alarm 30; exec @ARGV' "$OUT/main$m" > "$OUT/out$m.txt" 2> "$OUT/stats$m.txt"
  cmp -s stdout.expected "$OUT/out$m.txt" || { echo "FAIL: output differs (XISTO_TSC_CHECKED=$m)"; diff stdout.expected "$OUT/out$m.txt"; exit 1; }
  grep -q ' 0 still alive' "$OUT/stats$m.txt" || { echo "FAIL: leak: $(cat "$OUT/stats$m.txt")"; exit 1; }
done
echo "ok: dd-trace trace() gives back the callback's value, as dd-trace's"
