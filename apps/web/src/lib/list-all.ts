import { useQuery, type QueryKey } from '@tanstack/react-query';
import { api } from './api';

/**
 * Every record of a list endpoint, for a page that searches or pages on the
 * client (L1).
 *
 * The office pages filter and page what they fetched. Fetching `/purchases`
 * with no limit returned the API's default 20, so the 21st purchase order was
 * not on the page and searching its reference found nothing — the record
 * existed and the screen said it did not. The shipments page hid legs the same
 * way until it asked for 200, which only moved the wall.
 *
 * This walks the API's cursor pages, 200 at a time, until there are none
 * left. A list longer than `LIST_CAP` stops there and says so: `capped` is
 * true, and the page shows `<ListCapNotice>` rather than looking complete.
 */

/** The API's largest page (`MAX_PAGE_SIZE` in the API's pagination.dto). */
export const LIST_PAGE_SIZE = 200;
/** Rows a page loads before it stops and says it stopped. */
export const LIST_CAP = 2000;

export interface AllRecords<T> {
  items: T[];
  /** True when more rows exist than were loaded. */
  capped: boolean;
}

type Params = Record<string, string | number | boolean | undefined>;

export async function fetchAll<T>(
  path: string,
  params: Params = {},
  cap: number = LIST_CAP,
): Promise<AllRecords<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const res = await api.get(path, {
      params: { ...params, limit: LIST_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    });
    const body = res.data;
    const page: T[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    items.push(...page);
    const next: string | null = body?.meta?.nextCursor ?? null;
    // An endpoint that does not page answers once, with no cursor. A cursor
    // that does not move would loop for ever; treat it as the end.
    if (!next || next === cursor || page.length === 0) return { items, capped: false };
    if (items.length >= cap) return { items: items.slice(0, cap), capped: true };
    cursor = next;
  }
}

const NONE: never[] = [];

/**
 * `useQuery` over `fetchAll`. One query key always means one fetch, so two
 * pages sharing `['products']` share the same complete list rather than
 * whichever page size reached the cache first.
 */
export function useAllRecords<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any -- the pages type their rows loosely today
  queryKey: QueryKey,
  path: string,
  params?: Params,
  options: { enabled?: boolean } = {},
) {
  const query = useQuery({
    queryKey,
    queryFn: () => fetchAll<T>(path, params),
    ...options,
  });
  return {
    ...query,
    items: (query.data?.items ?? NONE) as T[],
    capped: query.data?.capped ?? false,
  };
}
