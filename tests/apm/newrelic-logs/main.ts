// newrelic's application logging (logs in context) on nestjs-pino lines: local decorating appends
// " NR-LINKING|entity.guid|hostname|trace.id|span.id|entity.name|" to each message (the ids of the transaction's
// current segment, none outside a transaction); forwarding sends each line, and recordLogEvent's, with those ids.
// Lines in a web transaction, in a segment, after an await in a background transaction, and outside.
import newrelic from "newrelic";
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
  logger.log("before any transaction", "Main");
  newrelic.startWebTransaction("/checkout", () => {
    logger.log("in checkout", "Shop");
    newrelic.startSegment("db.query", true, () => {
      shop.warn("slow query");
    });
    newrelic.recordLogEvent({ message: "cart priced", level: "INFO" });
    shop.log("back in checkout");
  });
  await newrelic.startBackgroundTransaction("rebuild", "jobs", async () => {
    await sleep(5);
    logger.error("after await", "Job");
  });
  logger.log("after the transactions", "Main");
  await new Promise<void>((resolve) => newrelic.shutdown({ collectPendingData: true }, () => resolve()));
}
main();
