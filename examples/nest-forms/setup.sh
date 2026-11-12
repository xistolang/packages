#!/bin/sh
# Links the packages this example uses from this checkout into .xisto/pkgs (tests/run.sh uses XISTO_PKGS instead).
cd "$(dirname "$0")" || exit 1
mkdir -p .xisto/pkgs/@nestjs
for p in class-validator class-transformer express rxjs nestjs-pino reflect-metadata; do ln -sfn "../../../../$p" ".xisto/pkgs/$p"; done
for p in common core config platform-express swagger; do ln -sfn "../../../../../@nestjs/$p" ".xisto/pkgs/@nestjs/$p"; done
mkdir -p .xisto/pkgs/@elastic
ln -sfn "../../../../../@elastic/ecs-pino-format" ".xisto/pkgs/@elastic/ecs-pino-format"
