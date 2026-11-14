#!/bin/sh
# The packages' APM instrumentation: each program starts xisto-apm with an exporter that prints the spans
# (src/exporter.ts) and uses one package; its output is compared with NAME.expected. The database ones skip when
# their server is not reachable (as tests/pg, tests/redis...).
cd "$(dirname "$0")" || exit 1
. ../../tests/env.sh
OUT=$ROOT/build/tests/apm-instr
mkdir -p "$OUT"
st=0
# check NAME DESCRIPTION SKIP [ARGS...]: builds src/NAME.ts and, unless SKIP (a reason) is set, runs it and compares
# its output with NAME.expected
check() {
    n=$1; d=$2; why=$3; shift 3
    if ! $X build --no-warnings -o "$OUT/$n" "src/$n.ts" > "$OUT/$n.build" 2>&1; then
        echo "FAIL apm $n: build"; head -20 "$OUT/$n.build"; st=1; return
    fi
    if [ -n "$why" ]; then echo "skip: apm $n ($why)"; return; fi
    if "$OUT/$n" "$@" > "$OUT/$n.out" 2> "$OUT/$n.err" && cmp -s "$OUT/$n.out" "$n.expected"; then
        echo "ok apm $n ($d)"
    else
        echo "FAIL apm $n"; diff "$n.expected" "$OUT/$n.out" | head -30; tail -5 "$OUT/$n.err"; st=1
    fi
}
nopg=; up 127.0.0.1 "${PGPORT_TEST:-55432}" || nopg="no PostgreSQL on 127.0.0.1:${PGPORT_TEST:-55432}"
check pg "pg.query spans" "$nopg"
noora=
if [ -z "$XISTO_ORACLE_URL" ]; then noora="XISTO_ORACLE_URL is not set"
elif ! up "$(url_host "$XISTO_ORACLE_URL")" "$(url_port "$XISTO_ORACLE_URL" 1521)"; then noora="no Oracle Database at XISTO_ORACLE_URL"; fi
check oracle "oracle.query spans" "$noora"
nomongo=
if [ -z "$XISTO_MONGO_URL" ]; then nomongo="XISTO_MONGO_URL is not set"
elif ! up "$(url_host "$XISTO_MONGO_URL")" "$(url_port "$XISTO_MONGO_URL" 27017)"; then nomongo="no MongoDB at XISTO_MONGO_URL"; fi
check mongo "mongodb.query spans" "$nomongo"
noes=; port=
if command -v node > /dev/null 2>&1; then
    port=$((20000 + $$ % 20000))
    node ../elasticsearch/server.mjs $port > "$OUT/es-server.log" 2>&1 &
    srv=$!
    i=0
    while [ $i -lt 50 ] && ! grep -q listening "$OUT/es-server.log" 2>/dev/null; do i=$((i + 1)); perl -e 'select(undef, undef, undef, 0.1)'; done
else noes="no node for the fake cluster"; fi
check es "elasticsearch.query spans" "$noes" $port
[ -n "$port" ] && { kill $srv 2>/dev/null; wait $srv 2>/dev/null; }
noredis=; up 127.0.0.1 56379 || noredis="no Redis on 127.0.0.1:56379"
check redis "redis.command spans of redis and ioredis" "$noredis"
# the Nest application (nest/main.ts): requests made with curl, then GET /done prints the traces; once with pino
# lines, once with ECS lines. Times, pids and the host are masked; each id becomes a label (ID1, ID2... in the order
# they first appear), so that the logs' ids can be seen to be their spans'.
nest() {
    n=$1; ecs=$2; port=$((20000 + ($$ + 7) % 20000))
    APM_ECS=$ecs PORT=$port "$OUT/nest" > "$OUT/$n.raw" 2> "$OUT/$n.err" &
    pid=$!
    i=0
    while [ $i -lt 50 ] && ! up 127.0.0.1 $port; do i=$((i + 1)); perl -e 'select(undef, undef, undef, 0.1)'; done
    u=http://127.0.0.1:$port
    {
        curl -s -A apm-test "$u/users/42"; echo
        curl -s -A apm-test -X POST -H 'content-type: application/json' -d '{"name":"bia"}' "$u/users"; echo
        curl -s -A apm-test "$u/users/missing/9"; echo
        curl -s -A apm-test "$u/boom"; echo
        curl -s -A apm-test "$u/nope"; echo
        curl -s -A apm-test -H 'traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' "$u/users/1"; echo
        curl -s -A apm-test "$u/done"; echo
    } > "$OUT/$n.answers"
    kill $pid 2>/dev/null; wait $pid 2>/dev/null
    cat "$OUT/$n.answers" "$OUT/$n.raw" | sed -E -e 's/"(time|@timestamp)":("[^"]*"|[0-9]+)/"\1":T/g' -e 's/"(pid|process.pid)":[0-9]+/"\1":P/g' \
        -e 's/"(hostname|host.hostname)":"[^"]*"/"\1":H/g' -e "s/127.0.0.1:$port/HOST/g" \
        | perl -pe 's/("(?:trace_id|span_id|trace\.id|transaction\.id|span\.id)":"|#\w+=)([0-9a-f]+)/$1.($m{$2} \/\/= "ID".++$k)/ge' > "$OUT/$n.out"
    if cmp -s "$OUT/$n.out" "$n.expected"; then echo "ok apm $n (web.request spans, log correlation)"; else echo "FAIL apm $n"; diff "$n.expected" "$OUT/$n.out" | head -40; st=1; fi
}
if $X build --no-warnings -o "$OUT/nest" nest/main.ts > "$OUT/nest.build" 2>&1; then
    nest nest-pino 0
    nest nest-ecs 1
else
    echo "FAIL apm nest: build"; head -20 "$OUT/nest.build"; st=1
fi
exit $st
