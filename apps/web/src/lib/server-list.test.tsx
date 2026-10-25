import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSyncExternalStore, type ReactNode } from 'react';

/**
 * The hook behind every office list since search, filters, sorting and pages
 * moved to the server (owner 2026-10-25). What a list shows is what the URL
 * says, sent to the API: these pin what is sent, how the URL changes, and
 * that a client-side shortcut would give a different answer — the fake server
 * holds more rows than a page and filters them itself.
 */

type Row = { id: string; status: string; name: string };

const server = vi.hoisted(() => ({
  rows: [] as { id: string; status: string; name: string }[],
  calls: [] as Array<{ path: string; params: Record<string, string | number> }>,
  /** Answer with this HTTP status instead of rows. */
  failWith: 0,
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string, config: { params?: Record<string, string | number> } = {}) => {
      const params = config.params ?? {};
      server.calls.push({ path, params });
      if (server.failWith) {
        const err = Object.assign(new Error(`HTTP ${server.failWith}`), {
          response: { status: server.failWith, data: { error: { code: 'X', message: 'x' } } },
        });
        return Promise.reject(err);
      }
      const matching = server.rows.filter(
        (r) =>
          (!params.status || r.status === params.status) &&
          (!params.search || r.name.includes(String(params.search))),
      );
      const page = Number(params.page);
      const size = Number(params.pageSize);
      const data = matching.slice((page - 1) * size, page * size);
      return Promise.resolve({
        data: {
          data,
          meta: { page, pageSize: size, total: matching.length, totalPages: Math.ceil(matching.length / size) },
        },
      });
    },
  },
}));

// The address bar: a store the hook reads and `router.replace` writes, so a
// change re-renders the hook as Next's would.
const nav = vi.hoisted(() => {
  let query = '';
  const listeners = new Set<() => void>();
  return {
    get query() {
      return query;
    },
    set(next: string) {
      query = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    replace: vi.fn(),
    /** When true, a replace waits in `pending` until `flush`, as Next commits a navigation later. */
    deferred: false,
    pending: [] as string[],
    flush() {
      for (const url of this.pending.splice(0)) this.set(url.split('?')[1] ?? '');
    },
  };
});
vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    const q = useSyncExternalStore(nav.subscribe, () => nav.query);
    return new URLSearchParams(q);
  },
  usePathname: () => '/en/sales',
  useRouter: () => ({
    replace: (url: string) => {
      nav.replace(url);
      if (nav.deferred) nav.pending.push(url);
      else nav.set(url.split('?')[1] ?? '');
    },
  }),
}));

import { SEARCH_DELAY_MS, useServerList } from './server-list';

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

/** 25 rows: 15 PAID named "paid-…", 10 DRAFT named "draft-…". */
function seed() {
  server.rows = Array.from({ length: 25 }, (_, i) => ({
    id: `r${i + 1}`,
    status: i < 15 ? 'PAID' : 'DRAFT',
    name: i < 15 ? `paid-${i + 1}` : `draft-${i + 1}`,
  }));
}

const useSales = () =>
  useServerList<Row>({
    queryKey: 'sales',
    path: '/sales/orders',
    filters: { status: 'status', customer: 'customerId' },
  });

const lastCall = () => server.calls[server.calls.length - 1];

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.calls = [];
  server.failWith = 0;
  nav.set('');
  nav.replace.mockReset();
  nav.deferred = false;
  nav.pending = [];
  seed();
});
afterEach(cleanup);

describe('useServerList — the URL is sent to the API', () => {
  it('page 1 of 10 by default, and the total is the server\'s, not the rows on screen', async () => {
    const { result } = renderHook(useSales, { wrapper });
    await waitFor(() => expect(result.current.rows).toHaveLength(10));
    expect(lastCall()).toEqual({ path: '/sales/orders', params: { page: 1, pageSize: 10 } });
    expect(result.current.total).toBe(25);
    expect(result.current.totalPages).toBe(3);
  });

  it('?page=3&status=PAID&customer=c1&q=paid maps to page/status/customerId/search', async () => {
    nav.set('page=2&status=PAID&customer=c1&q=paid');
    const { result } = renderHook(useSales, { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(lastCall().params).toEqual({
      page: 2,
      pageSize: 10,
      status: 'PAID',
      customerId: 'c1',
      search: 'paid',
    });
    // The server filtered: page 2 of the 15 PAID rows is the last five.
    expect(result.current.rows.map((r) => r.id)).toEqual(['r11', 'r12', 'r13', 'r14', 'r15']);
    expect(result.current.total).toBe(15);
  });

  it('a parameter the list does not own is not sent (?order= opens a popup, it filters nothing)', async () => {
    nav.set('order=o-1&new=1');
    renderHook(useSales, { wrapper });
    await waitFor(() => expect(server.calls.length).toBeGreaterThan(0));
    expect(lastCall().params).toEqual({ page: 1, pageSize: 10 });
  });

  it('a filter mapped through toApi sends the API its own words; a default is sent when the URL is silent', async () => {
    const { result } = renderHook(
      () =>
        useServerList<Row>({
          queryKey: 'products',
          path: '/products',
          filters: { status: { param: 'status', toApi: (v) => (v === 'ALL' ? '' : v) } },
          defaults: { status: 'ACTIVE' },
        }),
      { wrapper },
    );
    await waitFor(() => expect(server.calls.length).toBe(1));
    expect(lastCall().params.status).toBe('ACTIVE');
    // The default is not "filtered": an empty answer is "nothing yet".
    expect(result.current.filtered).toBe(false);
    act(() => result.current.set('status', 'ALL'));
    expect(nav.query).toBe('status=ALL');
    await waitFor(() => expect(lastCall().params.status).toBe(''));
    // Choosing the default again takes it off the URL.
    act(() => result.current.set('status', 'ACTIVE'));
    expect(nav.query).toBe('');
  });
});

describe('useServerList — changing the list writes the URL', () => {
  it('a filter goes back to page 1 and keeps the parameters it does not own', async () => {
    nav.set('page=3&order=o-9');
    const { result } = renderHook(useSales, { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.set('status', 'DRAFT'));
    expect(nav.query).toBe('order=o-9&status=DRAFT');
    await waitFor(() => expect(result.current.total).toBe(10));
  });

  it('a page change keeps the filters; page 1 is not written at all', async () => {
    nav.set('status=PAID');
    const { result } = renderHook(useSales, { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.setPage(2));
    expect(nav.query).toBe('status=PAID&page=2');
    act(() => result.current.setPage(1));
    expect(nav.query).toBe('status=PAID');
  });

  it('typing is sent once it rests, as one request — not one per key', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderHook(useSales, { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      const before = server.calls.length;
      for (const text of ['d', 'dr', 'dra', 'draf', 'draft']) act(() => result.current.setSearch(text));
      // The box shows every key at once…
      expect(result.current.search).toBe('draft');
      expect(nav.query).toBe('');
      await act(async () => {
        vi.advanceTimersByTime(SEARCH_DELAY_MS + 10);
      });
      // …and the URL, and the API, see the word once.
      expect(nav.query).toBe('q=draft');
      await waitFor(() => expect(result.current.total).toBe(10));
      const sent = server.calls.slice(before).map((c) => c.params.search);
      expect(sent).toEqual(['draft']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a filter picked while the search is still waiting keeps both, though neither has landed in the URL yet', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderHook(useSales, { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      // Next commits a navigation after the click, not during it.
      nav.deferred = true;
      act(() => result.current.setSearch('draft'));
      act(() => result.current.set('status', 'DRAFT'));
      await act(async () => {
        vi.advanceTimersByTime(SEARCH_DELAY_MS + 10);
      });
      act(() => nav.flush());
      expect(new URLSearchParams(nav.query).get('status')).toBe('DRAFT');
      expect(new URLSearchParams(nav.query).get('q')).toBe('draft');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Clear takes the search and every filter off, the sort stays', async () => {
    nav.set('q=paid&status=PAID&customer=c1&sort=balance&page=2');
    const { result } = renderHook(useSales, { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.filtered).toBe(true);
    act(() => result.current.clear());
    expect(nav.query).toBe('sort=balance');
    expect(result.current.search).toBe('');
  });

  it('the back button (the URL changing under it) puts the old search back in the box', async () => {
    nav.set('q=paid');
    const { result } = renderHook(useSales, { wrapper });
    await waitFor(() => expect(result.current.search).toBe('paid'));
    act(() => nav.set('q=draft'));
    await waitFor(() => expect(result.current.search).toBe('draft'));
  });

  it('a page past the end (an old link) moves to the last page there is', async () => {
    nav.set('page=9');
    renderHook(useSales, { wrapper });
    await waitFor(() => expect(nav.query).toBe('page=3'));
  });
});

describe('useServerList — the cache, the empty list and refusals', () => {
  it('each page and filter is its own cache entry: going back to page 1 is not refetched', async () => {
    const { result } = renderHook(useSales, { wrapper });
    await waitFor(() => expect(result.current.rows[0]?.id).toBe('r1'));
    act(() => result.current.setPage(2));
    await waitFor(() => expect(result.current.rows[0]?.id).toBe('r11'));
    const keys = client.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toContainEqual(['sales', '/sales/orders', { page: 1, pageSize: 10 }]);
    expect(keys).toContainEqual(['sales', '/sales/orders', { page: 2, pageSize: 10 }]);
  });

  it('invalidating the entity (what a mutation does) refetches the page showing', async () => {
    const { result } = renderHook(useSales, { wrapper });
    await waitFor(() => expect(result.current.total).toBe(25));
    server.rows = server.rows.slice(0, 4);
    await act(() => client.invalidateQueries({ queryKey: ['sales'] }));
    await waitFor(() => expect(result.current.total).toBe(4));
  });

  it('no rows for a search is "nothing matches", not "nothing yet"', async () => {
    nav.set('q=nothing-like-this');
    const { result } = renderHook(useSales, { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.filtered).toBe(true);
  });

  it.each([422, 502])('a %i is an error the page can say, with no rows pretending to be the answer', async (status) => {
    server.failWith = status;
    const { result } = renderHook(useSales, { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect((result.current.error as unknown as { response: { status: number } }).response.status).toBe(status);
    expect(result.current.rows).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('the export asks for every match: the filters, without the page', async () => {
    nav.set('status=PAID&q=paid&page=2');
    const { result } = renderHook(useSales, { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.exportParams).toEqual({ status: 'PAID', search: 'paid' });
  });
});
