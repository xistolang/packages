#!/bin/sh
# Links the packages this example uses from this checkout into .xisto/pkgs (tests/run.sh uses XISTO_PKGS instead).
cd "$(dirname "$0")" || exit 1
mkdir -p .xisto/pkgs/@nestjs
for p in express rxjs passport-jwt jwks-rsa class-validator class-transformer; do ln -sfn "../../../../$p" ".xisto/pkgs/$p"; done
for p in common core config passport throttler; do ln -sfn "../../../../../@nestjs/$p" ".xisto/pkgs/@nestjs/$p"; done
