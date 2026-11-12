#!/bin/sh
# class-validator: rules checked the way class-validator 0.14 checks them (isIn compares by value and type, as
# possibleValues.some(v => v === value) does). Run from the repository root.
cd "$(dirname "$0")" || exit 1
. ../../tests/env.sh
OUT=$ROOT/build/tests/validator
mkdir -p "$OUT"
fail=0
if $X run --no-warnings src/isin.ts > $OUT/isin.out 2>&1 && cmp -s $OUT/isin.out isin.expected; then echo "ok validator isIn"; else echo "FAIL validator isIn"; diff isin.expected $OUT/isin.out | head; fail=1; fi
exit $fail
