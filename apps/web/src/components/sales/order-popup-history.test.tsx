import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';

/**
 * The sale order popup reached the way a partner reaches it — the Sales list,
 * a click on the order — with its Adjust price action and its History tab
 * (BUSINESS_LOGIC §4, owner 2026-10-22).
 */

const role = vi.hoisted(() => ({ value: 'CORE_PARTNER' }));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'p@x.z', role: role.value }, isLoading: false }),
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
  history: {} as Record<string, unknown>,
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      const page = (rows: unknown[]) => Promise.resolve({ data: { data: rows, meta: { nextCursor: null } } });
      if (url === '/sales/orders') return page(data.orders);
      const h = url.match(/^\/sales\/orders\/([^/]+)\/history$/);
      if (h) return Promise.resolve({ data: { data: data.history[h[1]] } });
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

const order = (id: string, orderNo: string, status: string, outstanding: string) => ({
  id,
  orderNo,
  customerId: 'c-1',
  customer: { displayName: 'Koshary' },
  channel: 'B2B',
  status,
  total: '3750.00',
  outstanding,
  currency: 'EGP',
  version: 1,
  createdAt: '2026-10-01T09:00:00.000Z',
  orderedAt: '2026-10-01T09:00:00.000Z',
  items: [
    {
      id: `${id}-i`,
      productId: 'p-1',
      product: { name: 'Q58', sku: 'Q58' },
      quantity: '3',
      unitPrice: '1250',
      discount: '0',
      lineTotal: '3750',
      allocations: [],
    },
  ],
  paymentAllocations: [],
  contractPlan: null,
  samples: null,
});
const history = (id: string, orderNo: string, owes: string) => ({
  orderId: id,
  orderNo,
  status: 'CONFIRMED',
  events: [
    { kind: 'CREATED', date: '2026-10-01', at: '2026-10-01T09:00:00.000Z', by: 'Abdallah', reference: orderNo, amount: '3750.00', effect: '0.00', owes: '0.00' },
    { kind: 'CONFIRMED', date: '2026-10-01', at: '2026-10-01T09:00:00.001Z', by: 'Abdallah', reference: orderNo, amount: '3750.00', effect: '3750.00', owes },
  ],
  products: [
    { saleItemId: `${id}-i`, product: 'Q58', productAr: null, startedWith: '3', returned: '0', holds: '3', soldAt: '1250.00', priceNow: '1250.00' },
  ],
  owes,
  replayedOwes: owes,
});

beforeEach(() => {
  role.value = 'CORE_PARTNER';
  const confirmed = order('o-1', 'ORD-2026-00002', 'CONFIRMED', '3750.00');
  const draft = order('o-2', 'ORD-2026-00003', 'DRAFT', '0.00');
  data.orders = [confirmed, draft];
  data.detail = { 'o-1': confirmed, 'o-2': draft };
  data.history = { 'o-1': history('o-1', 'ORD-2026-00002', '3750.00'), 'o-2': history('o-2', 'ORD-2026-00003', '0.00') };
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

async function openOrder(orderNo: string) {
  const table = await screen.findByTestId('sales-table');
  fireEvent.click((await within(table).findAllByText(orderNo))[0]);
}

describe('the sale order popup', () => {
  it('a confirmed sale offers Adjust price, which opens the popup on its lines', async () => {
    renderPage();
    await openOrder('ORD-2026-00002');
    fireEvent.click(await screen.findByTestId('order-adjust-price'));
    const dialog = await screen.findByTestId('adjust-price-dialog');
    expect(dialog.textContent).toContain('ORD-2026-00002');
    expect(await within(dialog).findByRole('combobox')).toBeTruthy();
  });

  it('a draft does not offer it', async () => {
    renderPage();
    await openOrder('ORD-2026-00003');
    await screen.findByRole('button', { name: en.sales.confirm });
    expect(screen.queryByTestId('order-adjust-price')).toBeNull();
  });

  it('the History tab shows the timeline ending on what the order owes; the next order opens on its details', async () => {
    renderPage();
    await openOrder('ORD-2026-00002');
    fireEvent.click(await screen.findByTestId('tab-orderHistory'));
    const timeline = await screen.findByTestId('order-history');
    expect(within(timeline).getByTestId('history-owes').textContent).toContain('3,750.00');
    expect(within(timeline).getAllByText(en.sales.history.kinds.CONFIRMED).length).toBeGreaterThan(0);
    expect(screen.queryByText(en.sales.allocations)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: en.common.close }));
    await openOrder('ORD-2026-00003');
    expect(await screen.findByText(en.sales.allocations)).toBeTruthy();
    expect(screen.getByTestId('tab-orderDetails').getAttribute('aria-selected')).toBe('true');
  });

  it('in Arabic the tabs are السجل and الطلب', async () => {
    renderPage('ar');
    await openOrder('ORD-2026-00002');
    expect((await screen.findByTestId('tab-orderHistory')).textContent).toBe('السجل');
    expect(screen.getByTestId('tab-orderDetails').textContent).toBe('الطلب');
    expect((await screen.findByTestId('order-adjust-price')).textContent).toContain('تعديل السعر');
  });
});
