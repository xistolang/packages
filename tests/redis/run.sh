#!/bin/sh
# packages/redis against a live server (docker: xisto-redis on 127.0.0.1:56379, database 2 is used and flushed).
# Without a server the test is skipped, not failed: it needs Redis, the rest of the suite does not.
cd "$(dirname "$0")" || exit 1
. ../../tests/env.sh
OUT=$ROOT/build/tests/redis
mkdir -p "$OUT"
cp client.ts "$OUT/client.ts"
if ! nc -z 127.0.0.1 56379 2>/dev/null; then echo "skip: redis (no Redis on 127.0.0.1:56379; docker start xisto-redis)"; exit 0; fi
XISTO_NODE_COMPAT=1 $X build -o "$OUT/client" "$OUT/client.ts" || exit 1
XISTO_RC_STATS=1 "$OUT/client" > "$OUT/out.txt" 2> "$OUT/stats.txt"
if ! cmp -s expected.txt "$OUT/out.txt"; then echo "FAIL: output"; diff expected.txt "$OUT/out.txt"; exit 1; fi
if ! grep -q ' 0 still alive' "$OUT/stats.txt"; then echo "FAIL: leak: $(cat "$OUT/stats.txt")"; exit 1; fi
echo "ok: redis client (commands, big values, server errors, refused connection, 0 alive)"
