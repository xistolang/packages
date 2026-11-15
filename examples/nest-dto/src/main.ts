import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

// DTO_PIPE=1: the ValidationPipe most Nest apps install (transform, implicit conversion); else no pipe at all
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  if (process.env.DTO_PIPE === "1") {
    app.useGlobalPipes(new ValidationPipe({ transform: true, transformOptions: { enableImplicitConversion: true } }));
  }
  await app.listen(Number(process.env.PORT ?? "3198"));
}
bootstrap();
