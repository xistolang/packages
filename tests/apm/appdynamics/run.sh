#!/bin/sh
# appdynamics: main.ts built with xisto profiles the agent and sends OTLP/HTTP JSON to a fake receiver
# (tests/apm/collectors.py, through xisto's APPDYNAMICS_OTLP_URL); the payload, normalized (tests/apm/normalize.py),
# must equal expected.json (checked by hand against the OTLP spec and AppDynamics' OpenTelemetry mapping:
# service.namespace = application, service.name = tier, service.instance.id = node, x-api-key header), and its output
# expected.txt. The npm agent needs AppDynamics' native proxy and a controller, so there is no Node run.
cd "$(dirname "$0")/.." || exit 1
. ../env.sh
. ./lib.sh
cd appdynamics || exit 1
OUT=$ROOT/build/tests/apm-appdynamics
mkdir -p "$OUT"
cp main.ts "$OUT/"
$X build -o "$OUT/main" "$OUT/main.ts" > "$OUT/build.txt" 2>&1 || { cat "$OUT/build.txt"; exit 1; }
collectors xisto
APPDYNAMICS_OTLP_URL=http://127.0.0.1:$OTLPPORT/v1/traces "$OUT/main" > "$OUT/out.txt" 2> "$OUT/err.txt" || { echo "FAIL: exit $?"; cat "$OUT/err.txt"; exit 1; }
sleep 0.3
normalized "$OUT/xisto.jsonl" otlp "$OUT/xisto.json"
if ! cmp -s expected.txt "$OUT/out.txt"; then echo "FAIL: output"; diff expected.txt "$OUT/out.txt"; exit 1; fi
if ! cmp -s expected.json "$OUT/xisto.json"; then echo "FAIL: payload"; diff expected.json "$OUT/xisto.json"; exit 1; fi
echo "ok: appdynamics (OTLP to AppDynamics: business transactions, exit calls, snapshot and analytics data, errors)"
