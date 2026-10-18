import type { ComponentType, ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import ProductsPage from '@/components/views/products-view';
import ProductDetailPage from '@/app/[locale]/products/[id]/page';
import CategoriesPage from '@/components/views/categories-view';
import SuppliersPage from '@/components/views/suppliers-view';
import ProvidersPage from '@/components/views/providers-view';
import PurchasesPage from '@/components/views/purchases-view';
import ShipmentsPage from '@/components/views/shipments-view';

/**
 * R1c — the catalogue pages an investor can open (products, categories,
 * suppliers, providers, purchases, shipments) offer no write the server would
 * refuse them. Both directions: a core partner on the same data is offered
 * every one, so a guard that hid the buttons from everybody fails here too
 * (rule 12). e2e: apps/web/tests/90-catalogue-readonly.spec.ts.
 */

const state = vi.hoisted(() => ({ role: 'TEMP_INVESTOR' as string, empty: false }));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-1', email: 'x@y.z', role: state.role }, isLoading: false }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'prod-1', locale: 'en' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/en/products',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const product = {
  id: 'prod-1', sku: 'BRK-1', name: 'Brake pad', status: 'ACTIVE', minStock: 2,
  category: { id: 'cat-1', name: 'Brakes' }, categoryId: 'cat-1',
  prices: [
    { id: 'pr-1', channel: 'B2B', amount: 100, currency: 'EGP', effectiveFrom: '2026-09-01', effectiveTo: null },
    { id: 'pr-2', channel: 'B2C', amount: 150, currency: 'EGP', effectiveFrom: '2026-09-01', effectiveTo: null },
  ],
  listPrices: {
    B2B: { amount: '100.00', currency: 'EGP', source: 'SET' },
    B2C: { amount: '150.00', currency: 'EGP', source: 'SET' },
  },
};
const LISTS: Record<string, unknown[]> = {
  '/products': [product],
  '/categories': [{ id: 'cat-1', name: 'Brakes', parentId: null, _count: { products: 1, children: 0 } }],
  '/suppliers': [{ id: 'sup-1', name: 'Dubai Parts', country: 'AE', contactJson: {} }],
  '/providers': [{ id: 'prov-1', name: 'Gulf Freight' }],
  '/purchases': [{
    id: 'po-1', reference: 'PO-1', cycleId: 'c-1', cycle: { code: 'CYC-1' }, supplierId: 'sup-1',
    supplier: { name: 'Dubai Parts' }, currency: 'AED', fxRateToEgp: 13, orderedOn: '2026-09-01', status: 'CONFIRMED',
  }],
  '/shipping/legs': [{
    id: 'leg-1', cycleId: 'c-1', cycle: { code: 'CYC-1' }, sequence: 1, origin: 'Dubai', destination: 'Cairo',
    provider: 'Gulf Freight', providerId: 'prov-1', status: 'IN_TRANSIT', departedOn: '2026-09-02',
  }],
  '/cycles': [{ id: 'c-1', code: 'CYC-1', status: 'SELLING' }],
  '/files/products/prod-1': [{ id: 'f-1', objectKey: 'k/1.webp', derivatives: [] }],
};

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/products/prod-1') return Promise.resolve({ data: { data: product } });
      if (url === '/purchases/po-1') return Promise.resolve({ data: { data: { ...(LISTS['/purchases'][0] as object), items: [], refunds: [] } } });
      if (url.startsWith('/files/download')) return Promise.resolve({ data: new Blob() });
      if (url in LISTS) return Promise.resolve({ data: { data: state.empty ? [] : LISTS[url] } });
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
  URL.createObjectURL ??= () => 'blob:x';
  URL.revokeObjectURL ??= () => {};
});
beforeEach(() => {
  state.empty = false;
});
afterEach(() => cleanup());

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/** Each list page, a name on it that proves the rows loaded, and the writes it holds. */
const PAGES: { name: string; Page: ComponentType; row: string; writes: string[]; create: string; empty: string }[] = [
  { name: 'products', Page: ProductsPage, row: 'BRK-1', writes: ['create-action', 'edit-action'], create: en.products.create, empty: en.products.emptyTitle },
  { name: 'categories', Page: CategoriesPage, row: 'Brakes', writes: ['create-action', 'edit-action', 'delete-action'], create: en.categories.create, empty: en.categories.emptyTitle },
  { name: 'suppliers', Page: SuppliersPage, row: 'Dubai Parts', writes: ['create-action', 'edit-action', 'delete-action'], create: en.suppliers.create, empty: en.suppliers.emptyTitle },
  { name: 'providers', Page: ProvidersPage, row: 'Gulf Freight', writes: ['create-action', 'edit-action', 'delete-action'], create: en.providers.create, empty: en.providers.emptyTitle },
  { name: 'purchases', Page: PurchasesPage, row: 'PO-1', writes: ['create-action'], create: en.purchases.create, empty: en.purchases.emptyTitle },
  { name: 'shipments', Page: ShipmentsPage, row: 'Dubai', writes: ['create-action', 'edit-action'], create: en.shipments.create, empty: en.shipments.emptyTitle },
];

describe.each(PAGES)('$name page', ({ Page, row, writes, create, empty }) => {
  it('an investor reads the rows and is offered no write', async () => {
    state.role = 'TEMP_INVESTOR';
    wrap(<Page />);
    expect((await screen.findAllByText(row)).length).toBeGreaterThan(0);
    for (const id of writes) expect(screen.queryAllByTestId(id), id).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: create })).toHaveLength(0);
  });

  it('a core partner, on the same rows, is offered every one', async () => {
    state.role = 'CORE_PARTNER';
    wrap(<Page />);
    expect((await screen.findAllByText(row)).length).toBeGreaterThan(0);
    for (const id of writes) expect(screen.queryAllByTestId(id).length, id).toBeGreaterThan(0);
  });

  it('an empty list tells an investor what goes there, without the button to add one', async () => {
    state.empty = true;
    state.role = 'TEMP_INVESTOR';
    wrap(<Page />);
    await screen.findAllByText(empty);
    expect(screen.queryAllByRole('button', { name: create })).toHaveLength(0);
    cleanup();

    state.role = 'CORE_PARTNER';
    wrap(<Page />);
    expect((await screen.findAllByRole('button', { name: create })).length).toBeGreaterThan(0);
  });
});

describe('a purchase order, opened', () => {
  it('offers a partner "Record refund", and an investor not', async () => {
    state.role = 'CORE_PARTNER';
    wrap(<PurchasesPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: new RegExp(en.common.view) }))[0]);
    expect(await screen.findByTestId('record-refund-action')).toBeTruthy();
    cleanup();

    state.role = 'TEMP_INVESTOR';
    wrap(<PurchasesPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: new RegExp(en.common.view) }))[0]);
    await screen.findByText(en.purchases.refunds);
    expect(screen.queryByTestId('record-refund-action')).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(en.purchases.recordRefund) })).toBeNull();
  });
});

describe('a product, opened', () => {
  const WRITES = ['set-price-action', 'add-photo-action', 'delete-photo-action'];

  it('an investor reads both prices and the photos, and can set, add or remove none', async () => {
    state.role = 'TEMP_INVESTOR';
    wrap(<ProductDetailPage />);
    expect(await screen.findAllByTestId('price-readonly')).toHaveLength(2);
    expect(screen.getAllByText(/150\.00/).length).toBeGreaterThan(0);
    for (const id of WRITES) expect(screen.queryAllByTestId(id), id).toHaveLength(0);
  });

  it('a core partner is offered every one, and no read-only price', async () => {
    state.role = 'CORE_PARTNER';
    wrap(<ProductDetailPage />);
    expect(await screen.findAllByTestId('set-price-action')).toHaveLength(2);
    expect(await screen.findAllByTestId('delete-photo-action')).toHaveLength(1);
    expect(screen.getByTestId('add-photo-action')).toBeTruthy();
    expect(screen.queryAllByTestId('price-readonly')).toHaveLength(0);
  });
});
