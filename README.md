# xisto packages

Ports of npm packages for [xisto](https://github.com/xistolang/xisto), the TypeScript → native compiler. Each
folder at the root is one package, named as on npm (`pg`, `typeorm`, `@nestjs/common`...): a `xisto.json`, the
TypeScript source (`index.ts`) and, for some, C in `native/`. A program keeps its imports as they are
(`import { Pool } from "pg"`) and gets this code instead of the npm package.

## Use

```sh
xisto add @nestjs/common          # from this repository (the default registry), locked by commit in xisto.lock
xisto build --pkgs ~/src/packages -o app src/main.ts   # or straight from a checkout of this repository
```

`xisto add <npm name>` reads this repository's root layout (`<name>/xisto.json`). With `--pkgs DIR` (or
`XISTO_PKGS=DIR`) the compiler finds every package in a checkout, with nothing installed in the project.

## Packages

| Package | Implements (npm) |
| --- | --- |
| `@elastic/ecs-pino-format` | `@elastic/ecs-pino-format` ^1 |
| `@elastic/elasticsearch` | `@elastic/elasticsearch` ^8 |
| `@nestjs/common` | `@nestjs/common` ^10 |
| `@nestjs/config` | `@nestjs/config` ^3 |
| `@nestjs/core` | `@nestjs/core` ^10 |
| `@nestjs/jwt` | `@nestjs/jwt` ^11 |
| `@nestjs/mongoose` | `@nestjs/mongoose` ^11 |
| `@nestjs/passport` | `@nestjs/passport` ^10 or ^11 |
| `@nestjs/platform-express` | `@nestjs/platform-express` ^10 |
| `@nestjs/schedule` | `@nestjs/schedule` ^4 |
| `@nestjs/swagger` | `@nestjs/swagger` ^7 |
| `@nestjs/throttler` | `@nestjs/throttler` ^6 |
| `@nestjs/typeorm` | `@nestjs/typeorm` ^10 |
| `argon2` | `argon2` ^0.41 |
| `class-transformer` | `class-transformer` ^0.5 |
| `class-validator` | `class-validator` ^0.14 |
| `compression` | `compression` ^1 |
| `dd-trace` | `dd-trace` ^5 (traces to the Datadog Agent; see APM below) |
| `elastic-apm-node` | `elastic-apm-node` ^4 (manual API; intake v2 exporter) |
| `exceljs` | `exceljs` ^4 |
| `express` | `@types/express` ^4 (the Express API) |
| `helmet` | `helmet` ^7 |
| `ioredis` | `ioredis` ^5 |
| `jose` | `jose` ^5 |
| `jsonwebtoken` | `jsonwebtoken` ^9 |
| `jwks-rsa` | `jwks-rsa` ^3 or ^4 |
| `mongodb` | `mongodb` ^6, `bson` ^6 |
| `mongoose` | `mongoose` ^8 |
| `nestjs-pino` | `nestjs-pino` ^4 |
| `newrelic` | `newrelic` ^12 or ^14 (API; traces to New Relic's OTLP entry) |
| `oracledb` | `oracledb` ^6 (thin mode) |
| `passport-jwt` | `passport-jwt` ^4 |
| `pg` | `pg` ^8 |
| `redis` | `redis` ^4 |
| `reflect-metadata` | `reflect-metadata` ^0.2 |
| `rxjs` | `rxjs` ^7 |
| `slug` | `slug` ^1 |
| `typeorm` | `typeorm` ^0.3 |
| `xisto-apm` | (xisto's own: the tracing core of the APM packages, and the hooks the other packages call) |

## APM

`dd-trace` and the other APM agents build on `xisto-apm`. A native binary cannot patch modules at run time as Node's
agents do, so the packages that an agent instruments (`@nestjs/core`, `express`, `pg`, `oracledb`, `mongodb`,
`redis`, `ioredis`, `@elastic/elasticsearch`, the pino loggers) call `xisto-apm`'s hooks themselves. With no agent
started, each hook costs one boolean test. `dd-trace` sends to the Datadog Agent (`/v0.4/traces`), and its spans
carry the same names and tags as the real dd-trace's: `tests/apm/dd` compares them with dd-trace 5.131.1 on Node.

## Tests

```sh
sh tests/run.sh                          # xisto on PATH
sh tests/run.sh --xisto ~/src/xisto/build/xisto
sh tests/run.sh typeorm nest-forms       # some of them
```

Each test builds programs (`tests/*`, and the Nest applications in `examples/*`) against the packages of this
checkout and compares their output with what the same source prints on Node with the real npm packages (the
expected files are checked in). Needs a C compiler, python3, curl and nc; Node for the Elasticsearch fake cluster.
The tests that need a database print a `skip:` line when its server is not reachable: PostgreSQL on
127.0.0.1:55432 (`pg`, `typeorm`), Redis on 127.0.0.1:56379 (`redis`, `ioredis`), MongoDB at `XISTO_MONGO_URL`
(`mongoose`) and Oracle at `XISTO_ORACLE_URL=oracle://user:password@host:port/service` (`oracledb`, `typeorm`).

## Contributing

A change to a package must make it behave like the real npm package on Node: the same output for the same
program. Add or extend a test that shows it (its expected file is the output on Node with the npm package, at the
version in `implements`), and keep `sh tests/run.sh` passing.

## License

Apache License 2.0 with LLVM Exceptions, as the compiler (see `LICENSE`).
