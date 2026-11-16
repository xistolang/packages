import { Module } from "@nestjs/common";
import { DtoController } from "./dto.controller";

@Module({
  controllers: [DtoController],
})
export class AppModule {}
