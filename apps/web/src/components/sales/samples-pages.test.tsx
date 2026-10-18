import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';

/**
 * Samples at shops (BUSINESS_LOGIC §4, owner 2026-10-18) on the screens the
 * partners use: the Sales list shows a samples order with its amber badge, the
 * order shows where they are and offers exactly the three decisions, and
 * Inventory shows the units At shops with the total = shelf + at shops.
 */

const role = vi.hoisted(() => ({ value: 'CORE_PARTNER' }));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'p@x.z', role: role.value }, isLoading: false }),
}));
const search = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search.value),
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
  inventory: [] as unknown[],
}));
const post = vi.hoisted(() => vi.fn((...args: unknown[]) => new Promise(() => void args)));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      const page = (rows: unknown[]) => Promise.resolve({ data: { data: rows, meta: { nextCursor: null } } });
      if (url === '/sales/orders') return page(data.orders);
      const m = url.match(/^\/sales\/orders\/([^/]+)$/);
      if (m) return Promise.resolve({ data: { data: data.detail[m[1]] } });
      if (url === '/inventory') return Promise.resolve({ data: { data: data.inventory } });
      return page([]);
    },
    post: (...args: unknown[]) => post(...args),
  },
}));

import SalesPage from '@/app/[locale]/sales/page';
import InventoryPage from '@/app/[locale]/inventory/page';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  role.value = 'CORE_PARTNER';
  search.value = '';
  post.mockClear();
});
afterEach(cleanup);

function renderPage(page: ReactNode, locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{page}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const SAMPLES_ORDER = {
  id: 'o-s',
  orderNo: 'ORD-2026-00042',
  customerId: 'c-1',
  customer: { displayName: 'Nile Motors' },
  channel: 'B2B',
  status: 'SAMPLES',
  total: '0.00',
  outstanding: '0.00',
  currency: 'EGP',
  version: 1,
  createdAt: '2026-10-08T09:00:00.000Z',
  orderedAt: '2026-10-08T09:00:00.000Z',
  items: [
    {
      id: 'i-1',
      productId: 'p-1',
      product: { name: 'Piston kit', sku: 'PK-1' },
      quantity: '5',
      unitPrice: '0',
      discount: '0',
      lineTotal: '0',
      allocations: [{ id: 'a-1', inventoryBatchId: 'b-1', qty: '5', unitCostEgp: '100', cogsEgp: '500.00' }],
    },
  ],
  samples: {
    open: true,
    unitsOut: '5',
    leftOn: '2026-10-08',
    daysAtShop: 10,
    reminderOn: '2026-10-22',
    remindedAt: null,
    decidedAt: null,
  },
};
const SALE = {
  ...SAMPLES_ORDER,
  id: 'o-sale',
  orderNo: 'ORD-2026-00041',
  status: 'CONFIRMED',
  total: '900.00',
  outstanding: '900.00',
  samples: null,
};

describe('Sales — a samples order', () => {
  beforeEach(() => {
    data.orders = [SAMPLES_ORDER, SALE];
    data.detail = { 'o-s': SAMPLES_ORDER, 'o-sale': SALE };
  });

  it('the list shows "Samples at shop · 5 units", owes nothing and has no total', async () => {
    renderPage(<SalesPage />);
    const table = await screen.findByTestId('sales-table');
    await within(table).findAllByText('ORD-2026-00042');
    const badge = within(table).getByTestId('samples-badge');
    expect(badge.textContent).toBe('Samples at shop · 5 units');
    const row = badge.closest('[data-testid="sale-row"]') as HTMLElement;
    expect(within(row).getByTestId('outstanding').textContent).toContain(en.sales.samples.noChargeCell);
    expect(row.textContent).not.toMatch(/EGP/);
  });

  it('the order says where they are, since when and when the reminder is due, and offers exactly They’re buying, Returned and Write off', async () => {
    renderPage(<SalesPage />);
    const table = await screen.findByTestId('sales-table');
    fireEvent.click((await within(table).findAllByText('ORD-2026-00042'))[0]);
    const panel = await screen.findByTestId('samples-panel');
    expect(panel.textContent).toContain('Nile Motors');
    expect(panel.textContent).toContain('Left 10 days ago');
    expect(panel.textContent).toMatch(/Reminder/);
    expect(screen.getByTestId('samples-buying')).toBeTruthy();
    expect(screen.getByTestId('samples-returned')).toBeTruthy();
    expect(screen.getByTestId('samples-write-off')).toBeTruthy();
    // No sale's actions: no invoice, no payment, no cancel, no return.
    expect(screen.queryByTestId('order-invoice')).toBeNull();
    expect(screen.queryByTestId('order-record-payment')).toBeNull();
    expect(screen.queryByRole('button', { name: en.sales.cancel })).toBeNull();
    expect(screen.queryByRole('button', { name: en.sales.recordReturn })).toBeNull();
  });

  it('Write off asks first, shows the cost written off, and only then posts', async () => {
    renderPage(<SalesPage />);
    const table = await screen.findByTestId('sales-table');
    fireEvent.click((await within(table).findAllByText('ORD-2026-00042'))[0]);
    fireEvent.click(await screen.findByTestId('samples-write-off'));
    expect(post).not.toHaveBeenCalled();
    expect((await screen.findByTestId('samples-write-off-cost')).textContent).toContain('500');
    fireEvent.click(screen.getByTestId('samples-write-off-confirm'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/sales/orders/o-s/samples/write-off');
  });

  it('Returned asks first, then posts the return', async () => {
    renderPage(<SalesPage />);
    const table = await screen.findByTestId('sales-table');
    fireEvent.click((await within(table).findAllByText('ORD-2026-00042'))[0]);
    fireEvent.click(await screen.findByTestId('samples-returned'));
    fireEvent.click(await screen.findByTestId('samples-return-confirm'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/sales/orders/o-s/samples/return');
  });

  it('They’re buying opens the decision dialog with every product left', async () => {
    renderPage(<SalesPage />);
    const table = await screen.findByTestId('sales-table');
    fireEvent.click((await within(table).findAllByText('ORD-2026-00042'))[0]);
    fireEvent.click(await screen.findByTestId('samples-buying'));
    const dialog = await screen.findByTestId('samples-decide');
    expect(within(dialog).getAllByTestId('samples-decide-line')).toHaveLength(1);
  });

  it('an office account (not a partner) is not offered Write off — the API refuses it', async () => {
    role.value = 'ADMIN_SUPPORT';
    renderPage(<SalesPage />);
    const table = await screen.findByTestId('sales-table');
    fireEvent.click((await within(table).findAllByText('ORD-2026-00042'))[0]);
    await screen.findByTestId('samples-buying');
    expect(screen.queryByTestId('samples-write-off')).toBeNull();
  });

  it('decided samples offer nothing more to do', async () => {
    const back = { ...SAMPLES_ORDER, status: 'SAMPLES_RETURNED', samples: { ...SAMPLES_ORDER.samples, open: false, unitsOut: '0', decidedAt: '2026-10-12T10:00:00.000Z' } };
    data.orders = [back];
    data.detail = { 'o-s': back };
    renderPage(<SalesPage />);
    const table = await screen.findByTestId('sales-table');
    fireEvent.click((await within(table).findAllByText('ORD-2026-00042'))[0]);
    const panel = await screen.findByTestId('samples-panel');
    expect(panel.textContent).toMatch(/came back/);
    expect(screen.queryByTestId('samples-buying')).toBeNull();
    expect(screen.queryByTestId('samples-returned')).toBeNull();
  });

  it('a notification’s ?order= link opens that order', async () => {
    search.value = 'order=o-s';
    renderPage(<SalesPage />);
    expect(await screen.findByTestId('samples-panel')).toBeTruthy();
  });

  it('Arabic: the badge and the three actions are Arabic', async () => {
    renderPage(<SalesPage />, 'ar');
    const table = await screen.findByTestId('sales-table');
    const badge = await within(table).findByTestId('samples-badge');
    expect(badge.textContent).toBe('عينات عند المحل · 5 وحدات');
    fireEvent.click(within(table).getAllByText('ORD-2026-00042')[0]);
    expect((await screen.findByTestId('samples-buying')).textContent).toContain(ar.sales.samples.buying);
    expect(screen.getByTestId('samples-returned').textContent).toContain(ar.sales.samples.returned);
    expect(screen.getByTestId('samples-write-off').textContent).toContain(ar.sales.samples.writeOff);
  });
});

describe('Inventory — At shops', () => {
  const row = (name: string, shelf: number, atShops: number) => ({
    productId: `p-${name}`,
    productName: name,
    totalStock: shelf,
    reservedStock: 0,
    availableStock: shelf,
    atShopsStock: atShops,
    allStock: shelf + atShops,
    batches: [{ id: `b-${name}`, remainingQty: shelf, atShopsQty: atShops, product: { minStock: 4, status: 'ACTIVE' } }],
  });

  it('shows the units at shops beside the shelf, total = shelf + at shops, and low stock still reads the shelf', async () => {
    data.inventory = [row('Piston kit', 3, 2), row('Chain', 10, 0)];
    renderPage(<InventoryPage />);
    const rows = await screen.findAllByTestId('inventory-row');
    const piston = rows.find((r) => r.dataset.product === 'Piston kit')!;
    expect(within(piston).getByTestId('at-shops').textContent).toBe('2');
    expect(within(piston).getByTestId('all-stock').textContent).toBe('5');
    // 3 on the shelf is under the minimum of 4, though 5 are ours in all.
    expect(piston.dataset.low).toBe('true');
    const chain = rows.find((r) => r.dataset.product === 'Chain')!;
    expect(within(chain).getByTestId('at-shops').textContent).toBe('0');
    expect(within(chain).getByTestId('all-stock').textContent).toBe('10');
    expect(screen.getAllByText(en.inventory.atShops).length).toBeGreaterThan(0);
    expect(screen.getAllByText(en.inventory.onShelf).length).toBeGreaterThan(0);
  });

  it('Arabic headers', async () => {
    data.inventory = [row('Piston kit', 3, 2)];
    renderPage(<InventoryPage />, 'ar');
    await screen.findAllByTestId('inventory-row');
    expect(screen.getAllByText(ar.inventory.atShops).length).toBeGreaterThan(0);
    expect(screen.getAllByText(ar.inventory.onShelf).length).toBeGreaterThan(0);
  });
});
