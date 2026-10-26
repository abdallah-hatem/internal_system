import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import ProductDetailPage from '@/app/[locale]/products/[id]/page';

/**
 * The product page's Units sold tile (owner 2026-10-26: "a card to display how
 * many units were sold"). The figure is the server's — units on confirmed
 * sales less units returned (api common/units-sold.ts) — shown as sent, never
 * summed here; in Arabic too. Five tiles leave none alone in a row, and the
 * skeleton traces the same five.
 */

const state = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'ar',
  product: {} as Record<string, unknown>,
  inventoryPending: false,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'prod-1', locale: state.locale }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/en/products/prod-1',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const base = {
  id: 'prod-1', sku: 'BRK-1', name: 'Brake pad', nameAr: 'تيل فرامل', status: 'ACTIVE', minStock: 2,
  createdAt: '2026-10-19T14:06:00Z',
  category: { id: 'cat-1', name: 'Brakes' },
  prices: [],
  listPrices: {
    B2B: { amount: '1221.00', currency: 'EGP', source: 'DEFAULT', markupPct: 20 },
    B2C: { amount: '1221.00', currency: 'EGP', source: 'DEFAULT', markupPct: 20 },
  },
};
// Batches whose numbers would give a different answer if the page summed
// anything itself: 12 on the shelf, 40 received.
const stock = {
  productId: 'prod-1', productName: 'Brake pad', totalStock: 12, reservedStock: 0, availableStock: 12,
  stockValueEgp: 2034.4,
  batches: [
    {
      id: 'b-1', cycleId: 'c-1', cycle: { code: 'CYC-2026-0001' }, receivedQty: 40, remainingQty: 12,
      landedUnitCostEgp: 169.53, arrivedOn: '2026-10-18', receivedAt: '2026-10-19T14:06:00Z',
    },
  ],
};

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/products/prod-1') return Promise.resolve({ data: { data: state.product } });
      if (url === '/inventory') {
        return state.inventoryPending ? new Promise(() => {}) : Promise.resolve({ data: { data: [stock] } });
      }
      return Promise.resolve({ data: { data: [] } });
    },
    post: () => new Promise(() => {}),
    put: () => new Promise(() => {}),
    delete: () => new Promise(() => {}),
  },
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(() => {
  cleanup();
  state.locale = 'en';
  state.inventoryPending = false;
});

function renderPage(product: Record<string, unknown>, locale: 'en' | 'ar' = 'en') {
  state.locale = locale;
  state.product = product;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ProductDetailPage />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/** The tile around an element: the grid's direct child. */
const tileOf = (el: Element) => {
  let node = el as HTMLElement;
  while (node.parentElement && node.parentElement.dataset.testid !== 'product-stats') node = node.parentElement;
  return node;
};

describe('Units sold', () => {
  it('shows the server’s figure and the orders under it, beside the other tiles', async () => {
    renderPage({ ...base, unitsSold: 1234, unitsSoldOrders: 31 });
    const figure = await screen.findByTestId('product-units-sold');
    expect(figure.textContent).toBe('1,234');
    // Isolated left to right, as every figure on the page is.
    expect(figure.tagName).toBe('BDI');
    expect(figure.getAttribute('dir')).toBe('ltr');
    const tile = tileOf(figure);
    expect(tile.textContent).toContain(en.products.unitsSold);
    expect(screen.getByTestId('product-units-sold-orders').textContent).toBe('across 31 orders');
    // A fifth tile in the same grid as Total Stock, Available, Stock value and Samples.
    expect(screen.getByTestId('product-stats').children).toHaveLength(5);
    expect(screen.getByTestId('product-stats').lastElementChild).toBe(tile);
  });

  it('one order reads in the singular; no orders, no second line; nothing sold reads 0', async () => {
    renderPage({ ...base, unitsSold: 2.5, unitsSoldOrders: 1 });
    expect((await screen.findByTestId('product-units-sold')).textContent).toBe('2.5');
    expect(screen.getByTestId('product-units-sold-orders').textContent).toBe('across 1 order');
    cleanup();

    renderPage({ ...base, unitsSold: 0, unitsSoldOrders: 0 });
    expect((await screen.findByTestId('product-units-sold')).textContent).toBe('0');
    expect(screen.queryByTestId('product-units-sold-orders')).toBeNull();
    cleanup();

    // An older API that sends nothing: 0, never a blank or NaN.
    renderPage({ ...base });
    expect((await screen.findByTestId('product-units-sold')).textContent).toBe('0');
  });

  it('in Arabic: the Arabic label and plural, Latin digits', async () => {
    renderPage({ ...base, unitsSold: 1234, unitsSoldOrders: 31 }, 'ar');
    const figure = await screen.findByTestId('product-units-sold');
    expect(figure.textContent).toBe('1,234');
    expect(tileOf(figure).textContent).toContain(ar.products.unitsSold);
    expect(ar.products.unitsSold).not.toBe(en.products.unitsSold);
    expect(screen.getByTestId('product-units-sold-orders').textContent).toBe('في 31 طلبًا');
    cleanup();

    renderPage({ ...base, unitsSold: 4, unitsSoldOrders: 2 }, 'ar');
    expect((await screen.findByTestId('product-units-sold-orders')).textContent).toBe('في طلبين');
  });

  it('five tiles leave none alone: two across with the fifth spanning on a phone, 3 + 2 from md, one row of five from xl', async () => {
    renderPage({ ...base, unitsSold: 9, unitsSoldOrders: 3 });
    await screen.findByTestId('product-units-sold');
    const grid = screen.getByTestId('product-stats');
    expect(grid.className.split(' ')).toEqual(
      expect.arrayContaining(['grid-cols-2', 'md:grid-cols-6', 'xl:grid-cols-5']),
    );
    const spans = [...grid.children].map((c) => c.className.split(/\s+/));
    // Phone: only the fifth spans the row.
    expect(spans.map((c) => c.includes('col-span-2'))).toEqual([false, false, false, false, true]);
    // md–lg: 2 + 2 + 2 = 6, then 3 + 3 = 6.
    expect(spans.map((c) => c.find((x) => x.startsWith('md:col-span-')))).toEqual([
      'md:col-span-2', 'md:col-span-2', 'md:col-span-2', 'md:col-span-3', 'md:col-span-3',
    ]);
    // xl: one column each, five across.
    expect(spans.every((c) => c.includes('xl:col-span-1'))).toBe(true);
  });

  it('the skeleton traces the same five tiles in the same grid', async () => {
    state.inventoryPending = true;
    const { container } = renderPage({ ...base, unitsSold: 9 });
    const grid = container.querySelector('.xl\\:grid-cols-5.md\\:grid-cols-6');
    expect(grid).toBeTruthy();
    expect(grid!.children).toHaveLength(5);
    expect(grid!.lastElementChild!.className).toContain('col-span-2');
    expect(screen.queryByTestId('product-units-sold')).toBeNull();
  });
});
