import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from "class-validator";

// the query of a list route: numbers and booleans come in as strings, the ValidationPipe converts them
export class ListQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Max(100)
  size?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsIn(["asc", "desc"])
  order?: string;

  @IsString()
  @IsNotEmpty()
  term: string;
}

// a query with an explicit @Type: converted also without implicit conversion
export class RangeQueryDto {
  @Type(() => Number)
  @IsInt()
  from: number;

  @Type(() => Number)
  @IsInt()
  to: number;
}

// a query of strings only
export class TextQueryDto {
  @IsString()
  @IsNotEmpty()
  term: string;

  @IsOptional()
  @IsIn(["pt", "en"])
  lang?: string;
}

// route parameters of strings only
export class PageParamsDto {
  @IsIn(["doc", "faq"])
  kind: string;

  @Matches(/^[a-z-]+$/)
  slug: string;
}

// the route's parameters as one object (@Param() p: ItemParamsDto)
export class ItemParamsDto {
  @IsInt()
  @Min(1)
  id: number;

  @IsString()
  @Matches(/^[a-z-]+$/)
  slug: string;
}
