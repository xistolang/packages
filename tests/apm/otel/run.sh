#!/bin/sh
# OTLP as OpenTelemetry's semantic conventions say, and the metrics New Relic's APM pages read: main.ts with the
# newrelic agent sends to the fake OTLP receiver (collectors.py); check.py lists the spans and metrics it got,
# compared with expected.txt (checked by hand against the conventions and New Relic's OpenTelemetry APM UI docs).
cd "$(dirname "$0")/.." || exit 1
. ../env.sh
. ./lib.sh
cd otel || exit 1
OUT=$ROOT/build/tests/apm-otel
mkdir -p "$OUT"
$X build -o "$OUT/main" main.ts > "$OUT/build.txt" 2>&1 || { cat "$OUT/build.txt"; exit 1; }
collectors otel
export NEW_RELIC_LICENSE_KEY=0123456789abcdef0123456789abcdef01234567 NEW_RELIC_APP_NAME=shop
NEW_RELIC_OTLP_URL=http://127.0.0.1:$OTLPPORT/v1/traces "$OUT/main" > "$OUT/out.txt" 2> "$OUT/err.txt" || { echo "FAIL: exit $?"; cat "$OUT/err.txt"; exit 1; }
sleep 0.3
python3 -I check.py "$OUT/otel.jsonl" > "$OUT/check.txt" || { echo "FAIL: check.py"; exit 1; }
if [ -s "$OUT/err.txt" ]; then echo "FAIL: stderr"; cat "$OUT/err.txt"; exit 1; fi
if ! cmp -s expected.txt "$OUT/check.txt"; then echo "FAIL: spans or metrics"; diff expected.txt "$OUT/check.txt"; exit 1; fi
echo "ok: otel (OpenTelemetry names and attributes, client errors, exception events, delta metrics for New Relic's APM pages)"
