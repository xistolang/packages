#!/bin/sh
# dd-trace's log injection on nestjs-pino lines: main.ts built with xisto runs against a fake Datadog Agent three times
# (by default; DD_LOGS_INJECTION=false; DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED=false); its lines, normalized with
# the spans the Agent received (normalize.py: each "dd" id becomes the span it points to), must equal expected.txt:
# the same program on Node with dd-trace 5.131.1, nestjs-pino 4.6.1 and pino 9.14.0 (compiled with tsc, CommonJS).
# With APM_NODE_REF=DIR (a folder with those packages and typescript in node_modules) the Node runs are made again and
# compared too.
cd "$(dirname "$0")/.." || exit 1
. ../env.sh
. ./lib.sh
cd dd-logs || exit 1
OUT=$ROOT/build/tests/apm-dd-logs
mkdir -p "$OUT"
$X build -o "$OUT/main" main.ts > "$OUT/build.txt" 2>&1 || { cat "$OUT/build.txt"; exit 1; }
# scenarios NAME COMMAND: runs COMMAND under each setting, prints its normalized lines
scenarios() {
  for s in default DD_LOGS_INJECTION=false DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED=false; do
    collectors "$1"
    echo "== $s"
    e=$s; [ "$s" = default ] && e=
    env $e APM_DD_PORT=$DDPORT $2 > "$OUT/$1-$s.txt" 2> "$OUT/$1-$s.err" || { echo "FAIL: exit $?"; cat "$OUT/$1-$s.err"; }
    sleep 0.3
    python3 -I normalize.py "$OUT/$1-$s.txt" "$OUT/$1.jsonl" || echo "FAIL: normalize"
  done
}
scenarios xisto "$OUT/main" > "$OUT/xisto.txt"
if ! cmp -s expected.txt "$OUT/xisto.txt"; then echo "FAIL: log lines"; diff expected.txt "$OUT/xisto.txt"; exit 1; fi
also=
if [ -n "$APM_NODE_REF" ]; then
  mkdir -p "$APM_NODE_REF/xisto-dd-logs"
  cp main.ts "$APM_NODE_REF/xisto-dd-logs/main.ts"
  (cd "$APM_NODE_REF" && npx tsc --target es2022 --module commonjs --experimentalDecorators --emitDecoratorMetadata --esModuleInterop \
    --skipLibCheck --outDir xisto-dd-logs/js xisto-dd-logs/main.ts) > "$OUT/tsc.txt" 2>&1 || { echo "FAIL: tsc"; cat "$OUT/tsc.txt"; exit 1; }
  scenarios node "node $APM_NODE_REF/xisto-dd-logs/js/main.js" > "$OUT/node.txt"
  if ! cmp -s expected.txt "$OUT/node.txt"; then echo "FAIL: Node's lines"; diff expected.txt "$OUT/node.txt"; exit 1; fi
  also=", Node run again"
fi
echo "ok: dd-trace log injection (dd.trace_id/span_id of the active span, service, version, env; off; 64-bit) as the real dd-trace's$also"
