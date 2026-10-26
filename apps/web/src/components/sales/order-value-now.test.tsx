import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';

/**
 * An order's Total says what it is worth now (BUSINESS_LOGIC §4, owner
 * 2026-10-22, "Option A"): sold less returns less price cuts, with "sold at …"
 * under it only when the two differ; and each line in the popup's Items, its
 * price now with "was …", its worth now with "sold at …", and "1 returned ·
 * 3 held". Reached as a partner reaches it — the Sales list, then a click.
 *
 * Every figure is the API's (`common/order-value-now.ts`); the screen sums
 * nothing. Koshary's ORD-2026-00002 is the shape: sold 30,300, back 3,050,
 * 100 off the 23 held, worth 24,950, owes 19,950.
 */

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'p@x.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ locale: 'en' }),
  usePathname: () => '/en/sales',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const data = vi.hoisted(() => ({
  orders: [] as unknown[],
  detail: {} as Record<string, unknown>,
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      // A list asks for a page and is told the total (server-side lists, 2026-10-25).
      const page = (rows: unknown[]) =>
        Promise.resolve({
          data: { data: rows, meta: { nextCursor: null, page: 1, pageSize: 10, total: rows.length, totalPages: 1 } },
        });
      if (url === '/sales/orders') return page(data.orders);
      const m = url.match(/^\/sales\/orders\/([^/]+)$/);
      if (m) return Promise.resolve({ data: { data: data.detail[m[1]] } });
      return page([]);
    },
    post: () => new Promise(() => {}),
  },
}));

import SalesPage from '@/app/[locale]/sales/page';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

const item = (id: string, name: string, over: Record<string, unknown>) => ({
  id,
  productId: `p-${id}`,
  product: { name, sku: name },
  discount: '0',
  allocations: [],
  returnedQty: '0',
  priceCut: false,
  ...over,
});

const koshary = {
  id: 'o-1',
  orderNo: 'ORD-2026-00002',
  customerId: 'c-1',
  customer: { displayName: 'Koshary' },
  channel: 'B2B',
  status: 'PARTIALLY_PAID',
  total: '30300.00',
  valueNowEgp: '24950.00',
  outstanding: '19950.00',
  currency: 'EGP',
  version: 1,
  createdAt: '2026-10-01T09:00:00.000Z',
  orderedAt: '2026-10-01T09:00:00.000Z',
  items: [
    // Returned and lowered.
    item('q58', 'Q58', {
      quantity: '4', unitPrice: '1250', lineTotal: '5000',
      returnedQty: '1', heldQty: '3', soldUnitPrice: '1250.00', unitPriceNow: '1150.00',
      priceCut: true, lineValueNow: '3450.00',
    }),
    // Returned only.
    item('y20', 'Y20', {
      quantity: '12', unitPrice: '900', lineTotal: '10800',
      returnedQty: '2', heldQty: '10', soldUnitPrice: '900.00', unitPriceNow: '900.00',
      lineValueNow: '9000.00',
    }),
    // Neither.
    item('z10', 'Z10', {
      quantity: '10', unitPrice: '1450', lineTotal: '14500',
      heldQty: '10', soldUnitPrice: '1450.00', unitPriceNow: '1450.00',
      lineValueNow: '14500.00',
    }),
  ],
  paymentAllocations: [],
  contractPlan: null,
  samples: null,
};
const plain = {
  ...koshary,
  id: 'o-2',
  orderNo: 'ORD-2026-00003',
  status: 'CONFIRMED',
  total: '14500.00',
  valueNowEgp: '14500.00',
  outstanding: '14500.00',
  items: [koshary.items[2]],
};

beforeEach(() => {
  data.orders = [koshary, plain];
  data.detail = { 'o-1': koshary, 'o-2': plain };
});
afterEach(cleanup);

function renderPage(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{<SalesPage />}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

async function rowOf(orderNo: string) {
  const table = await screen.findByTestId('sales-table');
  const cell = (await within(table).findAllByText(orderNo))[0];
  return cell.closest('[data-testid="sale-row"]') as HTMLElement;
}

async function openOrder(orderNo: string) {
  fireEvent.click(within(await rowOf(orderNo)).getByText(orderNo));
  return screen.findByRole('dialog');
}

/** The popup's Items row for a product. */
function lineOf(dialog: HTMLElement, name: string) {
  return within(dialog).getAllByText(name)[0].closest('tr') as HTMLElement;
}

describe('an order’s Total is what it is worth now', () => {
  it('the Sales row: 24,950.00 with “sold at 30,300.00” under it', async () => {
    renderPage();
    const row = await rowOf('ORD-2026-00002');
    expect(text(row)).toContain('24,950.00');
    expect(text(within(row).getByTestId('sold-at'))).toBe('sold at 30,300.00 EGP');
  });

  it('an order with nothing returned or lowered shows one figure, as before', async () => {
    renderPage();
    const row = await rowOf('ORD-2026-00003');
    expect(text(row)).toContain('14,500.00');
    expect(within(row).queryByTestId('sold-at')).toBeNull();
  });

  it('the popup’s Total says the same: worth now, sold at beneath', async () => {
    renderPage();
    const dialog = await openOrder('ORD-2026-00002');
    const sold = within(dialog).getAllByTestId('sold-at');
    expect(sold).toHaveLength(1);
    expect(text(sold[0].parentElement)).toBe('24,950.00 EGPsold at 30,300.00 EGP');
  });
});

describe('the popup’s Items: each line as it stands now', () => {
  it('a lowered line: 1,150.00 “was 1,250.00”, worth 3,450.00 “sold at 5,000.00”, quantity 4 with “1 returned · 3 held”', async () => {
    renderPage();
    const dialog = await openOrder('ORD-2026-00002');
    const q58 = lineOf(dialog, 'Q58');
    expect(text(within(q58).getByTestId('unit-price-now'))).toBe('1,150.00');
    expect(text(within(q58).getByTestId('unit-price-was'))).toBe('was 1,250.00');
    expect(text(within(q58).getByTestId('line-sold-at'))).toBe('sold at 5,000.00 EGP');
    expect(text(within(q58).getByTestId('line-sold-at').parentElement)).toContain('3,450.00');
    expect(text(within(q58).getByTestId('line-held'))).toBe('1 returned · 3 held');
    // The quantity column keeps what was sold.
    const cells = within(q58).getAllByRole('cell');
    expect(cells.map(text)).toContain('4');
    // On a phone the figures under the name carry the price now too.
    expect(text(within(q58).getByTestId('item-phone-figures'))).toContain('4 × 1,250.00 → 1,150.00');
  });

  it('a line with a return but no cut: its price as sold, no “was”; worth now with “sold at”', async () => {
    renderPage();
    const dialog = await openOrder('ORD-2026-00002');
    const y20 = lineOf(dialog, 'Y20');
    expect(within(y20).queryByTestId('unit-price-was')).toBeNull();
    expect(text(within(y20).getByTestId('line-sold-at'))).toBe('sold at 10,800.00 EGP');
    expect(text(within(y20).getByTestId('line-sold-at').parentElement)).toContain('9,000.00');
    expect(text(within(y20).getByTestId('line-held'))).toBe('2 returned · 10 held');
  });

  it('a line with neither: one price, one total, no note', async () => {
    renderPage();
    const dialog = await openOrder('ORD-2026-00002');
    const z10 = lineOf(dialog, 'Z10');
    expect(within(z10).queryByTestId('unit-price-was')).toBeNull();
    expect(within(z10).queryByTestId('line-sold-at')).toBeNull();
    expect(within(z10).queryByTestId('line-held')).toBeNull();
    expect(text(z10)).toContain('14,500.00');
  });

  it('the second visit: the plain order opened after Koshary shows none of Koshary’s notes', async () => {
    renderPage();
    await openOrder('ORD-2026-00002');
    fireEvent.click(screen.getByRole('button', { name: en.common.close }));
    const dialog = await openOrder('ORD-2026-00003');
    expect(within(dialog).queryByTestId('sold-at')).toBeNull();
    expect(within(dialog).queryByTestId('line-sold-at')).toBeNull();
    expect(within(dialog).queryByTestId('line-held')).toBeNull();
  });
});

describe('in Arabic', () => {
  it('the words are Arabic and every amount is its own left-to-right run', async () => {
    renderPage('ar');
    const row = await rowOf('ORD-2026-00002');
    const sold = within(row).getByTestId('sold-at');
    expect(text(sold)).toBe('بيع بـ 30,300.00 EGP');
    const amount = sold.querySelector('[data-slot="money"]')!;
    expect(amount.getAttribute('dir')).toBe('ltr');
    expect(text(amount)).toBe('30,300.00 EGP');

    const dialog = await openOrder('ORD-2026-00002');
    const q58 = lineOf(dialog, 'Q58');
    const was = within(q58).getByTestId('unit-price-was');
    expect(text(was)).toBe('كان 1,250.00');
    expect(was.querySelector('bdi')!.getAttribute('dir')).toBe('ltr');
    expect(text(within(q58).getByTestId('line-held'))).toBe('1 مرتجع · 3 لدى المحل');
  });
});
