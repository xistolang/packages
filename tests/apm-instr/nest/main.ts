// A Nest application under an agent: web.request spans for a route with a parameter, a POST, a handler that throws
// (500), an HttpException (404), a path no route takes, a request carrying a traceparent; a span of the handler's
// own under the request's; an interceptor that finds the request's span active; nestjs-pino lines with the trace
// ids (APM_ECS=1: ECS lines). GET /done prints the traces (the requests are made one after the other by run.sh).
import { CallHandler, Controller, ExecutionContext, Get, Injectable, Module, NestInterceptor, NotFoundException, Param, Post, Body } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { Logger, LoggerModule, Params } from "nestjs-pino";
import { ecsFormat } from "@elastic/ecs-pino-format";
import { Observable } from "rxjs";
import { ApmSpanOptions, activeSpan, newSpan, runIn } from "xisto-apm";
import { PrintExporter, printIds, startApm } from "../src/exporter";

const ex: PrintExporter = startApm();
printIds(true);

function loggerParams(): Params {
  if ((process.env.get("APM_ECS") ?? "") === "1") return { pinoHttp: ecsFormat({ serviceName: "shop" }), renameContext: "log.logger" };
  return { pinoHttp: { level: "info" } };
}

@Injectable()
export class SpanInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const span = activeSpan();
    if (span !== null) span.setText("interceptor.saw", span.name);
    return next.handle();
  }
}

export class NewItem {
  name: string;
}
export class Item {
  id: string;
  name: string;
}

@Controller("users")
export class UsersController {
  constructor(private readonly logger: Logger) {}

  @Get(":id")
  async one(@Param("id") id: string): Promise<Item> {
    this.logger.log(`user ${id}`, "Users");
    const s = newSpan("users.load", new ApmSpanOptions());
    await runIn(s, async (): Promise<void> => {
      this.logger.log("loading", "Users");
    });
    if (s !== null) s.finish();
    return { id: id, name: "ana" };
  }

  @Post()
  create(@Body() body: NewItem): Item {
    return { id: "7", name: body.name };
  }

  @Get("missing/:id")
  missing(@Param("id") id: string): Item {
    throw new NotFoundException(`no user ${id}`);
  }
}

@Controller()
export class MiscController {
  @Get("boom")
  boom(): string {
    throw new Error("kaboom");
  }

  @Get("done")
  async done(): Promise<string> {
    await ex.print(false);
    return "done";
  }
}

@Module({
  imports: [LoggerModule.forRoot(loggerParams())],
  controllers: [UsersController, MiscController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: SpanInterceptor }],
})
export class AppModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(Number(process.env.get("PORT") ?? "3199"));
}
bootstrap();
