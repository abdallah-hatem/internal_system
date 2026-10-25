import { badRequest } from './api-error';
import { cursorPage, MAX_PAGE_SIZE, pageSize } from './dto/pagination.dto';

/**
 * Search, filters, sorting and pages for an office list — on the server
 * (owner, 2026-10-25: "this is the purpose of pagination, how can you do it
 * client from the first place").
 *
 * The office lists used to load every row and filter, search, sort and page
 * them in the browser. Now a list sends what its URL says — `page`,
 * `pageSize`, `search`, `sort` and its own filters — and the endpoint
 * filters, counts and pages in the query. This file is the one definition of
 * how those parameters are read, refused and answered, so every list pages,
 * searches and refuses the same way (CLAUDE.md §11).
 *
 * Two kinds of caller share each endpoint:
 *
 *   - a list asks for `page` (1-based) and gets `meta.total` and
 *     `meta.totalPages` with its rows;
 *   - a picker, the CSV export or the assistant sends no `page` and walks
 *     `meta.nextCursor` as before. The same filters and search apply, so an
 *     export holds exactly the rows the list was showing.
 */

/** The longest search a list accepts — a name or a reference, not an essay. */
export const SEARCH_MAX = 100;
/** Rows on a page when the list does not say. */
export const LIST_PAGE_SIZE = 10;

/** What any list endpoint reads from its query string. */
export interface ListQuery {
  page?: unknown;
  pageSize?: unknown;
  search?: unknown;
  sort?: unknown;
  cursor?: unknown;
  limit?: unknown;
}

export interface ListMeta {
  /** Page mode only. */
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  /** Cursor mode only (null in page mode: there is no "next" cursor). */
  nextCursor: string | null;
  limit?: number;
}

/** What a refused value was, for the message: text as sent, anything else as JSON. */
export function shown(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

const WHOLE = /^\d+$/;

function whole(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && WHOLE.test(value.trim()))
    return Number(value);
  return null;
}

/**
 * The page asked for, or null when the caller walks cursors instead.
 *
 * A page that is not a whole number from 1, or a page size outside 1–200, is
 * refused: quietly reading `page=abc` as page 1 would show the first rows
 * under a URL that says something else.
 */
export function pageOf(
  query: ListQuery,
): { page: number; pageSize: number; skip: number; take: number } | null {
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  if (empty(query.page) && empty(query.pageSize)) return null;
  const page = empty(query.page) ? 1 : whole(query.page);
  if (page === null || page < 1) {
    throw badRequest(
      'LIST_PAGE_INVALID',
      `page must be a whole number from 1 (got "${shown(query.page)}").`,
      { value: shown(query.page) },
    );
  }
  const size = empty(query.pageSize) ? LIST_PAGE_SIZE : whole(query.pageSize);
  if (size === null || size < 1) {
    throw badRequest(
      'LIST_PAGE_SIZE_INVALID',
      `pageSize must be a whole number from 1 to ${MAX_PAGE_SIZE} (got "${shown(query.pageSize)}").`,
      { value: shown(query.pageSize), max: MAX_PAGE_SIZE },
    );
  }
  return { page, pageSize: size, skip: (page - 1) * size, take: size };
}

/**
 * The search typed into a list, trimmed; '' when there is none.
 * Refused when it is not text or longer than `SEARCH_MAX`.
 */
export function searchOf(query: ListQuery): string {
  const raw = query.search;
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw badRequest('VALIDATION_FAILED', 'search must be text.', {
      fields: 'search',
    });
  }
  const term = raw.trim();
  if (term.length > SEARCH_MAX) {
    throw badRequest(
      'LIST_SEARCH_TOO_LONG',
      `A search can be at most ${SEARCH_MAX} characters (it has ${term.length}).`,
      { max: SEARCH_MAX, length: term.length },
    );
  }
  return term;
}

/**
 * The order a list asked for, by name, from the orders the endpoint offers.
 * The first one is the default. A name the endpoint does not offer is refused
 * rather than ignored, so a mistyped link does not look sorted when it is not.
 */
export function sortOf<K extends string, O>(
  query: ListQuery,
  sorts: Record<K, O>,
): { key: K; orderBy: O } {
  const keys = Object.keys(sorts) as K[];
  const raw = query.sort;
  const key = (
    raw === undefined || raw === null || raw === '' ? keys[0] : raw
  ) as K;
  if (typeof key !== 'string' || !keys.includes(key)) {
    throw badRequest(
      'LIST_SORT_UNKNOWN',
      `This list cannot be sorted by "${shown(raw)}" (it offers ${keys.join(', ')}).`,
      { sort: shown(raw), allowed: keys.join(', ') },
    );
  }
  return { key, orderBy: sorts[key] };
}

/**
 * A filter's value, from the values the list offers; undefined when absent.
 * Anything else is refused here rather than reaching Postgres as an enum it
 * cannot cast, which surfaces as a 500 (CLAUDE.md §1).
 */
export function filterOf<V extends string>(
  value: unknown,
  field: string,
  allowed: readonly V[],
): V | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as V)) {
    throw badRequest(
      'LIST_FILTER_INVALID',
      `${field} cannot be "${shown(value)}" (it can be ${allowed.join(', ')}).`,
      { field, value: shown(value) },
    );
  }
  return value as V;
}

/** Which rows to read: spread into the list's own `findMany`. */
export type RowWindow = {
  take: number;
  skip?: number;
  cursor?: { id: string };
};

/**
 * One page of a list: the rows, and the meta that goes with them.
 *
 *   const { rows, meta } = await listRows(query, {
 *     rows: (window) => db.saleOrder.findMany({ where, orderBy, include, ...window }),
 *     count: () => db.saleOrder.count({ where }),
 *   });
 *
 * With `page` in the query it counts the rows the filter matches and reads
 * that page of them (`orderBy` must end on `id` so pages never overlap).
 * Without it, the next cursor page, as every list did before, and no count.
 * The list writes its own `findMany`, so its rows keep their full type.
 */
export async function listRows<R extends { id: string }>(
  query: ListQuery,
  read: {
    rows: (window: RowWindow) => Promise<R[]>;
    count: () => Promise<number>;
  },
): Promise<{ rows: R[]; meta: ListMeta }> {
  const paging = pageOf(query);
  if (paging) {
    const [total, rows] = await Promise.all([
      read.count(),
      read.rows({ skip: paging.skip, take: paging.take }),
    ]);
    return { rows, meta: pageMeta(paging, total) };
  }
  const limit = pageSize(query.limit ?? 20);
  const items = await read.rows(cursorPage(query.cursor, limit));
  const hasMore = items.length > limit;
  const rows = hasMore ? items.slice(0, limit) : items;
  return {
    rows,
    meta: { nextCursor: hasMore ? rows[rows.length - 1].id : null, limit },
  };
}

/**
 * The same page and meta for a list whose order the database cannot express
 * (a computed column, such as what a customer owes): `ids` are every match,
 * already in order; the caller loads the rows of the page it is given.
 */
export function pageOfIds(
  ids: string[],
  query: ListQuery,
): { pageIds: string[]; meta: ListMeta } {
  const paging = pageOf(query);
  if (paging) {
    return {
      pageIds: ids.slice(paging.skip, paging.skip + paging.take),
      meta: pageMeta(paging, ids.length),
    };
  }
  const limit = pageSize(query.limit ?? 20);
  let start = 0;
  if (
    query.cursor !== undefined &&
    query.cursor !== null &&
    query.cursor !== ''
  ) {
    cursorPage(query.cursor, limit); // refuses a cursor that cannot be an id
    start = ids.indexOf(query.cursor as string) + 1;
    if (start === 0) return { pageIds: [], meta: { nextCursor: null, limit } };
  }
  const pageIds = ids.slice(start, start + limit);
  const more = start + limit < ids.length;
  return {
    pageIds,
    meta: { nextCursor: more ? pageIds[pageIds.length - 1] : null, limit },
  };
}

function pageMeta(
  paging: { page: number; pageSize: number },
  total: number,
): ListMeta {
  return {
    page: paging.page,
    pageSize: paging.pageSize,
    total,
    totalPages: Math.ceil(total / paging.pageSize),
    nextCursor: null,
  };
}
