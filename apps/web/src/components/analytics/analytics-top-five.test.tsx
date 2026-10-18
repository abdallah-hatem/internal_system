import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import AnalyticsPage from '@/app/[locale]/analytics/page';

/**
 * Analytics shows the top five of each list (owner 2026-10-19, BUSINESS_LOGIC
 * "Top products"): the five best products by the switch that is on, and the
 * five most profitable cycles. A product that sold nothing is not a top
 * product, so it never fills a place.
 *
 * The API is stood in for by one that behaves like the real one: ranks by
 * `by`, cuts at `limit` (default 10), and includes products with no sales —
 * which is what put "Brake Pad Set 0 / 0.00 EGP" on the page.
 */

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/en/analytics',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

interface P {
  productId: string;
  name: string;
  sku: string;
  totalQuantitySold: number;
  revenueEgp: number;
  cogsEgp: number;
  profitEgp: number;
  marginPct: number | null;
}
const product = (n: number, units: number, revenue: number): P => ({
  productId: `p${n}`,
  name: `Product ${n}`,
  sku: `SKU-${n}`,
  totalQuantitySold: units,
  revenueEgp: revenue,
  cogsEgp: 0,
  profitEgp: revenue,
  marginPct: revenue > 0 ? 100 : null,
});

const cycle = (code: string, profit: number) => ({
  cycleId: code,
  cycleCode: code,
  status: 'SELLING',
  originType: 'CHINA',
  investment: 0,
  totalCost: 0,
  totalRevenue: 0,
  profit,
  roiPct: null,
  unitsSold: 0,
  unitsRemaining: 0,
  unsoldValueEgp: 0,
});

let products: P[] = [];
let cycles: ReturnType<typeof cycle>[] = [];
let hold: Promise<void> | null = null;

/** The API's ranking (analytics.service getTopProducts): the measure, then the other, then the name. */
function rank(list: P[], by: string): P[] {
  return [...list].sort((a, b) =>
    by === 'units'
      ? b.totalQuantitySold - a.totalQuantitySold || b.revenueEgp - a.revenueEgp || a.name.localeCompare(b.name)
      : b.revenueEgp - a.revenueEgp || b.totalQuantitySold - a.totalQuantitySold || a.name.localeCompare(b.name),
  );
}

vi.mock('@/lib/api', () => ({
  api: {
    get: async (url: string) => {
      if (hold) await hold;
      const [path, qs = ''] = url.split('?');
      const q = new URLSearchParams(qs);
      if (path === '/analytics/top-products') {
        const limit = Number(q.get('limit') ?? 10);
        return { data: { data: rank(products, q.get('by') ?? 'revenue').slice(0, limit) } };
      }
      // Cycles come back in code order, as the API sends them.
      if (path === '/analytics/cycle-profitability') return { data: { data: cycles } };
      // Profit and loss is another section's business; left loading here.
      if (path.startsWith('/analytics/profit-and-loss')) return new Promise(() => {});
      return { data: { data: [] } };
    },
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

beforeEach(() => {
  hold = null;
  try {
    window.localStorage.clear();
  } catch {
    /* storage refused */
  }
});
afterEach(cleanup);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <AnalyticsPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const productSection = () => screen.getByRole('heading', { name: en.analytics.topProducts }).closest('section')!;
const cycleSection = () => screen.getByRole('heading', { name: en.analytics.cycleProfitability }).closest('section')!;
const shownProducts = () => within(productSection()).queryAllByText(/^Product \d+$/).map((e) => e.textContent);
const shownCycles = () => within(cycleSection()).queryAllByText(/^CYC-/).map((e) => e.textContent);

// Eight products whose order differs by units and by revenue, plus three that sold nothing.
const EIGHT = [
  product(1, 10, 800),
  product(2, 80, 100),
  product(3, 30, 9_000),
  product(4, 50, 400),
  product(5, 20, 7_000),
  product(6, 70, 200),
  product(7, 40, 300),
  product(8, 60, 5_000),
];
const NOTHING_SOLD = [product(9, 0, 0), product(10, 0, 0), product(11, 0, 0)];

describe('Analytics — Top products shows five', () => {
  it('ranked by units: the five that sold most, most first', async () => {
    products = [...EIGHT, ...NOTHING_SOLD];
    cycles = [];
    renderPage();
    await waitFor(() => expect(shownProducts().length).toBeGreaterThan(0));
    expect(shownProducts()).toEqual(['Product 2', 'Product 6', 'Product 8', 'Product 4', 'Product 7']);
  });

  it('switched to revenue: the five that brought in most, most first', async () => {
    products = [...EIGHT, ...NOTHING_SOLD];
    cycles = [];
    renderPage();
    await waitFor(() => expect(shownProducts().length).toBeGreaterThan(0));
    fireEvent.click(within(productSection()).getByRole('radio', { name: en.dashboard.byRevenue }));
    await waitFor(() => expect(shownProducts()[0]).toBe('Product 3'));
    expect(shownProducts()).toEqual(['Product 3', 'Product 5', 'Product 8', 'Product 1', 'Product 4']);
  });

  it('a product that sold nothing never takes a place, even when there are not five', async () => {
    products = [product(1, 4, 400), product(2, 2, 200), ...NOTHING_SOLD];
    cycles = [];
    renderPage();
    await waitFor(() => expect(shownProducts().length).toBeGreaterThan(0));
    expect(shownProducts()).toEqual(['Product 1', 'Product 2']);
    fireEvent.click(within(productSection()).getByRole('radio', { name: en.dashboard.byRevenue }));
    await waitFor(() => expect(shownProducts()).toEqual(['Product 1', 'Product 2']));
  });

  it('nothing sold at all is the empty state, not a table of zeros', async () => {
    products = NOTHING_SOLD;
    cycles = [];
    renderPage();
    await waitFor(() => expect(within(productSection()).getByText(en.analytics.noTopProductsHint)).toBeTruthy());
    expect(shownProducts()).toEqual([]);
  });

  it('three products that sold: all three, no padding', async () => {
    products = [product(1, 5, 50), product(2, 9, 90), product(3, 1, 10)];
    cycles = [];
    renderPage();
    await waitFor(() => expect(shownProducts().length).toBeGreaterThan(0));
    expect(shownProducts()).toEqual(['Product 2', 'Product 1', 'Product 3']);
  });
});

describe('Analytics — Cycle profitability shows the five most profitable', () => {
  it('eight cycles: the five with the highest profit, highest first, losses left out', async () => {
    products = [];
    cycles = [
      cycle('CYC-01', 1_000),
      cycle('CYC-02', -5_000),
      cycle('CYC-03', 40_000),
      cycle('CYC-04', 7_500),
      cycle('CYC-05', 0),
      cycle('CYC-06', 90_000),
      cycle('CYC-07', -200),
      cycle('CYC-08', 12_000),
    ];
    renderPage();
    await waitFor(() => expect(shownCycles().length).toBeGreaterThan(0));
    expect(shownCycles()).toEqual(['CYC-06', 'CYC-03', 'CYC-08', 'CYC-04', 'CYC-01']);
  });

  it('fewer than five: every cycle, still by profit; equal profit falls back to the code', async () => {
    products = [];
    cycles = [cycle('CYC-01', -300), cycle('CYC-02', 500), cycle('CYC-03', 500)];
    renderPage();
    await waitFor(() => expect(shownCycles().length).toBeGreaterThan(0));
    expect(shownCycles()).toEqual(['CYC-02', 'CYC-03', 'CYC-01']);
  });
});

describe('Analytics — loading shows five rows in each list', () => {
  it('the products table and the cycle list each trace five rows', async () => {
    products = [];
    cycles = [];
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    renderPage();
    expect(within(productSection()).getAllByTestId('skeleton-row')).toHaveLength(5);
    expect(within(cycleSection()).getAllByTestId('skeleton-row')).toHaveLength(5);
    release();
  });
});
