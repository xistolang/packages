#!/bin/sh
# elastic-apm-node: main.ts built with xisto sends to a fake APM Server (tests/apm/collectors.py); the intake v2
# payload, normalized (tests/apm/normalize.py), must equal expected.json, which is the normalized payload of the
# same main.ts on Node with the real elastic-apm-node 4.18.0, and its output must equal expected.txt (Node's).
# With APM_NODE_REF=DIR (a folder with "type": "module" in package.json and elastic-apm-node in node_modules) the
# Node run is made again and compared too.
cd "$(dirname "$0")/.." || exit 1
. ../env.sh
. ./lib.sh
cd elastic || exit 1
OUT=$ROOT/build/tests/apm-elastic
mkdir -p "$OUT"
cp main.ts "$OUT/"
$X build -o "$OUT/main" "$OUT/main.ts" > "$OUT/build.txt" 2>&1 || { cat "$OUT/build.txt"; exit 1; }
collectors xisto
APM_ELASTIC_PORT=$ELPORT "$OUT/main" > "$OUT/out.txt" 2> "$OUT/err.txt" || { echo "FAIL: exit $?"; cat "$OUT/err.txt"; exit 1; }
sleep 0.3
normalized "$OUT/xisto.jsonl" elastic "$OUT/xisto.json"
if ! cmp -s expected.txt "$OUT/out.txt"; then echo "FAIL: output"; diff expected.txt "$OUT/out.txt"; exit 1; fi
if ! cmp -s expected.json "$OUT/xisto.json"; then echo "FAIL: payload"; diff expected.json "$OUT/xisto.json"; exit 1; fi
also=
if [ -n "$APM_NODE_REF" ]; then
  cp main.ts "$APM_NODE_REF/xisto-elastic-main.ts"
  collectors node
  (cd "$APM_NODE_REF" && APM_ELASTIC_PORT=$ELPORT node xisto-elastic-main.ts) > "$OUT/node-out.txt" 2>&1 || { echo "FAIL: node"; cat "$OUT/node-out.txt"; exit 1; }
  sleep 0.3
  normalized "$OUT/node.jsonl" elastic "$OUT/node.json"
  if ! cmp -s expected.txt "$OUT/node-out.txt"; then echo "FAIL: Node's output"; diff expected.txt "$OUT/node-out.txt"; exit 1; fi
  if ! cmp -s expected.json "$OUT/node.json"; then echo "FAIL: Node's payload"; diff expected.json "$OUT/node.json"; exit 1; fi
  also=", Node run again"
fi
echo "ok: elastic-apm-node (intake v2 events as the real agent's: transactions, spans, labels, user/custom context, errors$also)"
