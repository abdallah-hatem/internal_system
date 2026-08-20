import { IsOptional, IsInt, Min, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class PaginationDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number = 20;
}

/** Largest page a client may request. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Coerce a page size that arrived from the query string.
 *
 * Controllers type their query as `PaginationDto & { ... }`. An intersection is
 * not a class, so Nest cannot resolve a metatype for it and the ValidationPipe
 * never runs `@Type(() => Number)`. `limit` therefore arrives as a string, and
 * `limit + 1` concatenates instead of adding, which Prisma rejects. Normalising
 * here keeps every list endpoint working whatever the caller sends.
 */
export function pageSize(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}
