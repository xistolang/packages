import { Controller, Get } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";

export class Health {
  status: string;
}

@SkipThrottle()
@Controller("health")
export class HealthController {
  @Get()
  check(): Health {
    return { status: "ok" };
  }
}
