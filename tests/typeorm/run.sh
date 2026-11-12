#!/bin/sh
# typeorm: the SQL the repository and the query builder write (always), and the package against a live PostgreSQL
# (xisto-pg on 127.0.0.1:${PGPORT_TEST:-55432}; skipped without one). Run from the repository root.
cd "$(dirname "$0")" || exit 1
. ../../tests/env.sh
OUT=$ROOT/build/tests/typeorm
mkdir -p "$OUT"
fail=0
if $X run --no-warnings src/sql.ts > $OUT/sql.out 2>&1 && cmp -s $OUT/sql.out sql.expected; then echo "ok typeorm sql"; else echo "FAIL typeorm sql"; diff sql.expected $OUT/sql.out | head; fail=1; fi
if $X run --no-warnings src/nest-inject.ts > $OUT/inject.out 2>&1 && cmp -s $OUT/inject.out nest-inject.expected; then echo "ok typeorm forRootAsync inject"; else echo "FAIL typeorm forRootAsync inject"; diff nest-inject.expected $OUT/inject.out | head; fail=1; fi
if $X run --no-warnings src/nest-optional.ts > $OUT/optional.out 2>&1 && cmp -s $OUT/optional.out nest-optional.expected; then echo "ok nest optional provider"; else echo "FAIL nest optional provider"; diff nest-optional.expected $OUT/optional.out | head; fail=1; fi
if $X run --no-warnings src/nest-iface.ts > $OUT/iface.out 2>&1 && cmp -s $OUT/iface.out nest-iface.expected; then echo "ok nest provider by interface shape"; else echo "FAIL nest provider by interface shape"; diff nest-iface.expected $OUT/iface.out | head; fail=1; fi
if $X run --no-warnings src/nest-datasource-dep.ts > $OUT/dsdep.out 2>&1 && cmp -s $OUT/dsdep.out nest-datasource-dep.expected; then echo "ok nest provider over the DataSource"; else echo "FAIL nest provider over the DataSource"; diff nest-datasource-dep.expected $OUT/dsdep.out | head; fail=1; fi
if XISTO_TSC_CHECKED=1 $X run --no-warnings src/oracle.ts > $OUT/oracle.out 2>&1 && cmp -s $OUT/oracle.out oracle.expected; then echo "ok typeorm oracle driver"; else echo "FAIL typeorm oracle driver"; diff oracle.expected $OUT/oracle.out | head; fail=1; fi
# type "oracle" against a live Oracle Database (XISTO_ORACLE_URL=oracle://user:password@host:port/service, as
# tests/oracledb/run.sh); oracle-live.expected is what TypeORM 0.3 + node-oracledb 6 print for the same steps
if [ -n "$XISTO_ORACLE_URL" ] && up "$(url_host "$XISTO_ORACLE_URL")" "$(url_port "$XISTO_ORACLE_URL" 1521)"; then
    if $X build --no-warnings -o $OUT/oracle-live src/oracle-live.ts > $OUT/oracle-live.build 2>&1 \
        && TZ=America/Sao_Paulo XISTO_RC_STATS=1 $OUT/oracle-live > $OUT/oracle-live.out 2> $OUT/oracle-live.stats \
        && cmp -s $OUT/oracle-live.out oracle-live.expected && grep -q ' 0 still alive' $OUT/oracle-live.stats; then
        echo "ok typeorm oracle (live)"
    else
        echo "FAIL typeorm oracle (live)"; head -5 $OUT/oracle-live.build; diff oracle-live.expected $OUT/oracle-live.out | head; tail -1 $OUT/oracle-live.stats; fail=1
    fi
    # relations (@ManyToOne/@OneToMany, find's relations): relations-live.expected is TypeORM 0.3's output
    if $X run --no-warnings src/relations-live.ts > $OUT/relations.out 2>&1 && cmp -s $OUT/relations.out relations-live.expected; then
        echo "ok typeorm relations (live)"
    else
        echo "FAIL typeorm relations (live)"; diff relations-live.expected $OUT/relations.out | head; fail=1
    fi
    # XB-182: a Record of binds passed as `binds as unknown as unknown[]` (binds-record-live.expected: TypeORM 0.3)
    if $X build --tsc-checked --no-warnings -o $OUT/binds-rec src/binds-record-live.ts > $OUT/binds-rec.build 2>&1 \
        && $OUT/binds-rec > $OUT/binds-rec.out 2>&1 && cmp -s $OUT/binds-rec.out binds-record-live.expected; then
        echo "ok typeorm Record binds through unknown[] (live)"
    else
        echo "FAIL typeorm Record binds through unknown[] (live)"; head -5 $OUT/binds-rec.build; diff binds-record-live.expected $OUT/binds-rec.out | head; fail=1
    fi
else
    if [ -z "$XISTO_ORACLE_URL" ]; then echo "skip: typeorm oracle live (XISTO_ORACLE_URL is not set)"; else echo "skip: typeorm oracle live (no Oracle Database at the server of XISTO_ORACLE_URL)"; fi
fi
if nc -z 127.0.0.1 "${PGPORT_TEST:-55432}" 2>/dev/null; then
    if $X run --no-warnings src/pg.ts > $OUT/pg.out 2>&1 && cmp -s $OUT/pg.out pg.expected; then echo "ok typeorm postgres"; else echo "FAIL typeorm postgres"; diff pg.expected $OUT/pg.out | head; fail=1; fi
    # @nestjs/typeorm: a Nest application on the same server, its routes asked over HTTP
    PORT=${NEST_PORT:-38411}
    if $X build --no-warnings -o $OUT/nest src/nest.ts > $OUT/nest.build 2>&1; then
        NEST_PORT=$PORT $OUT/nest > $OUT/nest.log 2>&1 &
        pid=$!
        for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do nc -z 127.0.0.1 "$PORT" 2>/dev/null && break; sleep 0.25; done
        : > $OUT/nest.out
        for u in items/setup items items/2 items/9 items/count items/teardown; do
            echo "GET /$u -> $(curl -s -w ' [%{http_code}]' "http://127.0.0.1:$PORT/$u")" >> $OUT/nest.out
        done
        kill $pid 2>/dev/null
        wait $pid 2>/dev/null
        if cmp -s $OUT/nest.out nest.expected; then echo "ok @nestjs/typeorm"; else echo "FAIL @nestjs/typeorm"; diff nest.expected $OUT/nest.out | head; fail=1; fi
    else
        echo "FAIL @nestjs/typeorm: build"; head -5 $OUT/nest.build; fail=1
    fi
else
    echo "skip: typeorm postgres and @nestjs/typeorm (no PostgreSQL on 127.0.0.1:${PGPORT_TEST:-55432})"
fi
exit $fail
