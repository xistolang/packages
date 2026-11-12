#!/bin/sh
# Links the packages this example uses from this checkout into .xisto/pkgs (tests/run.sh uses XISTO_PKGS instead).
cd "$(dirname "$0")" || exit 1
mkdir -p .xisto/pkgs/@nestjs
for p in class-validator class-transformer express helmet compression nestjs-pino rxjs; do ln -sfn "../../../../$p" ".xisto/pkgs/$p"; done
for p in common core swagger config schedule platform-express; do ln -sfn "../../../../../@nestjs/$p" ".xisto/pkgs/@nestjs/$p"; done
