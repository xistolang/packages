import { Controller, Get, Param, Query } from "@nestjs/common";
import { ItemParamsDto, ListQueryDto, PageParamsDto, RangeQueryDto, TextQueryDto } from "./dtos";

// what the handler got in a field: its JavaScript type and value (strings without the ValidationPipe's conversion)
function t(v: unknown): string {
  return v == null ? "absent" : `${typeof v}:${String(v)}`;
}

@Controller("dto")
export class DtoController {
  @Get("list")
  list(@Query() q: ListQueryDto) {
    return { page: t(q.page), size: t(q.size), active: t(q.active), order: t(q.order), term: t(q.term), next: (q.page ?? 1) + 1 };
  }

  @Get("range")
  range(@Query() r: RangeQueryDto) {
    return { from: t(r.from), to: t(r.to) };
  }

  @Get("items/:id/:slug")
  item(@Param() p: ItemParamsDto) {
    return { id: t(p.id), slug: t(p.slug) };
  }

  @Get("both/:id/:slug")
  both(@Param() p: ItemParamsDto, @Query() q: ListQueryDto, @Query("term") term: string, @Param("id") id: string) {
    return { id: t(p.id), slug: t(p.slug), page: t(q.page), term: t(q.term), rawTerm: term, rawId: id };
  }

  // DTOs of strings only: what the handler gets is the same with or without a pipe
  @Get("text")
  text(@Query() q: TextQueryDto) {
    return { term: t(q.term), lang: t(q.lang), upper: (q.term ?? "").toUpperCase() };
  }

  @Get("pages/:kind/:slug")
  page(@Param() p: PageParamsDto, @Query() q: TextQueryDto) {
    return { kind: t(p.kind), slug: t(p.slug), term: t(q.term), path: `${p.kind}/${p.slug}` };
  }
}
