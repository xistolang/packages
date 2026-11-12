#!/bin/sh
# the pg package against a live PostgreSQL (xisto-pg on 127.0.0.1:${PGPORT_TEST:-55432}; skipped without one):
# a pool asked for more connections than it has. Run from the repository root.
cd "$(dirname "$0")" || exit 1
. ../../tests/env.sh
OUT=$ROOT/build/tests/pg
mkdir -p "$OUT"
if ! nc -z 127.0.0.1 "${PGPORT_TEST:-55432}" 2>/dev/null; then echo "skip: pg pool (no PostgreSQL on 127.0.0.1:${PGPORT_TEST:-55432})"; exit 0; fi
if $X build --no-warnings -o $OUT/pool src/pool.ts > $OUT/pool.build 2>&1 \
    && XISTO_RC_STATS=1 $OUT/pool > $OUT/pool.out 2> $OUT/pool.stats \
    && cmp -s $OUT/pool.out pool.expected && grep -q ' 0 still alive' $OUT/pool.stats; then
    echo "ok pg pool (12 queries at once on 2 connections)"
else
    echo "FAIL pg pool"; head -5 $OUT/pool.build; diff pool.expected $OUT/pool.out | head; tail -2 $OUT/pool.stats; exit 1
fi
