#!/bin/sh
# @dynatrace/oneagent and @dynatrace/oneagent-sdk: main.ts built with xisto starts tracing with oneagent({...}) and
# sends OTLP/HTTP JSON to a fake receiver (tests/apm/collectors.py, through xisto's DT_OTLP_URL); the payload,
# normalized (tests/apm/normalize.py), must equal expected.json (checked by hand against the OTLP spec, the
# OpenTelemetry semantic conventions Dynatrace reads and its Api-Token header), and its output expected.txt.
# stub.ts uses the SDK with no agent: its output must equal expected-stub.txt, what it prints on Node with the real
# @dynatrace/oneagent-sdk 1.5.0 (no OneAgent: the inactive SDK). With APM_NODE_REF=DIR (a "type": "module" folder
# with @dynatrace/oneagent-sdk in node_modules) that Node run is made again and compared too.
cd "$(dirname "$0")/.." || exit 1
. ../env.sh
. ./lib.sh
cd dynatrace || exit 1
OUT=$ROOT/build/tests/apm-dynatrace
mkdir -p "$OUT"
cp main.ts stub.ts "$OUT/"
for t in main stub; do
  $X build -o "$OUT/$t" "$OUT/$t.ts" > "$OUT/build.txt" 2>&1 || { cat "$OUT/build.txt"; exit 1; }
done
"$OUT/stub" > "$OUT/stub-out.txt" 2>&1 || { echo "FAIL: stub exit"; cat "$OUT/stub-out.txt"; exit 1; }
if ! cmp -s expected-stub.txt "$OUT/stub-out.txt"; then echo "FAIL: stub output"; diff expected-stub.txt "$OUT/stub-out.txt"; exit 1; fi
collectors xisto
DT_OTLP_URL=http://127.0.0.1:$OTLPPORT/v1/traces OTEL_SERVICE_NAME=orders OTEL_RESOURCE_ATTRIBUTES=deployment.environment=test "$OUT/main" > "$OUT/out.txt" 2> "$OUT/err.txt" || { echo "FAIL: exit $?"; cat "$OUT/err.txt"; exit 1; }
sleep 0.3
normalized "$OUT/xisto.jsonl" otlp "$OUT/xisto.json"
if ! cmp -s expected.txt "$OUT/out.txt"; then echo "FAIL: output"; diff expected.txt "$OUT/out.txt"; exit 1; fi
if ! cmp -s expected.json "$OUT/xisto.json"; then echo "FAIL: payload"; diff expected.json "$OUT/xisto.json"; exit 1; fi
also=
if [ -n "$APM_NODE_REF" ]; then
  cp stub.ts "$APM_NODE_REF/xisto-dynatrace-stub.ts"
  (cd "$APM_NODE_REF" && node xisto-dynatrace-stub.ts) > "$OUT/node-stub.txt" 2>&1 || { echo "FAIL: node"; cat "$OUT/node-stub.txt"; exit 1; }
  if ! cmp -s expected-stub.txt "$OUT/node-stub.txt"; then echo "FAIL: Node's output"; diff expected-stub.txt "$OUT/node-stub.txt"; exit 1; fi
  also=", Node run again"
fi
echo "ok: dynatrace (OTLP to Dynatrace from the OneAgent SDK's tracers; inactive SDK as the real one$also)"
