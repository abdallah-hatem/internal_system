import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import ProductDetailPage from '@/app/[locale]/products/[id]/page';

/**
 * The product page after the 2026-10-22 audit (owner: "fix them").
 *
 * - The batches: a table through the shared DataTable from md up, a card per
 *   batch below it — rows used to be 532px of "Label: value" inside a 299px card.
 * - Opening a batch shows its movements under it, naming each record by its
 *   number as a link (ORD-…, RET-…, PO-…), never a database id; the separate
 *   Movement History card that repeated them is gone.
 * - "Received" is the quantity, "Checked in" the date.
 * - Current prices come before photos and batches in the markup (first on a
 *   phone); the price field's placeholder is never the default figure.
 */

const state = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ar', asked: [] as string[] }));

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

const product = {
  id: 'prod-1', sku: 'BRK-1', name: 'Brake pad', nameAr: 'تيل فرامل', status: 'ACTIVE', minStock: 2,
  createdAt: '2026-10-19T14:06:00Z',
  category: { id: 'cat-1', name: 'Brakes' },
  prices: [],
  listPrices: {
    B2B: { amount: '1221.00', currency: 'EGP', source: 'DEFAULT', markupPct: 20 },
    B2C: { amount: '1221.00', currency: 'EGP', source: 'DEFAULT', markupPct: 20 },
  },
};
const batch = (id: string, cycle: string, received: number, remaining: number, cost: number) => ({
  id, cycleId: `c-${cycle}`, cycle: { code: cycle }, receivedQty: received, remainingQty: remaining,
  landedUnitCostEgp: cost, arrivedOn: '2026-10-18', receivedAt: '2026-10-19T14:06:00Z',
});
const stock = {
  productId: 'prod-1', productName: 'Brake pad', totalStock: 12, reservedStock: 0, availableStock: 12, stockValueEgp: 2034.4,
  batches: [
    batch('b-1', 'CYC-2026-0001', 10, 2, 1017.2),
    batch('b-2', 'CYC-2026-0001', 5, 5, 900),
    batch('b-3', 'CYC-2026-0002', 5, 5, 950),
  ],
};
const movements = [
  {
    id: 'm-1', batchId: 'b-1', movementType: 'RECEIVE', qtyDelta: '10', occurredAt: '2026-10-19T14:06:00Z',
    referenceType: 'PURCHASE_ORDER_ITEM', referenceId: 'b8c9999e-0000-4000-8000-000000000001',
    reference: { number: 'PO-2026-0003', purchaseOrderId: 'po-3' },
  },
  {
    id: 'm-2', batchId: 'b-1', movementType: 'SALE', qtyDelta: '-8', occurredAt: '2026-10-20T10:00:00Z',
    referenceType: 'SALE_ORDER', referenceId: '4d2d3158-0000-4000-8000-000000000002',
    reference: { number: 'ORD-2026-0007', saleOrderId: 'so-7' },
  },
  {
    id: 'm-3', batchId: 'b-1', movementType: 'RETURN', qtyDelta: '1', occurredAt: '2026-10-21T10:00:00Z',
    referenceType: 'SALE_RETURN', referenceId: 'eb47dd78-0000-4000-8000-000000000003',
    reference: { number: 'RET-2026-0002', saleOrderId: 'so-7' },
  },
];

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      state.asked.push(url);
      if (url === '/products/prod-1') return Promise.resolve({ data: { data: product } });
      if (url === '/inventory') return Promise.resolve({ data: { data: [stock] } });
      if (url === '/inventory/batches/b-1/movements') return Promise.resolve({ data: { data: movements } });
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
afterEach(() => {
  cleanup();
  state.locale = 'en';
  state.asked = [];
});

function renderPage(locale: 'en' | 'ar' = 'en') {
  state.locale = locale;
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

/** `a` comes before `b` in the document. */
const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the batches: a table on desktop, cards on a phone', () => {
  it('desktop is the shared table, headers per column and no "Label:" in a cell', async () => {
    renderPage();
    const table = await screen.findByTestId('batches-table');
    expect(table.getAttribute('data-slot')).toBe('data-table');
    expect(table.closest('.hidden.md\\:block')).toBeTruthy();
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(
      expect.arrayContaining([
        en.products.cycle, en.products.receivedQty, en.products.remainingQty, en.products.landedCost,
        en.inventory.arrived, en.products.checkedIn,
      ]),
    );
    const rows = within(table).getAllByTestId('batch-row');
    expect(rows).toHaveLength(3);
    // Values only — the header names them.
    expect(rows[0].textContent).not.toContain(':');
    expect(rows[0].textContent).toContain('CYC-2026-0001');
    expect(rows[0].textContent).toContain('1,017.20');
    // No raw batch hash anywhere.
    expect(table.textContent).not.toMatch(/#b-1|#[0-9a-f]{8}/);
  });

  it('a phone gets one card per batch, a labelled line per figure, the toggle in view', async () => {
    renderPage();
    const cards = await screen.findAllByTestId('batch-card');
    expect(cards).toHaveLength(3);
    expect(cards[0].closest('ul')!.className).toContain('md:hidden');
    const lines = Array.from(cards[0].querySelectorAll('dl > div')) as HTMLElement[];
    expect(lines.map((l) => l.querySelector('dt')!.textContent)).toEqual([
      en.products.cycle, en.products.receivedQty, en.products.remainingQty, en.products.landedCost,
      en.inventory.arrived, en.products.checkedIn,
    ]);
    // Each line is one start/end pair that never wraps its value.
    for (const line of lines) {
      expect(line.className).toContain('justify-between');
      expect(line.querySelector('dd')!.className).toContain('whitespace-nowrap');
    }
    expect(within(cards[0]).getByRole('button').getAttribute('aria-expanded')).toBe('false');
  });

  it('quantity received and the day checked in never share a label', () => {
    expect(en.products.checkedIn).toBe('Checked in');
    expect(ar.products.checkedIn).toBeTruthy();
    expect(en.products.receivedQty).not.toBe(en.products.checkedIn);
    expect(ar.products.receivedQty).not.toBe(ar.products.checkedIn);
  });
});

describe('opening a batch shows its movements, by record number', () => {
  it('in the table: the row opens, its movements link to ORD-, RET- and PO-, no ids', async () => {
    renderPage();
    const table = await screen.findByTestId('batches-table');
    fireEvent.click(within(table).getAllByTestId('batch-toggle')[0]);
    const row = await within(table).findByTestId('batch-movements-row');
    await within(row).findAllByTestId('batch-movement');
    const links = within(row).getAllByTestId('movement-reference');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['PO-2026-0003', '/cycles?open=po-3&view=purchases'],
      ['ORD-2026-0007', '/sales?order=so-7'],
      // A return opens the order it was made on.
      ['RET-2026-0002', '/sales?order=so-7'],
    ]);
    expect(row.textContent).not.toMatch(/4d2d3158|eb47dd78|b8c9999e/);
    expect(state.asked).toContain('/inventory/batches/b-1/movements');
  });

  it('opening it again closes it; a second batch replaces the first', async () => {
    renderPage();
    const table = await screen.findByTestId('batches-table');
    const toggles = within(table).getAllByTestId('batch-toggle');
    fireEvent.click(toggles[0]);
    await within(table).findByTestId('batch-movements-row');
    fireEvent.click(toggles[0]);
    expect(within(table).queryByTestId('batch-movements-row')).toBeNull();
    fireEvent.click(toggles[0]);
    fireEvent.click(toggles[1]);
    expect(within(table).getAllByTestId('batch-movements-row')).toHaveLength(1);
    expect(toggles[1].getAttribute('aria-expanded')).toBe('true');
    expect(toggles[0].getAttribute('aria-expanded')).toBe('false');
  });

  it('on a phone card the movements open under that card', async () => {
    renderPage();
    const [card] = await screen.findAllByTestId('batch-card');
    fireEvent.click(within(card).getByRole('button'));
    const list = await within(card).findByTestId('batch-card-movements');
    await within(list).findAllByTestId('batch-movement');
    expect(within(list).getAllByTestId('movement-reference').map((a) => a.textContent)).toContain('ORD-2026-0007');
  });

  it('there is no separate Movement History card', async () => {
    renderPage();
    await screen.findByTestId('batches-table');
    expect(screen.queryByText('Movement History')).toBeNull();
    expect(screen.queryByText('Open a batch to see its movements')).toBeNull();
    expect((en.products as Record<string, unknown>).movementHistory).toBeUndefined();
    expect((ar.products as Record<string, unknown>).movementHistory).toBeUndefined();
  });
});

describe('prices', () => {
  it('come before photos and batches in the page, so first on a phone', async () => {
    renderPage();
    const prices = await screen.findByTestId('current-prices');
    const batches = screen.getByTestId('product-batches');
    const photos = screen.getByText(en.products.photos);
    expect(before(prices, photos)).toBe(true);
    expect(before(prices, batches)).toBe(true);
    // ...and on a wide screen they sit in the third column, beside photos.
    expect(prices.parentElement!.className).toContain('xl:col-start-3');
    // The batches are outside the two-column grid: the whole width.
    expect(batches.closest('.xl\\:grid-cols-3')).toBeNull();
  });

  it('the empty field shows no figure; the default is the hint line under it', async () => {
    renderPage();
    const prices = await screen.findByTestId('current-prices');
    const inputs = prices.querySelectorAll('input:not([type=hidden])');
    expect(inputs).toHaveLength(2);
    for (const input of Array.from(inputs) as HTMLInputElement[]) {
      expect(input.value).toBe('');
      expect(input.placeholder).not.toMatch(/1,?221/);
    }
    const hints = within(prices).getAllByTestId('default-price');
    expect(hints[0].textContent).toMatch(/1,221\.00/);
    expect(hints[0].textContent).toContain('Default (landed + 20%)');
  });

  it('Save is a 44px target on a phone, the field’s height from sm', async () => {
    renderPage();
    const [save] = await screen.findAllByTestId('set-price-action');
    expect(save.className).toContain('h-11');
    expect(save.className).toContain('sm:h-[34px]');
  });
});

describe('the header and the small wraps', () => {
  it('the SKU is under the name; the status action comes after both', async () => {
    renderPage();
    const title = await screen.findByTestId('product-title');
    const sku = screen.getByTestId('product-sku');
    const action = screen.getByRole('button', { name: en.products.deactivate });
    expect(before(title, sku)).toBe(true);
    expect(before(sku, action)).toBe(true);
  });

  it('the stock value is one line', async () => {
    renderPage();
    const value = await screen.findByTestId('product-stock-value');
    expect(value.textContent).toContain('2,034.40');
    expect(value.parentElement!.className).toContain('whitespace-nowrap');
  });

  it('Created takes the whole row on a phone', async () => {
    renderPage();
    const label = await screen.findByText(en.products.createdAt);
    expect(label.parentElement!.className).toContain('col-span-2');
    expect(label.parentElement!.className).toContain('md:col-span-1');
  });
});

describe('in Arabic', () => {
  it('the batch labels and the movement records are Arabic, the numbers isolated', async () => {
    renderPage('ar');
    const table = await screen.findByTestId('batches-table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining([ar.products.receivedQty, ar.products.checkedIn, ar.inventory.arrived]));
    fireEvent.click(within(table).getAllByTestId('batch-toggle')[0]);
    const row = await within(table).findByTestId('batch-movements-row');
    await within(row).findAllByTestId('batch-movement');
    expect(row.textContent).toContain(ar.codes.referenceType.SALE_ORDER);
    const link = within(row).getAllByTestId('movement-reference')[1];
    expect(link.textContent).toBe('ORD-2026-0007');
    expect(link.querySelector('bdi')!.getAttribute('dir')).toBe('ltr');
  });
});
