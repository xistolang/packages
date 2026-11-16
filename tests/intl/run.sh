#!/bin/sh
# intl: Intl.NumberFormat, Intl.DateTimeFormat, Intl.Collator and toLocaleString / localeCompare with a locale, as
# Node 26 (ICU 78) prints them (*.expected: the same programs on Node, TZ=America/New_York), with no leak; and only
# what a program uses compiled into it (size/: a program that uses no Intl has none of the package, one that uses
# NumberFormat has no DateTimeFormat or Collator data, and the other way round).
cd "$(dirname "$0")" || exit 1
. ../../tests/env.sh
OUT=$ROOT/build/tests/intl
mkdir -p "$OUT"
# a xisto that has Intl built in (0.4.5 and before) does not take it from this package
if ! $X build --no-warnings -o "$OUT/probe" size/probe.ts > "$OUT/probe.txt" 2>&1; then
  echo "skip: this xisto does not take Intl from the intl package (Intl built in): $(head -1 "$OUT/probe.txt")"
  exit 0
fi
fail=0
for t in number datetime collator; do
  if ! $X build --no-warnings -o "$OUT/$t" src/$t.ts > "$OUT/$t.build" 2>&1; then echo "FAIL intl $t: build"; head -20 "$OUT/$t.build"; fail=1; continue; fi
  XISTO_RC_STATS=1 "$OUT/$t" > "$OUT/$t.out" 2> "$OUT/$t.stats"
  if ! cmp -s "$OUT/$t.out" $t.expected; then echo "FAIL intl $t"; diff $t.expected "$OUT/$t.out" | head -20; fail=1
  elif ! grep -q ' 0 still alive' "$OUT/$t.stats"; then echo "FAIL intl $t: leak: $(tail -1 "$OUT/$t.stats")"; fail=1
  else echo "ok intl $t"; fi
done
# has BINARY TEXT: the program holds that text (a string of the generated data)
has() { LC_ALL=C grep -a -F -q "$2" "$1"; } # (bytes: a binary is not valid UTF-8 text)
for t in none number datetime; do
  $X build --no-warnings -o "$OUT/size-$t" size/$t.ts > "$OUT/size-$t.build" 2>&1 || { echo "FAIL intl size/$t: build"; head "$OUT/size-$t.build"; fail=1; }
done
NUM=';BRL=R$'                     # data/number.ts: the currency symbols
DT='janeiro|fevereiro'             # data/datetime.ts: pt-BR's month names
EN='January|February'              # ... en-US's
ZN='Horário Padrão de Brasília'     # ... the zone names
COLL='#$###*###1##'                 # data/collation.ts: the weights (the table's start)
bytes() { wc -c < "$1" | tr -d ' '; }
sizes="none $(bytes "$OUT/size-none"), number $(bytes "$OUT/size-number"), datetime $(bytes "$OUT/size-datetime") bytes"
if has "$OUT/size-none" "$NUM" || has "$OUT/size-none" "$DT" || has "$OUT/size-none" "$COLL"; then echo "FAIL intl size: a program without Intl has the package's data"; fail=1
elif ! has "$OUT/size-number" "$NUM" || has "$OUT/size-number" "$DT" || has "$OUT/size-number" "$COLL"; then echo "FAIL intl size: NumberFormat alone has other data"; fail=1
elif has "$OUT/size-datetime" "$NUM" || ! has "$OUT/size-datetime" "$DT" || has "$OUT/size-datetime" "$COLL"; then echo "FAIL intl size: DateTimeFormat alone has other data"; fail=1
elif has "$OUT/size-datetime" "$EN" || has "$OUT/size-datetime" "$ZN"; then echo "FAIL intl size: a pt-BR dateStyle program has en-US data or zone names"; fail=1
else echo "ok intl size: each formatter's data only where it is used, one locale's, no zone names unless printed ($sizes)"; fi
exit $fail
