import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import type { Shipment } from './shipment-model';

const search = vi.hoisted(() => ({ value: '' }));
// The panel's buttons follow the reader's role (R1b); these tests are a partner's.
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: { id: 'u-partner', email: 'p@x.z', role: 'CORE_PARTNER' }, isLoading: false }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search.value),
  useParams: () => ({ locale: 'en' }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const data = vi.hoisted(() => ({
  inventory: [] as unknown[],
  cycles: [] as unknown[],
  shipments: {} as Record<string, unknown>,
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      if (url === '/inventory') return Promise.resolve({ data: { data: data.inventory } });
      // The list helper sends its page size as params, not in the URL (L1).
      if (url === '/cycles' || url.startsWith('/cycles?')) return Promise.resolve({ data: { data: data.cycles } });
      const m = url.match(/^\/cycles\/([^/]+)\/shipment$/);
      if (m) return Promise.resolve({ data: { data: data.shipments[m[1]] } });
      if (url.startsWith('/costing/')) return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: { data: [] } });
    },
    post: vi.fn(() => new Promise(() => {})),
  },
}));

import InventoryPage from '@/app/[locale]/inventory/page';

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
  search.value = '';
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <InventoryPage />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const stockRow = (name: string, totalStock: number, product: { minStock: number | null; status: string }) => ({
  productId: `p-${name}`,
  productName: name,
  totalStock,
  reservedStock: 0,
  availableStock: totalStock,
  batches: [{ id: `b-${name}`, remainingQty: totalStock, product }],
});

describe('Inventory low stock — the one rule (§3, 2026-10-10)', () => {
  it('highlights an active product under its minimum, and never one with no minimum, however little is left', async () => {
    data.inventory = [
      // The old rule (any batch under 10) highlighted this, and the dashboard did not count it.
      stockRow('No minimum', 3, { minStock: null, status: 'ACTIVE' }),
      // And missed this one, which the dashboard counted.
      stockRow('Under minimum', 40, { minStock: 50, status: 'ACTIVE' }),
      stockRow('Inactive', 1, { minStock: 50, status: 'INACTIVE' }),
      stockRow('At minimum', 50, { minStock: 50, status: 'ACTIVE' }),
    ];
    renderPage();
    const rows = await screen.findAllByTestId('inventory-row');
    const low = Object.fromEntries(rows.map((r) => [r.dataset.product, r.dataset.low]));
    expect(low).toEqual({
      'No minimum': 'false',
      'Under minimum': 'true',
      Inactive: 'false',
      'At minimum': 'false',
    });
  });

  it('?stock=low (the dashboard tile) shows exactly the highlighted ones', async () => {
    search.value = 'stock=low';
    data.inventory = [
      stockRow('No minimum', 3, { minStock: null, status: 'ACTIVE' }),
      stockRow('Under minimum', 40, { minStock: 50, status: 'ACTIVE' }),
    ];
    renderPage();
    const rows = await screen.findAllByTestId('inventory-row');
    expect(rows.map((r) => r.dataset.product)).toEqual(['Under minimum']);
    expect(rows[0].dataset.low).toBe('true');
  });
});

describe('Inventory "Receive stock"', () => {
  const shipment = (received: number): Shipment => ({
    cycleId: 'c-1',
    code: 'CYC-2026-0042',
    status: 'SELLING',
    accounted: false,
    totals: { ordered: 40, received, lost: 0, onTheWay: 25, waiting: 15 - received },
    lines: [{ purchaseOrderItemId: 'poi-1', productName: 'Brake pad', ordered: 40, received, lost: 0, onTheWay: 25, waiting: 15 - received, accounted: false }],
    legs: [
      {
        legId: 'leg-1',
        sequence: 1,
        isLast: true,
        status: 'PARTLY_ARRIVED',
        arrivedOn: null,
        entered: 40,
        delivered: 15,
        lost: 0,
        onTheWay: 25,
        received,
        waiting: 15 - received,
        lines: [{ purchaseOrderItemId: 'poi-1', entered: 40, delivered: 15, lost: 0, onTheWay: 25, received, waiting: 15 - received }],
        deliveries: [{ id: 'd-1', arrivedOn: '2026-10-08', lines: [{ id: 'dl-1', purchaseOrderItemId: 'poi-1', qty: 15, received }] }],
      },
    ],
  });

  it('lists the deliveries waiting, with cycle and what waits, each opening the receive dialog', async () => {
    data.inventory = [];
    data.cycles = [
      { id: 'c-1', status: 'SELLING' },
      { id: 'c-closed', status: 'CLOSED' },
    ];
    data.shipments = { 'c-1': shipment(14) };
    renderPage();
    fireEvent.click(screen.getByTestId('receive-stock-toggle'));
    const row = await screen.findByTestId('waiting-delivery');
    expect(row.textContent).toMatch(/CYC-2026-0042/);
    expect(row.textContent).toMatch(/Brake pad: 1 waiting/);
    fireEvent.click(screen.getByTestId('receive-delivery'));
    const qty = document.querySelector<HTMLInputElement>('[data-testid="receive-qty"][data-line="dl-1"]')!;
    expect(qty.value).toBe('1');
  });

  it('nothing waiting says so, rather than showing an empty table', async () => {
    data.inventory = [];
    data.cycles = [{ id: 'c-1', status: 'SELLING' }];
    data.shipments = { 'c-1': shipment(15) };
    renderPage();
    fireEvent.click(screen.getByTestId('receive-stock-toggle'));
    expect(await screen.findByText(en.shipment.nothingWaiting)).toBeTruthy();
    expect(screen.queryByTestId('waiting-delivery')).toBeNull();
  });
});
