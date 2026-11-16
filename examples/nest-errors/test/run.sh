#!/bin/sh
# Builds the example with xisto, runs the scenario and compares it with test/expected.txt: the output of the same
# source on Node with the real npm packages (@nestjs/core 11, @nestjs/throttler 6, rxjs; NO_COLOR=1).
set -u
cd "$(dirname "$0")/.." || exit 1
. ../../tests/env.sh
PORT=${PORT:-3196}
W=$(mktemp -d)
$X build -o "$W/app" src/main.ts > "$W/build.txt" 2>&1 || { echo "FAIL nest-errors: build"; cat "$W/build.txt"; rm -rf "$W"; exit 1; }
PORT=$PORT "$W/app" > "$W/server.txt" 2>&1 &
pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  # (a path no route takes: an answer means the server is up, and no interceptor writes a line for it)
  curl -s -o /dev/null "http://127.0.0.1:$PORT/ready" && break
  sleep 0.3
done
python3 test/scenario.py "http://127.0.0.1:$PORT" "$W/server.txt" > "$W/out.txt"
kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null
if diff test/expected.txt "$W/out.txt" > "$W/diff.txt"; then
  echo "ok: nest-errors answers as Nest on Node ($(wc -l < test/expected.txt | tr -d ' ') lines)"
  rm -rf "$W"
else
  echo "FAIL nest-errors: differs from Node"
  cat "$W/diff.txt"
  tail -20 "$W/server.txt"
  rm -rf "$W"
  exit 1
fi
