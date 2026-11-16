import { BadRequestException, Controller, Get, HttpException, NotFoundException, Param } from "@nestjs/common";

export class Item {
  id: string;
  name: string;
}

@Controller("items")
export class ItemsController {
  @Get()
  list(): Item[] {
    return [{ id: "1", name: "pen" }];
  }

  @Get("boom")
  boom(): Item {
    throw new Error("the store is down");
  }

  @Get("plain")
  plain(): Item {
    throw new HttpException("a plain text answer", 409);
  }

  @Get("invalid")
  invalid(): Item {
    throw new BadRequestException(["name must be a string", "qty must be a number"]);
  }

  @Get(":id")
  one(@Param("id") id: string): Item {
    if (id !== "1") {
      throw new NotFoundException(`Item ${id} not found`);
    }
    return { id: "1", name: "pen" };
  }
}
