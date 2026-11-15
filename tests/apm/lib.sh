# Sourced by the APM tests (tests/apm/NAME/run.sh, from tests/apm after ../env.sh): collectors PREFIX starts the fake collectors
# (collectors.py) on free ports, recording into $OUT/PREFIX.jsonl, and sets DDPORT, ELPORT, OTLPPORT; they stop when
# the test exits.
collectors() {
  if [ -n "$CPID" ]; then kill $CPID 2>/dev/null; wait $CPID 2>/dev/null; fi
  sec=$(date +%S); sec=${sec#0} # ("08" and "09" are not octal numbers: without the zero)
  base=$((20000 + ($$ * 7 + sec * 13 + ${CN:-0} * 101) % 30000)); CN=$((${CN:-0} + 1))
  DDPORT=$base; ELPORT=$((base + 1)); OTLPPORT=$((base + 2))
  rm -f "$OUT/$1.jsonl"
  python3 -I "$ROOT/tests/apm/collectors.py" "$OUT/$1.jsonl" $DDPORT $ELPORT $OTLPPORT > "$OUT/$1-collectors.txt" 2>&1 &
  CPID=$!
  trap 'kill $CPID 2>/dev/null' EXIT
  i=0
  until grep -q ready "$OUT/$1-collectors.txt" 2>/dev/null; do
    i=$((i + 1)); [ $i -gt 300 ] && { echo "FAIL: the fake collectors did not start: $(cat "$OUT/$1-collectors.txt")"; exit 1; }
    sleep 0.1
  done
}
# normalized RECORDED KIND OUTFILE: the payloads normalized (normalize.py)
normalized() {
  python3 -I "$ROOT/tests/apm/normalize.py" "$1" "$2" > "$3" || { echo "FAIL: normalize $1"; exit 1; }
}
