#!/bin/sh
# The agents must never hurt the program (Isa, 14 Nov 2026): for dd-trace, elastic-apm-node and newrelic (the OTLP
# exporter of xisto-apm, shared with dynatrace and appdynamics), with the collector down, hanging, slow with 500s, or
# behind an address that never answers, every request is answered, none waits on the collector, and the program
# exits within 4 s.
cd "$(dirname "$0")/.." || exit 1
. ../env.sh
cd resilience || exit 1
OUT=$ROOT/build/tests/apm-resilience
mkdir -p "$OUT"
fail=0
for a in dd elastic newrelic; do
  $X build -o "$OUT/$a" $a.ts > "$OUT/$a-build.txt" 2>&1 || { cat "$OUT/$a-build.txt"; exit 1; }
  ag=$a; [ $a = newrelic ] && ag=nr
  for m in down hang slow500 blackhole; do
    line=$(AGENT=$ag python3 -I harness.py "$OUT/$a" $m 2>&1)
    echo "$line" > "$OUT/$a-$m.txt"
    bad=$(echo "$line" | sed -nE 's/.* bad ([0-9]+) .*/\1/p')
    ex=$(echo "$line" | sed -nE 's/.*exit 0 in ([0-9.]+)s.*/\1/p')
    if [ "$bad" != 0 ] || [ -z "$ex" ] || [ "$(echo "$ex > 4" | bc)" = 1 ]; then echo "FAIL: $a with the collector $m: $line"; fail=1; fi
  done
done
[ $fail = 0 ] && echo "ok: resilience (dd-trace, elastic-apm-node, newrelic: collector down, hanging, slow, unreachable; no request lost, exit within 4 s)"
exit $fail
