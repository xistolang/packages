#!/bin/sh
# The packages' test suite, run with an installed xisto. Each test compiles programs that import the packages of
# this checkout and compares what they print with the output of the same source on Node with the real npm package
# (checked in as expected files; elasticsearch runs a fake cluster on Node). Tests that need a database skip, with
# a "skip:" line, when its server is not reachable:
#   PostgreSQL  127.0.0.1:${PGPORT_TEST:-55432} (user/password xisto, database conduit)    pg, typeorm
#   Redis       127.0.0.1:56379                                                             redis, ioredis
#   MongoDB     XISTO_MONGO_URL=mongodb://127.0.0.1:27017                                   mongoose (live part)
#   Oracle      XISTO_ORACLE_URL=oracle://user:password@127.0.0.1:1521/FREEPDB1             oracledb, typeorm (live part)
#
# usage: tests/run.sh [--xisto PATH] [--pkgs DIR] [TEST...]
#   --xisto PATH  the compiler (also XISTO=PATH); default: xisto on PATH
#   --pkgs DIR    where the packages are (also XISTO_PKGS=DIR); default: this checkout
#   TEST          run only these (names as listed below, e.g. typeorm nest-forms)
# Needs: a C compiler (cc), python3, curl, nc, perl; node for elasticsearch.
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
while [ $# -gt 0 ]; do
    case $1 in
    --xisto) XISTO=$2; shift 2 ;;
    --xisto=*) XISTO=${1#--xisto=}; shift ;;
    --pkgs) XISTO_PKGS=$2; shift 2 ;;
    --pkgs=*) XISTO_PKGS=${1#--pkgs=}; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "tests/run.sh: unknown option $1 (--xisto PATH, --pkgs DIR)"; exit 2 ;;
    *) break ;;
    esac
done
X=${XISTO:-xisto}
case $X in */*) ;; *) X=$(command -v "$X") ;; esac
if [ -z "$X" ] || [ ! -x "$X" ]; then echo "tests/run.sh: no xisto compiler (put xisto on PATH, or --xisto PATH / XISTO=PATH)"; exit 2; fi
XISTO=$(cd "$(dirname "$X")" && pwd)/$(basename "$X")
XISTO_PKGS=$(cd "${XISTO_PKGS:-$ROOT}" && pwd) || { echo "tests/run.sh: --pkgs: not a folder"; exit 2; }
# node: imports allowed (these programs also run on Node); one time zone for xisto and the Node outputs
export XISTO XISTO_PKGS XISTO_NODE_COMPAT=1 TZ=America/New_York
OUT=$ROOT/build/tests
mkdir -p "$OUT"
echo "xisto: $XISTO ($("$XISTO" --version 2>/dev/null || echo 'unknown version'))"
echo "packages: $XISTO_PKGS"

# NAME SCRIPT [PATTERN]: the script must exit 0 and, with a PATTERN, print a line that matches it
TESTS="
subpaths tests/subpaths/run.sh ^ok:
reflectmeta tests/reflectmeta/run.sh
validator tests/validator/run.sh
nestlog tests/nestlog/run.sh
nestjwt tests/nestjwt/run.sh
jose tests/jose/run.sh
mongodb tests/mongodb/run.sh
mongoose tests/mongoose/run.sh
exceljs tests/exceljs/run.sh
elasticsearch tests/elasticsearch/run.sh
oracledb tests/oracledb/run.sh
pg tests/pg/run.sh
typeorm tests/typeorm/run.sh
redis tests/redis/run.sh
ioredis tests/ioredis/run.sh
nest-features examples/nest-features/test/run.sh ^ok:.nest-features
nest-versions examples/nest-versions/test/run.sh ^ok:.nest-versions
nest-auth examples/nest-auth/test/run.sh ^ok:.nest-auth
apm-dd tests/apm/dd/run.sh ^ok:
apm-elastic tests/apm/elastic/run.sh ^ok:.elastic-apm-node
apm-newrelic tests/apm/newrelic/run.sh ^ok:.newrelic
apm-dynatrace tests/apm/dynatrace/run.sh ^ok:.dynatrace
apm-appdynamics tests/apm/appdynamics/run.sh ^ok:.appdynamics
nest-forms examples/nest-forms/test/run.sh ^ok:.nest-forms
conduit -
"
pass=0; fail=0; skip=0; partial=0
skipped=
failed=
wanted() { [ -z "$ONLY" ] && return 0; for w in $ONLY; do [ "$w" = "$1" ] && return 0; done; return 1; }
ONLY=$*
for n in $ONLY; do echo "$TESTS" | grep -q "^$n " || { echo "tests/run.sh: no test named $n"; exit 2; }; done
echo "$TESTS" | while read -r name script pattern; do [ -n "$name" ] && echo "$name $script $pattern"; done > "$OUT/list.txt"
while read -r name script pattern; do
    wanted "$name" || continue
    log=$OUT/$name.txt
    if [ "$name" = conduit ]; then
        # the RealWorld example: it must build (its scenario needs PostgreSQL and Redis and is compared by hand with
        # the Node build: examples/conduit/test/scenario.py)
        if (cd examples/conduit && "$XISTO" build --no-warnings -o "$OUT/conduit-app" src/main.ts) > "$log" 2>&1; then
            echo "ok: conduit builds" >> "$log"; rc=0
        else rc=1; fi
    else
        sh "$script" > "$log" 2>&1; rc=$?
    fi
    if [ $rc -eq 0 ] && { [ -z "$pattern" ] || grep -q "$pattern" "$log"; }; then
        if grep -q '^skip:' "$log"; then
            if grep -q '^ok' "$log"; then
                partial=$((partial+1)); pass=$((pass+1)); echo "ok   $name (part skipped)"
            else
                skip=$((skip+1)); echo "skip $name"
            fi
            skipped="$skipped
$(grep '^skip:' "$log" | sed "s/^/  $name: /")"
        else
            pass=$((pass+1)); echo "ok   $name"
        fi
    else
        fail=$((fail+1)); failed="$failed $name"
        echo "FAIL $name (exit $rc):"; sed 's/^/    /' "$log" | tail -40
    fi
done < "$OUT/list.txt"
[ -n "$skipped" ] && echo "skipped:$skipped"
echo "tests: $pass passed ($partial with a part skipped), $skip skipped, $fail failed${failed:+:$failed}"
[ "$fail" -eq 0 ]
