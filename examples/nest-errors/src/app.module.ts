import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AllExceptionsFilter } from "./all-exceptions.filter";
import { HealthController } from "./health.controller";
import { ItemsController } from "./items.controller";
import { LoggingInterceptor } from "./logging.interceptor";

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 3 }])],
  controllers: [HealthController, ItemsController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
