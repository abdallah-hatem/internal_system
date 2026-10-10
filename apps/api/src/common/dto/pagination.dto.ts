import { IsOptional, IsInt, Min, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { assertUuid } from '../uuid';

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

/**
 * The `take`/`cursor`/`skip` for one page after `cursor`.
 *
 * Prisma's cursor is inclusive: `cursor: { id }` alone starts the next page AT
 * the last row of the previous one, so following `nextCursor` showed that row
 * twice. `skip: 1` steps past it. A cursor that cannot be an id is refused
 * here rather than failing the uuid cast deep in Postgres as a 500.
 *
 * The list's `orderBy` must end on `id` so the order is total. Rows written
 * in one transaction share `createdAt` (Postgres `now()` is the transaction
 * start), and a cursor over a tie can skip or repeat rows.
 */
export function cursorPage(
  cursor: unknown,
  limit: number,
): { take: number; cursor?: { id: string }; skip?: number } {
  if (cursor === undefined || cursor === null || cursor === '') {
    return { take: limit + 1 };
  }
  assertUuid(cursor, 'cursor');
  return { take: limit + 1, cursor: { id: cursor }, skip: 1 };
}
