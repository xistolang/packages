#!/bin/sh
# dd-trace: the manual API's spans, sent to a fake Datadog Agent, normalized (tests/apm/normalize_dd.py) and compared
# with what the same program sends with the real dd-trace 5.131.1 on Node (spans.expected, stdout.expected)
set -e
cd "$(dirname "$0")"
OUT=${OUT:-../../../build/tests/apm-dd}
mkdir -p "$OUT"
"$XISTO" build -o "$OUT/prog" main.ts > "$OUT/build.log" 2>&1 || { cat "$OUT/build.log"; exit 1; }
sh ../run_dd_compare.sh main.ts "$OUT" > "$OUT/spans.norm" 2>/dev/null
cmp -s "$OUT/prog.out" stdout.expected || { echo "stdout differs"; diff stdout.expected "$OUT/prog.out"; exit 1; }
cmp -s "$OUT/spans.norm" spans.expected || { echo "spans differ"; diff spans.expected "$OUT/spans.norm"; exit 1; }
XISTO_RC_STATS=1 APM_DD_PORT=1 "$OUT/prog" > /dev/null 2> "$OUT/stats" || true
grep -q ' 0 still alive' "$OUT/stats" || { echo "leak: $(cat "$OUT/stats")"; exit 1; }
echo "ok: dd-trace spans as the real dd-trace's"
