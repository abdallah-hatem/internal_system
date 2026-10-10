import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';

/**
 * The list fetch behind every office list page (L1). A page that searches what
 * it fetched can only find what it fetched, so this must bring back every row,
 * once, or say that it stopped.
 */

type Row = { id: string };
const server = vi.hoisted(() => ({
  rows: [] as Row[],
  /** Endpoints that do not page answer `{ data }` with no meta. */
  paged: true,
  bareArray: false,
  stuckCursor: false,
  calls: [] as Array<{ path: string; params: Record<string, unknown> }>,
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string, config: { params?: Record<string, unknown> } = {}) => {
      const params = config.params ?? {};
      server.calls.push({ path, params });
      if (server.bareArray) return Promise.resolve({ data: server.rows });
      if (!server.paged) return Promise.resolve({ data: { data: server.rows } });
      const limit = Number(params.limit ?? 20);
      const start = params.cursor
        ? server.rows.findIndex((r) => r.id === params.cursor) + 1
        : 0;
      const page = server.rows.slice(start, start + limit);
      const more = start + limit < server.rows.length;
      const nextCursor = server.stuckCursor
        ? server.rows[0].id
        : more
          ? page[page.length - 1].id
          : null;
      return Promise.resolve({ data: { data: page, meta: { nextCursor, limit } } });
    },
  },
}));

import { fetchAll, useAllRecords, LIST_PAGE_SIZE } from './list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}` }));

beforeEach(() => {
  server.rows = [];
  server.paged = true;
  server.bareArray = false;
  server.stuckCursor = false;
  server.calls = [];
});
afterEach(cleanup);

describe('fetchAll', () => {
  it('walks every page: 450 rows come back, each once, in order', async () => {
    server.rows = rows(450);
    const { items, capped } = await fetchAll<Row>('/purchases');
    expect(items.map((r) => r.id)).toEqual(server.rows.map((r) => r.id));
    expect(capped).toBe(false);
    expect(server.calls).toHaveLength(3);
  });

  it('asks for the API’s largest page, not its default 20', async () => {
    server.rows = rows(25);
    const { items } = await fetchAll<Row>('/products');
    expect(items).toHaveLength(25);
    expect(server.calls[0].params.limit).toBe(LIST_PAGE_SIZE);
  });

  it('keeps the caller’s filter on every page, not just the first', async () => {
    server.rows = rows(410);
    await fetchAll<Row>('/sales/orders', { customerId: 'c1' });
    expect(server.calls).toHaveLength(3);
    for (const call of server.calls) expect(call.params.customerId).toBe('c1');
    expect(server.calls[1].params.cursor).toBe('r200');
  });

  it('a list longer than the cap stops there and says so', async () => {
    server.rows = rows(450);
    const { items, capped } = await fetchAll<Row>('/audit-logs', {}, 400);
    expect(items).toHaveLength(400);
    expect(capped).toBe(true);
  });

  it('a list exactly at the cap is complete, not capped', async () => {
    server.rows = rows(400);
    const { items, capped } = await fetchAll<Row>('/audit-logs', {}, 400);
    expect(items).toHaveLength(400);
    expect(capped).toBe(false);
  });

  it('an empty list is empty, not an error', async () => {
    const { items, capped } = await fetchAll<Row>('/ledger');
    expect(items).toEqual([]);
    expect(capped).toBe(false);
  });

  it('an endpoint that does not page is asked once', async () => {
    server.paged = false;
    server.rows = rows(300);
    const { items } = await fetchAll<Row>('/providers');
    expect(items).toHaveLength(300);
    expect(server.calls).toHaveLength(1);
  });

  it('a body that is a bare array is read as the rows', async () => {
    server.bareArray = true;
    server.rows = rows(3);
    expect((await fetchAll<Row>('/x')).items).toHaveLength(3);
  });

  it('a cursor that never moves ends the walk instead of looping for ever', async () => {
    server.rows = rows(450);
    server.stuckCursor = true;
    await fetchAll<Row>('/x');
    expect(server.calls.length).toBeLessThanOrEqual(2);
  });
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useAllRecords', () => {
  it('gives the 25th, newest-last row to the page, not only the first 20', async () => {
    server.rows = rows(25);
    const { result } = renderHook(() => useAllRecords<Row>(['purchases'], '/purchases'), {
      wrapper,
    });
    expect(result.current.items).toEqual([]);
    await waitFor(() => expect(result.current.items).toHaveLength(25));
    expect(result.current.items[24].id).toBe('r25');
    expect(result.current.capped).toBe(false);
  });

  it('the empty list before loading is the same array each render (no effect loops)', () => {
    server.rows = rows(1);
    const { result, rerender } = renderHook(
      () => useAllRecords<Row>(['x'], '/x', undefined, { enabled: false }),
      { wrapper },
    );
    const first = result.current.items;
    rerender();
    expect(result.current.items).toBe(first);
    expect(server.calls).toHaveLength(0);
  });
});

describe('ListCapNotice', () => {
  const show = (messages: typeof en, capped: boolean, locale = 'en') =>
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <ListCapNotice capped={capped} count={2000} />
      </NextIntlClientProvider>,
    );

  it('says how many are shown when the list stopped', () => {
    show(en, true);
    expect(screen.getByRole('status').textContent).toContain('2,000');
  });

  it('says nothing when the list is complete', () => {
    show(en, false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says it in Arabic too', () => {
    show(ar as typeof en, true, 'ar');
    expect(screen.getByRole('status').textContent).toContain('فقط');
  });
});
