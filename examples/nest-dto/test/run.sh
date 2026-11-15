#!/bin/sh
# Builds the example with xisto and runs the scenario without a pipe and with the ValidationPipe (DTO_PIPE=1),
# comparing the answers with test/expected-plain.txt and expected-pipe.txt: the output of the same source on Node with
# Nest 11, class-validator 0.14 and class-transformer 0.5 (compiled by tsc).
set -u
cd "$(dirname "$0")/.." || exit 1
. ../../tests/env.sh
PORT=${PORT:-3198}
W=$(mktemp -d)
$X build -o "$W/app" src/main.ts > "$W/build.txt" 2>&1 || { echo "FAIL nest-dto: build"; cat "$W/build.txt"; rm -rf "$W"; exit 1; }
fail=0
for pipe in 0 1; do
  mode=plain; [ $pipe = 1 ] && mode=pipe
  DTO_PIPE=$pipe PORT=$PORT "$W/app" > "$W/server-$pipe.txt" 2>&1 &
  pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/dto/list" && break
    sleep 0.3
  done
  python3 test/scenario.py "http://127.0.0.1:$PORT" $mode > "$W/out-$pipe.txt"
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  if ! diff "test/expected-$mode.txt" "$W/out-$pipe.txt"; then fail=1; fi
done
rm -rf "$W"
if [ $fail -eq 0 ]; then
  echo "ok: nest-dto @Query() and @Param() DTOs as Nest on Node ($(cat test/expected-plain.txt test/expected-pipe.txt | wc -l | tr -d ' ') requests, without and with the ValidationPipe)"
else
  echo "FAIL nest-dto: differs from Node"
  exit 1
fi
