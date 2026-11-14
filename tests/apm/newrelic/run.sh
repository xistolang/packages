#!/bin/sh
# newrelic: main.ts built with xisto sends OTLP/HTTP JSON (New Relic's OpenTelemetry entry) to a fake receiver
# (tests/apm/collectors.py, through xisto's NEW_RELIC_OTLP_URL); the payload, normalized (tests/apm/normalize.py),
# must equal expected.json (checked by hand against the OTLP spec and New Relic's OTLP conventions: service.name,
# api-key header, server spans for web transactions, status ERROR and an exception event for noticeError). The real
# agent's protocol is closed, so the Node reference is the API's output: expected.txt is what main.ts prints on Node
# with newrelic 12.25.1 (enabled, never connected). With APM_NODE_REF=DIR (a "type": "module" folder with newrelic
# in node_modules) the Node run is made again and compared too.
cd "$(dirname "$0")/.." || exit 1
. ../env.sh
. ./lib.sh
cd newrelic || exit 1
OUT=$ROOT/build/tests/apm-newrelic
mkdir -p "$OUT"
cp main.ts "$OUT/"
$X build -o "$OUT/main" "$OUT/main.ts" > "$OUT/build.txt" 2>&1 || { cat "$OUT/build.txt"; exit 1; }
collectors xisto
export NEW_RELIC_LICENSE_KEY=0123456789abcdef0123456789abcdef01234567 NEW_RELIC_APP_NAME="shop;other" NEW_RELIC_NO_CONFIG_FILE=true NEW_RELIC_LOG_ENABLED=false
NEW_RELIC_OTLP_URL=http://127.0.0.1:$OTLPPORT/v1/traces "$OUT/main" > "$OUT/out.txt" 2> "$OUT/err.txt" || { echo "FAIL: exit $?"; cat "$OUT/err.txt"; exit 1; }
sleep 0.3
normalized "$OUT/xisto.jsonl" otlp "$OUT/xisto.json"
if ! cmp -s expected.txt "$OUT/out.txt"; then echo "FAIL: output"; diff expected.txt "$OUT/out.txt"; exit 1; fi
if ! cmp -s expected.json "$OUT/xisto.json"; then echo "FAIL: payload"; diff expected.json "$OUT/xisto.json"; exit 1; fi
also=
if [ -n "$APM_NODE_REF" ]; then
  cp main.ts "$APM_NODE_REF/xisto-newrelic-main.ts"
  (cd "$APM_NODE_REF" && NEW_RELIC_HOST=127.0.0.1 NEW_RELIC_PORT=9 node xisto-newrelic-main.ts) > "$OUT/node-out.txt" 2>&1 || { echo "FAIL: node"; cat "$OUT/node-out.txt"; exit 1; }
  if ! cmp -s expected.txt "$OUT/node-out.txt"; then echo "FAIL: Node's output"; diff expected.txt "$OUT/node-out.txt"; exit 1; fi
  also=", Node run again"
fi
echo "ok: newrelic (OTLP to New Relic: transactions, segments, attributes, errors, trace headers; API output as the real agent's$also)"
