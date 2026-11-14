#!/bin/sh
# usage: run_dd_compare.sh PROGRAM.ts XISTO_BINARY_OUT_DIR : runs the xisto build of PROGRAM against the fake Agent and
# prints the normalized spans (the expected file is the same for the program on Node with the real dd-trace)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$2; mkdir -p "$OUT"
rm -f "$OUT/dd.jsonl"
python3 -I "$HERE/collectors.py" "$OUT/dd.jsonl" 18126 18200 14318 > "$OUT/coll.log" 2>&1 &
CP=$!
sleep 0.5
APM_DD_PORT=18126 "$OUT/prog" > "$OUT/prog.out" 2>&1 || true
sleep 0.3
kill $CP 2>/dev/null || true
python3 -I "$HERE/normalize_dd.py" "$OUT/dd.jsonl"
