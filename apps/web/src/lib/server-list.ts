'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { api } from './api';
import { PAGE_SIZE } from '@/components/ui/pagination';

/**
 * An office list whose search, filters, sorting and pages run on the server
 * (owner, 2026-10-25: "this is the purpose of pagination, how can you do it
 * client from the first place").
 *
 * The URL is the list's state. `page`, `pageSize`, `q` (the search), `sort`
 * and each filter the page names are read from it and sent to the endpoint,
 * which filters, counts and pages in its query (`common/list-query.ts` in the
 * API). Changing any of them writes the URL — so a refresh, a shared link and
 * the back button all show the same rows — and a change of anything but the
 * page goes back to page 1.
 *
 * The cache is keyed by the entity, the endpoint and every parameter sent,
 * so two pages or two filters never answer for each other, and invalidating
 * the entity's key (`['sales']`) refreshes every page of it.
 *
 *   const list = useServerList<SaleOrder>({
 *     queryKey: 'sales',
 *     path: '/sales/orders',
 *     filters: { status: 'status', customer: 'customerId', from: 'from', to: 'to' },
 *   });
 *   list.rows; list.total; list.set('status', 'PAID'); list.setPage(2);
 */

type ApiParams = Record<string, string | number>;

export interface ServerListOptions {
  /** The entity's query key, the one mutations invalidate (`'sales'`). */
  queryKey: string;
  /** The endpoint (`'/sales/orders'`). */
  path: string;
  /**
   * URL parameter -> API parameter, for each filter the list offers; or
   * `{ param, toApi }` when the URL says it in the reader's terms and the API
   * in its own (a ledger type name standing for several type codes).
   */
  filters?: Record<string, string | { param: string; toApi: (value: string) => string }>;
  /**
   * A filter's value when the URL does not name one (Products opens on the
   * active ones). Choosing it again takes it off the URL.
   */
  defaults?: Record<string, string>;
  /** Parameters every request carries, not in the URL (a fixed scope). */
  fixed?: ApiParams;
  enabled?: boolean;
}

/** How long typing rests before the search is sent. */
export const SEARCH_DELAY_MS = 300;

interface Answer<T> {
  data: T[];
  meta?: { total?: number; totalPages?: number; page?: number; pageSize?: number };
}

export function useServerList<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any -- the pages type their rows loosely today
  opts: ServerListOptions,
) {
  const { queryKey, path, filters = {}, defaults = {}, fixed, enabled = true } = opts;
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filterNames = Object.keys(filters);
  const read = (name: string) => searchParams.get(name) ?? '';
  const page = Math.max(1, Number.parseInt(read('page'), 10) || 1);
  const pageSize = Number.parseInt(read('pageSize'), 10) || PAGE_SIZE;
  const q = read('q');
  const sort = read('sort');
  const filterValues = Object.fromEntries(filterNames.map((n) => [n, read(n) || defaults[n] || '']));
  const filterKey = JSON.stringify(filterValues);
  // `fixed` and `defaults` are literals at the call site, new on every
  // render; their content is what the memos below depend on.
  const fixedKey = JSON.stringify(fixed ?? {});
  const defaultsKey = JSON.stringify(defaults);

  /** What the endpoint is sent: only what is set. */
  const params = useMemo<ApiParams>(() => {
    const out: ApiParams = { ...(JSON.parse(fixedKey) as ApiParams), page, pageSize };
    if (q.trim()) out.search = q.trim();
    if (sort) out.sort = sort;
    for (const [name, value] of Object.entries(JSON.parse(filterKey) as Record<string, string>)) {
      const spec = filters[name];
      if (!value) continue;
      if (typeof spec === 'string') out[spec] = value;
      else out[spec.param] = spec.toApi(value);
    }
    return out;
    // `filters` is a literal at the call site; the values it maps are in filterKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, q, sort, filterKey, fixedKey]);

  const query = useQuery({
    queryKey: [queryKey, path, params],
    queryFn: () => api.get(path, { params }).then((r) => r.data as Answer<T>),
    placeholderData: keepPreviousData,
    // A list is read again on every visit, the cached page showing meanwhile:
    // the app's minute of freshness would otherwise show a page that another
    // screen's change (a payment reversed moves a sale's status) or another
    // partner has since made untrue, on the second visit (CLAUDE.md §0).
    staleTime: 0,
    enabled,
  });

  // The address as last written. A write does not land in `searchParams`
  // until Next commits it, so two writes close together — a date picked while
  // the search is still waiting to be sent — would each start from the URL
  // before the other and the second would drop the first. Each write starts
  // from this instead; the URL changing on its own (back button) resets it.
  const urlKey = searchParams.toString();
  const latest = useRef(urlKey);
  useEffect(() => {
    latest.current = urlKey;
  }, [urlKey]);

  /** Write some parameters to the URL; '' or null removes one. */
  const write = useCallback(
    (changes: Record<string, string | number | null>, keepPage = false) => {
      const next = new URLSearchParams(latest.current);
      const byDefault = JSON.parse(defaultsKey) as Record<string, string>;
      for (const [name, value] of Object.entries(changes)) {
        const gone =
          value === null ||
          value === '' ||
          value === byDefault[name] ||
          (name === 'page' && Number(value) <= 1);
        if (gone) next.delete(name);
        else next.set(name, String(value));
      }
      if (!keepPage) next.delete('page');
      const qs = next.toString();
      latest.current = qs;
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, defaultsKey],
  );

  // The search box answers every key at once; the URL, and so the request,
  // follows when typing rests.
  const [searchText, setSearchText] = useState(q);
  const typed = useRef(q);
  useEffect(() => {
    // The URL changed under us (back button, Clear): the box follows it.
    if (q !== typed.current) {
      typed.current = q;
      setSearchText(q);
    }
  }, [q]);
  useEffect(() => {
    if (searchText === typed.current) return;
    const timer = setTimeout(() => {
      typed.current = searchText;
      write({ q: searchText });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText, write]);

  const total = query.data?.meta?.total ?? 0;
  const totalPages = query.data?.meta?.totalPages ?? 0;

  // A page past the end (the last row of the last page deleted, an old
  // link): go to the last page there is rather than show an empty one.
  useEffect(() => {
    if (query.isPlaceholderData || !query.data) return;
    if (page > 1 && totalPages > 0 && page > totalPages) write({ page: totalPages }, true);
  }, [page, totalPages, query.isPlaceholderData, query.data, write]);

  const clearWith = (also: string[]) => {
    typed.current = '';
    setSearchText('');
    write(Object.fromEntries(['q', ...filterNames, ...also].map((n) => [n, null])));
  };

  const filtered =
    Boolean(q.trim()) || filterNames.some((n) => filterValues[n] && filterValues[n] !== defaults[n]);

  return {
    rows: (query.data?.data ?? NONE) as T[],
    /** Whatever else the endpoint said about the list (a cycle's status counts). */
    meta: query.data?.meta as Record<string, unknown> | undefined,
    total,
    totalPages,
    page,
    pageSize,
    /** The rows came back for this URL and there are none. */
    isLoading: query.isLoading,
    /** The rows on screen are the previous parameters' while new ones load. */
    reloading: query.isFetching && query.isPlaceholderData,
    error: query.error,
    refetch: query.refetch,
    /** Any search or filter set: an empty answer means "nothing matches", not "nothing yet". */
    filtered,
    search: searchText,
    setSearch: setSearchText,
    sort,
    setSort: (value: string | null) => write({ sort: value }),
    get: (name: string) => filterValues[name] ?? '',
    set: (name: string, value: string | null) => write({ [name]: value }),
    setMany: (changes: Record<string, string | null>) => write(changes),
    setPage: (n: number) => write({ page: n }, true),
    /** Clear the search and every filter (the sort stays: it is not a filter). */
    clear: () => clearWith([]),
    /**
     * The same, and parameters the page keeps beside them (the audit log's
     * person), in one write: a second write of the page's own would start from
     * the address before this one and put the search back.
     */
    clearWith,
    /** The API parameters without the page, for an export of every match. */
    exportParams: Object.fromEntries(
      Object.entries(params).filter(([name]) => name !== 'page' && name !== 'pageSize'),
    ),
  };
}

const NONE: never[] = [];

