#!/bin/sh
# newrelic's application logging on nestjs-pino lines. main.ts built with xisto runs twice against the fake OTLP
# receiver (tests/apm/collectors.py, through xisto's NEW_RELIC_OTLP_URL):
# - with NEW_RELIC_APPLICATION_LOGGING_LOCAL_DECORATING_ENABLED=true: its lines, normalized (time, pid and host masked;
#   each id becomes a label, ID1, ID2... in the order they first appear, so that the lines that share a trace or a
#   span can be seen), must equal expected.txt, what the same program prints on Node with newrelic 12.25.1 (never
#   connected), nestjs-pino 4.6.1 and pino 9.14.0 (compiled with tsc, CommonJS); the log records forwarded (on by
#   default), normalized (tests/apm/normalize.py otlp-logs: their traceId/spanId as the spans sent with them), must
#   equal expected-logs.json (checked by hand: the agent's own protocol is closed, the records go to New Relic's OTLP
#   entry);
# - with NEW_RELIC_APPLICATION_LOGGING_FORWARDING_ENABLED=false (and no decorating, the default): plain lines
#   (expected-plain.txt, also Node's) and no log records sent.
# With APM_NODE_REF=DIR (a folder with those packages and typescript in node_modules) the Node runs are made again and
# compared too.
cd "$(dirname "$0")/.." || exit 1
. ../env.sh
. ./lib.sh
cd newrelic-logs || exit 1
OUT=$ROOT/build/tests/apm-newrelic-logs
mkdir -p "$OUT"
$X build -o "$OUT/main" main.ts > "$OUT/build.txt" 2>&1 || { cat "$OUT/build.txt"; exit 1; }
export NEW_RELIC_LICENSE_KEY=0123456789abcdef0123456789abcdef01234567 NEW_RELIC_APP_NAME="shop;other" NEW_RELIC_NO_CONFIG_FILE=true NEW_RELIC_LOG_ENABLED=false
# masked FILE: the lines with time, pid, host and ids masked
masked() {
  sed -E -e 's/"time":[0-9]+/"time":T/' -e 's/"pid":[0-9]+/"pid":P/' -e 's/"hostname":"[^"]*"/"hostname":H/' -e 's/NR-LINKING\|([^|]*)\|[^|]*\|/NR-LINKING|\1|H|/' "$1" \
    | perl -pe 's/\b([0-9a-f]{32}|[0-9a-f]{16})\b/$m{$1} \/\/= "ID".++$k/ge'
}
collectors decorated
NEW_RELIC_APPLICATION_LOGGING_LOCAL_DECORATING_ENABLED=true NEW_RELIC_OTLP_URL=http://127.0.0.1:$OTLPPORT/v1/traces "$OUT/main" > "$OUT/decorated.txt" 2> "$OUT/decorated.err" || { echo "FAIL: exit $?"; cat "$OUT/decorated.err"; exit 1; }
sleep 0.3
normalized "$OUT/decorated.jsonl" otlp-logs "$OUT/logs.json"
masked "$OUT/decorated.txt" > "$OUT/decorated.norm"
if ! cmp -s expected.txt "$OUT/decorated.norm"; then echo "FAIL: decorated lines"; diff expected.txt "$OUT/decorated.norm"; exit 1; fi
if ! cmp -s expected-logs.json "$OUT/logs.json"; then echo "FAIL: forwarded logs"; diff expected-logs.json "$OUT/logs.json"; exit 1; fi
collectors plain
NEW_RELIC_APPLICATION_LOGGING_FORWARDING_ENABLED=false NEW_RELIC_OTLP_URL=http://127.0.0.1:$OTLPPORT/v1/traces "$OUT/main" > "$OUT/plain.txt" 2> "$OUT/plain.err" || { echo "FAIL: exit $?"; cat "$OUT/plain.err"; exit 1; }
sleep 0.3
masked "$OUT/plain.txt" > "$OUT/plain.norm"
if ! cmp -s expected-plain.txt "$OUT/plain.norm"; then echo "FAIL: plain lines"; diff expected-plain.txt "$OUT/plain.norm"; exit 1; fi
if grep -q '"otlp-logs"' "$OUT/plain.jsonl"; then echo "FAIL: logs forwarded with forwarding off"; exit 1; fi
also=
if [ -n "$APM_NODE_REF" ]; then
  mkdir -p "$APM_NODE_REF/xisto-newrelic-logs"
  cp main.ts "$APM_NODE_REF/xisto-newrelic-logs/main.ts"
  (cd "$APM_NODE_REF" && npx tsc --target es2022 --module commonjs --experimentalDecorators --emitDecoratorMetadata --esModuleInterop \
    --skipLibCheck --outDir xisto-newrelic-logs/js xisto-newrelic-logs/main.ts) > "$OUT/tsc.txt" 2>&1 || { echo "FAIL: tsc"; cat "$OUT/tsc.txt"; exit 1; }
  export NEW_RELIC_HOST=127.0.0.1 NEW_RELIC_PORT=9
  NEW_RELIC_APPLICATION_LOGGING_LOCAL_DECORATING_ENABLED=true node "$APM_NODE_REF/xisto-newrelic-logs/js/main.js" > "$OUT/node-decorated.txt" 2>&1
  masked "$OUT/node-decorated.txt" > "$OUT/node-decorated.norm"
  if ! cmp -s expected.txt "$OUT/node-decorated.norm"; then echo "FAIL: Node's decorated lines"; diff expected.txt "$OUT/node-decorated.norm"; exit 1; fi
  NEW_RELIC_APPLICATION_LOGGING_FORWARDING_ENABLED=false node "$APM_NODE_REF/xisto-newrelic-logs/js/main.js" > "$OUT/node-plain.txt" 2>&1
  masked "$OUT/node-plain.txt" > "$OUT/node-plain.norm"
  if ! cmp -s expected-plain.txt "$OUT/node-plain.norm"; then echo "FAIL: Node's plain lines"; diff expected-plain.txt "$OUT/node-plain.norm"; exit 1; fi
  also=", Node run again"
fi
echo "ok: newrelic logs in context (NR-LINKING decorating as the real agent's, forwarding as OTLP logs with trace and span ids$also)"
