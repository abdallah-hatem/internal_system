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
 * order shows where they are and offers exactly the three decisions, "They're
 * buying" opens the New Order popup pre-filled, Inventory shows the units out
 * as Samples with the total = shelf + samples, and a product's page lists its
 * samples out per shop (owner 2026-10-18, round 2).
 */

const role = vi.hoisted(() => ({ value: 'CORE_PARTNER' }));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'p@x.z', role: role.value }, isLoading: false }),
}));
const search = vi.hoisted(() => ({ value: '' }));
const params = vi.hoisted(() => ({ value: { locale: 'en' } as Record<string, string> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search.value),
  useParams: () => params.value,
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
  customers: [] as unknown[],
  products: [] as unknown[],
  product: null as unknown,
}));
const post = vi.hoisted(() => vi.fn((...args: unknown[]) => new Promise(() => void args)));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      // A list asks for a page and is told the total (server-side lists, 2026-10-25).
      const page = (rows: unknown[]) =>
        Promise.resolve({
          data: { data: rows, meta: { nextCursor: null, page: 1, pageSize: 10, total: rows.length, totalPages: 1 } },
        });
      if (url === '/sales/orders') return page(data.orders);
      if (url === '/customers') return page(data.customers);
      if (url === '/products') return page(data.products);
      if (url === '/products/p-1') return Promise.resolve({ data: { data: data.product } });
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
import ProductDetailPage from '@/app/[locale]/products/[id]/page';

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
  params.value = { locale: 'en' };
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

  it('the list shows "Samples · 5 units", owes nothing and has no total', async () => {
    renderPage(<SalesPage />);
    const table = await screen.findByTestId('sales-table');
    await within(table).findAllByText('ORD-2026-00042');
    const badge = within(table).getByTestId('samples-badge');
    expect(badge.textContent).toBe('Samples · 5 units');
    expect(table.textContent).not.toMatch(/at shop/i);
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

  it('They’re buying opens the New Order popup on the samples: the shop, today, every line with its price, and the line saying what removing does', async () => {
    data.customers = [{ id: 'c-1', displayName: 'Nile Motors', type: 'B2B' }];
    data.products = [
      {
        id: 'p-1',
        name: 'Piston kit',
        sku: 'PK-1',
        status: 'ACTIVE',
        prices: [{ channel: 'B2B', amount: 1800 }],
        listPrices: { B2B: { amount: '1800.00', currency: 'EGP', source: 'SET' } },
      },
    ];
    renderPage(<SalesPage />);
    const table = await screen.findByTestId('sales-table');
    fireEvent.click((await within(table).findAllByText('ORD-2026-00042'))[0]);
    fireEvent.click(await screen.findByTestId('samples-buying'));
    const form = await screen.findByTestId('sale-order-form');
    expect(within(form).getByText('Complete sale from samples ORD-2026-00042')).toBeTruthy();
    expect(within(form).getByTestId('samples-convert-note').textContent).toBe(
      '5 units were out as samples; for anything you remove or lower, choose below whether it stays a sample or comes back to the shelf.',
    );
    await waitFor(() => expect(within(form).getAllByRole('combobox')[0].textContent).toContain('Nile Motors'));
    const lines = within(form).getAllByTestId('sale-line');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain('Piston kit');
    expect(lines[0].querySelector<HTMLInputElement>('[data-field="quantity"]')!.value).toBe('5');
    expect(lines[0].querySelector<HTMLInputElement>('[data-field="unitPrice"]')!.value).toBe('1,800');
    expect(within(form).getByTestId('sale-submit').textContent).toContain(en.sales.samples.complete);
    // The old decide dialog is gone.
    expect(screen.queryByTestId('samples-decide')).toBeNull();
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
    expect(badge.textContent).toBe('عينات · 5 وحدات');
    fireEvent.click(within(table).getAllByText('ORD-2026-00042')[0]);
    expect((await screen.findByTestId('samples-buying')).textContent).toContain(ar.sales.samples.buying);
    expect(screen.getByTestId('samples-returned').textContent).toContain(ar.sales.samples.returned);
    expect(screen.getByTestId('samples-write-off').textContent).toContain(ar.sales.samples.writeOff);
  });
});

describe('Inventory — Samples', () => {
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

  it('shows the units out as samples, headed "Samples", beside the shelf; total = shelf + samples, and low stock still reads the shelf', async () => {
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
    expect(en.inventory.atShops).toBe('Samples');
    expect(screen.getAllByText('Samples').length).toBeGreaterThan(0);
    expect(screen.queryByText(/At shops/i)).toBeNull();
    expect(screen.getAllByText(en.inventory.onShelf).length).toBeGreaterThan(0);
  });

  it('Arabic headers', async () => {
    data.inventory = [row('Piston kit', 3, 2)];
    renderPage(<InventoryPage />, 'ar');
    await screen.findAllByTestId('inventory-row');
    expect(ar.inventory.atShops).toBe('عينات');
    expect(screen.getAllByText('عينات').length).toBeGreaterThan(0);
    expect(screen.queryByText(/عند المحلات/)).toBeNull();
    expect(screen.getAllByText(ar.inventory.onShelf).length).toBeGreaterThan(0);
  });
});

describe('Product page — Samples card, no B2C price card', () => {
  const PRODUCT = {
    id: 'p-1',
    sku: 'PK-1',
    name: 'Piston kit',
    status: 'ACTIVE',
    prices: [
      { id: 'pr-b2b', channel: 'B2B', currency: 'EGP', amount: 1800, effectiveTo: null },
      { id: 'pr-b2c', channel: 'B2C', currency: 'EGP', amount: 2100, effectiveTo: null },
    ],
  };
  const open = (id: string, orderNo: string, shop: string, qty: string, days: number, productId = 'p-1') => ({
    ...SAMPLES_ORDER,
    id,
    orderNo,
    customer: { displayName: shop },
    items: [{ ...SAMPLES_ORDER.items[0], id: `i-${id}`, productId, quantity: qty }],
    samples: { ...SAMPLES_ORDER.samples, unitsOut: qty, daysAtShop: days },
  });
  beforeEach(() => {
    params.value = { locale: 'en', id: 'p-1' };
    data.product = PRODUCT;
    data.inventory = [
      { productId: 'p-1', productName: 'Piston kit', totalStock: 3, reservedStock: 0, availableStock: 3, batches: [] },
    ];
  });

  it('lists the units out per shop, longest out first, each linking to its order, with the total', async () => {
    data.orders = [
      open('o-a', 'ORD-2026-00050', 'Delta Bikes', '2', 3),
      open('o-b', 'ORD-2026-00042', 'Nile Motors', '5', 10),
      open('o-c', 'ORD-2026-00051', 'Other part only', '4', 1, 'p-other'),
    ];
    renderPage(<ProductDetailPage />);
    const card = await screen.findByTestId('product-samples');
    const rows = await within(card).findAllByTestId('product-samples-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Nile Motors.*ORD-2026-00042.*Left 10 days ago.*5/),
      expect.stringMatching(/Delta Bikes.*ORD-2026-00050.*Left 3 days ago.*2/),
    ]);
    expect(rows.map((r) => r.getAttribute('href'))).toEqual(['/sales?order=o-b', '/sales?order=o-a']);
    expect(within(card).getByTestId('product-samples-total').textContent).toBe('7 units out');
    expect(screen.getByTestId('product-samples-stat').textContent).toBe('7');
  });

  it('none out: the card says so, and the total is 0', async () => {
    data.orders = [open('o-c', 'ORD-2026-00051', 'Other part only', '4', 1, 'p-other')];
    renderPage(<ProductDetailPage />);
    const card = await screen.findByTestId('product-samples');
    expect(await within(card).findByText(en.products.samples.emptyTitle)).toBeTruthy();
    expect(within(card).queryByTestId('product-samples-row')).toBeNull();
    expect(within(card).queryByTestId('product-samples-total')).toBeNull();
    expect(screen.getByTestId('product-samples-stat').textContent).toBe('0');
  });

  it('the B2C price card is gone from the stat cards; the B2C price is still in the prices card', async () => {
    data.orders = [];
    renderPage(<ProductDetailPage />);
    await screen.findByTestId('product-samples');
    const stat = screen.getByTestId('product-samples-stat');
    const cards = stat.closest('.grid') as HTMLElement;
    expect(cards.textContent).not.toContain(en.products.b2cPrice);
    expect(cards.textContent).not.toMatch(/2,100/);
    expect(cards.textContent).toContain(en.products.samples.title);
    // Still priced for B2C: the prices card, the form that sets it, is untouched.
    expect(screen.getAllByText(en.products.b2cPrice).length).toBe(1);
  });

  it('Arabic: the card is headed عينات', async () => {
    params.value = { locale: 'ar', id: 'p-1' };
    data.orders = [open('o-b', 'ORD-2026-00042', 'Nile Motors', '5', 10)];
    renderPage(<ProductDetailPage />, 'ar');
    const card = await screen.findByTestId('product-samples');
    expect(card.textContent).toContain('عينات');
    expect((await within(card).findByTestId('product-samples-total')).textContent).toBe('5 وحدات بالخارج');
  });
});
