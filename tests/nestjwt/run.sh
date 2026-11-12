#!/bin/sh
# @nestjs/jwt: JwtService sign/verify/decode against @nestjs/jwt 11 + jsonwebtoken 9 on Node (jwt.expected).
# Run from the repository root.
cd "$(dirname "$0")" || exit 1
. ../../tests/env.sh
T=${TMPDIR:-/tmp}/xisto-nestjwt.$$
if XISTO_NODE_COMPAT=1 $X run --no-warnings src/jwt.ts > "$T" 2>&1 && cmp -s "$T" jwt.expected; then
  echo "ok nestjwt"
  rm -f "$T"
else
  echo "FAIL nestjwt"
  diff jwt.expected "$T" | head -20
  rm -f "$T"
  exit 1
fi
