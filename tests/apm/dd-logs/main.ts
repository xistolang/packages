// dd-trace's log injection (logInjection, DD_LOGS_INJECTION; on by default in dd-trace 5): nestjs-pino lines get a
// "dd" object (trace_id, span_id, service, version, env) at the end of the line, the ids of the span active when the
// line is written; outside a span only the service, version and env. Lines inside trace() (sync and async, nested),
// from Nest's Logger once useLogger() made pino its logger, and outside any span.
import tracer from "dd-trace";
tracer.init({
  service: "shop",
  env: "test",
  version: "1.2.3",
  hostname: "127.0.0.1",
  port: Number(process.env.APM_DD_PORT ?? "8126"),
  flushInterval: 50,
  startupLogs: false,
  runtimeMetrics: false,
});
import { Logger as NestLogger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger, LoggerModule } from "nestjs-pino";

@Module({ imports: [LoggerModule.forRoot({ pinoHttp: { level: "info" } })] })
export class AppModule {}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const logger = app.get(Logger);
  app.useLogger(logger);
  const shop = new NestLogger("Shop");
  logger.log("before any span", "Main");
  tracer.trace("checkout", { resource: "POST /checkout", type: "web" }, () => {
    logger.log("in checkout", "Shop");
    tracer.trace("db.query", { resource: "SELECT * FROM cart", type: "sql" }, () => {
      shop.warn("slow query");
    });
    shop.log("back in checkout");
  });
  await tracer.trace("nightly.job", { resource: "rebuild-index" }, async () => {
    await sleep(5);
    logger.error("after await", "Job");
    tracer.trace("job.step", {}, () => {
      shop.log("in step");
    });
  });
  logger.log("after the spans", "Main");
}
main();
