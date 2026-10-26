import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { isBelowMinStock } from './list-params';

describe('isBelowMinStock (inventory ?stock=low) — the dashboard count\'s rule', () => {
  const row = (totalStock: number | string, product: object | null) => ({
    totalStock,
    batches: [{ product }],
  });

  it('under the minimum is low', () => {
    expect(isBelowMinStock(row(4, { minStock: 5, status: 'ACTIVE' }))).toBe(true);
  });

  it('exactly at the minimum is not low (the API uses <, not <=)', () => {
    expect(isBelowMinStock(row(5, { minStock: '5.000', status: 'ACTIVE' }))).toBe(false);
  });

  it('a product with no minimum set is never low, however little is left', () => {
    expect(isBelowMinStock(row(0, { minStock: null, status: 'ACTIVE' }))).toBe(false);
  });

  it('an inactive product is not counted, as on the dashboard', () => {
    expect(isBelowMinStock(row(0, { minStock: 5, status: 'INACTIVE' }))).toBe(false);
  });

  it('sold out (0 on hand) with a minimum is low', () => {
    expect(isBelowMinStock(row(0, { minStock: 1, status: 'ACTIVE' }))).toBe(true);
  });

  it('a row with no batches or no product attached is not low (nothing to compare)', () => {
    expect(isBelowMinStock({ totalStock: 0, batches: [] })).toBe(false);
    expect(isBelowMinStock({ totalStock: 0 })).toBe(false);
    expect(isBelowMinStock(row(0, null))).toBe(false);
  });
});

// ── useOpenFromQuery ─────────────────────────────────────────────────
const nav = vi.hoisted(() => ({
  query: '',
  pathname: '/en/sales',
  replace: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace }),
}));

import { useOpenFromQuery } from '@/lib/open-from-query';

describe('useOpenFromQuery (the quick actions\' landing)', () => {
  beforeEach(() => {
    nav.query = '';
    nav.replace.mockReset();
  });
  afterEach(cleanup);

  it('?new=1 opens the form once and drops the parameter without scrolling', () => {
    nav.query = 'new=1';
    const open = vi.fn();
    const { rerender } = renderHook(() => useOpenFromQuery(open));
    rerender();
    rerender();
    expect(open).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith('/en/sales', { scroll: false });
  });

  it('keeps any other parameter on the URL', () => {
    nav.query = 'new=1&customer=c1';
    renderHook(() => useOpenFromQuery(vi.fn()));
    expect(nav.replace).toHaveBeenCalledWith('/en/sales?customer=c1', { scroll: false });
  });

  it('without the parameter, or with another value, nothing opens', () => {
    const open = vi.fn();
    renderHook(() => useOpenFromQuery(open));
    nav.query = 'new=yes';
    renderHook(() => useOpenFromQuery(open));
    expect(open).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('waits until the page says it is ready, then opens', () => {
    nav.query = 'new=1';
    const open = vi.fn();
    const { rerender } = renderHook(({ ready }) => useOpenFromQuery(open, { ready }), {
      initialProps: { ready: false },
    });
    expect(open).not.toHaveBeenCalled();
    rerender({ ready: true });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('the second arrival on a page still mounted opens it again (the second visit)', () => {
    nav.query = 'new=1';
    const open = vi.fn();
    const { rerender } = renderHook(() => useOpenFromQuery(open));
    nav.query = ''; // the parameter dropped
    rerender();
    nav.query = 'new=1'; // the quick action clicked again
    rerender();
    expect(open).toHaveBeenCalledTimes(2);
  });
});
