import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';

// ── Doubles ──────────────────────────────────────────────────────────
// The locale-aware Link needs Next's router; an anchor with the same href is
// what the browser ends up with, and what these tests assert on.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const auth = vi.hoisted(() => ({ role: 'CORE_PARTNER' as string | undefined }));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: auth.role ? { id: 'u1', email: 'x@y.z', role: auth.role } : null }),
}));

const responses = vi.hoisted(() => ({ recent: [] as unknown[], fail: false, cycles: [] as unknown[] }));
const get = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { get } }));

import DashboardPage from '@/app/[locale]/dashboard/page';

const KPIS = {
  totalRevenue: 1000, totalExpenses: 50, totalCogs: 400, totalCashOut: 600, totalCashIn: 700,
  cashOnHand: 100, netProfit: 550, activeCycles: 2, inventoryValue: 3000, receivables: 300,
  collected: 700, lowStockAlerts: 3, totalCustomers: 4, totalProducts: 5,
};

beforeEach(() => {
  auth.role = 'CORE_PARTNER';
  responses.recent = [];
  responses.fail = false;
  responses.cycles = [];
  get.mockReset();
  get.mockImplementation((url: string) => {
    if (url.startsWith('/analytics/dashboard')) return Promise.resolve({ data: { data: KPIS } });
    if (url.startsWith('/analytics/top-products')) return Promise.resolve({ data: { data: [] } });
    if (url.startsWith('/analytics/cycle-profitability')) {
      return Promise.resolve({ data: { data: responses.cycles } });
    }
    if (url.startsWith('/analytics/recent-activity')) {
      return responses.fail
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ data: { data: responses.recent } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
});
afterEach(cleanup);

function renderPage(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
        <DashboardPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const tile = (key: string) => screen.findByTestId(`tile-${key}`);

// ── Tiles ────────────────────────────────────────────────────────────
describe('dashboard tiles lead to their lists', () => {
  it.each([
    ['revenue', '/sales'],
    ['collected', '/payments'],
    ['receivables', '/customers?sort=balance'],
    ['cogs', '/analytics'],
    ['expenses', '/ledger'],
    ['netProfit', '/analytics'],
    ['cashOut', '/ledger'],
    ['cashOnHand', '/ledger'],
    ['activeCycles', '/cycles'],
    ['inventoryValue', '/inventory'],
    ['lowStockAlerts', '/inventory?stock=low'],
    ['owedToLenders', '/lenders'],
  ])('%s → %s', async (key, href) => {
    renderPage();
    const el = await tile(key);
    expect(el.tagName).toBe('A');
    expect(el.getAttribute('href')).toBe(href);
  });

  it('owed to lenders: pounds at today\'s rate, and each friend\'s currency under it (§18)', async () => {
    get.mockImplementation((url: string) => {
      if (url.startsWith('/analytics/dashboard')) {
        return Promise.resolve({
          data: {
            data: {
              ...KPIS,
              owedToLenders: {
                lines: [{ currency: 'AED', owed: '20000.00', rateToEgp: '13.8500', owedEgp: '277000.00' }],
                totalEgp: '277000.00',
                missingRate: false,
              },
            },
          },
        });
      }
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    const el = await tile('owedToLenders');
    expect(el.textContent).toContain('277,000.00');
    expect(within(el).getByTestId('owed-to-lenders-lines').textContent).toContain('20,000.00 AED');
  });

  it('admin support gets the same business figures', async () => {
    auth.role = 'ADMIN_SUPPORT';
    renderPage();
    expect((await tile('receivables')).getAttribute('href')).toBe('/customers?sort=balance');
  });

  it('nobody signed in (the auth state still loading) fetches and links nothing', async () => {
    auth.role = undefined;
    renderPage();
    expect(screen.queryByTestId('tile-revenue')).toBeNull();
    expect(screen.queryByTestId('quick-action-newSale')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

// ── R1: a temporary investor sees only their own cycles ──────────────
describe('a temporary investor sees only their own cycles (R1)', () => {
  beforeEach(() => {
    auth.role = 'TEMP_INVESTOR';
  });

  it('no business-wide tile or top products, and those endpoints (403 for them) are never called', async () => {
    renderPage();
    await screen.findByTestId('your-cycles');
    expect(screen.queryByTestId('tile-revenue')).toBeNull();
    expect(screen.queryByText('Top products')).toBeNull();
    const urls = get.mock.calls.map((c) => String(c[0]));
    for (const refused of ['/analytics/dashboard', '/analytics/top-products', '/analytics/recent-activity']) {
      expect(urls.some((u) => u.startsWith(refused)), refused).toBe(false);
    }
  });

  it('their cycles, each with its profit so far and a link to the cycle', async () => {
    responses.cycles = [
      { cycleId: 'c1', cycleCode: 'CYC-1', status: 'SELLING', totalRevenue: 300, totalCost: 210, profit: 90 },
      { cycleId: 'c3', cycleCode: 'CYC-3', status: 'CLOSED', totalRevenue: 50, totalCost: 80, profit: -30 },
    ];
    renderPage();
    const link = (await screen.findByText('CYC-1')).closest('a');
    expect(link?.getAttribute('href')).toBe('/cycles/c1/details');
    expect(screen.getByText('CYC-3')).toBeTruthy();
    expect(screen.getAllByText('Profit so far')).toHaveLength(2);
  });

  it('an investor with no cycle stock yet → the empty state, not an error', async () => {
    renderPage();
    expect(await screen.findByText('None of your cycles has stock yet')).toBeTruthy();
  });

  it('renders in Arabic', async () => {
    renderPage('ar');
    expect(await screen.findByText('دوراتك')).toBeTruthy();
  });
});

// ── Quick actions ────────────────────────────────────────────────────
describe('quick actions follow the API roles', () => {
  it('a core partner sees all three, each opening the existing form', async () => {
    renderPage();
    await tile('revenue');
    expect(screen.getByTestId('quick-action-newSale').getAttribute('href')).toBe('/sales?new=1');
    expect(screen.getByTestId('quick-action-recordPayment').getAttribute('href')).toBe('/payments?new=1');
    expect(screen.getByTestId('quick-action-newCycle').getAttribute('href')).toBe('/cycles/new');
  });

  it('support staff may sell and take payments but not start a cycle', async () => {
    auth.role = 'ADMIN_SUPPORT';
    renderPage();
    await tile('revenue');
    expect(screen.getByTestId('quick-action-newSale')).toBeTruthy();
    expect(screen.getByTestId('quick-action-recordPayment')).toBeTruthy();
    expect(screen.queryByTestId('quick-action-newCycle')).toBeNull();
  });

  it.each(['TEMP_INVESTOR', 'SHOP_OWNER_PORTAL'])('%s sees no quick actions at all', async (role) => {
    auth.role = role;
    renderPage();
    await screen.findByTestId('your-cycles');
    expect(screen.queryByRole('navigation', { name: 'Quick actions' })).toBeNull();
    expect(screen.queryByText('New sale')).toBeNull();
    expect(screen.queryByText('Record payment')).toBeNull();
    expect(screen.queryByText('New cycle')).toBeNull();
  });
});

// ── Recent activity ──────────────────────────────────────────────────
describe('recent activity', () => {
  it('reads the activity endpoint, not the audit log', async () => {
    renderPage();
    await screen.findByText('Nothing has happened yet');
    const urls = get.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.startsWith('/analytics/recent-activity'))).toBe(true);
    expect(urls.some((u) => u.startsWith('/audit-logs'))).toBe(false);
  });

  it('an investor is not shown the panel and the endpoint (403 for them) is never called', async () => {
    auth.role = 'TEMP_INVESTOR';
    renderPage();
    await screen.findByTestId('your-cycles');
    expect(screen.queryByText('Recent activity')).toBeNull();
    expect(get.mock.calls.some((c) => String(c[0]).startsWith('/analytics/recent-activity'))).toBe(false);
  });

  it('an empty feed shows the empty state, not a blank box', async () => {
    renderPage();
    expect(await screen.findByText('Nothing has happened yet')).toBeTruthy();
  });

  it('a failed request says so instead of claiming nothing happened', async () => {
    responses.fail = true;
    renderPage();
    expect(await screen.findByText('Recent activity could not be loaded.')).toBeTruthy();
    expect(screen.queryByText('Nothing has happened yet')).toBeNull();
  });

  it('lists each kind with its reference, party and the day it happened', async () => {
    responses.recent = [
      {
        kind: 'SALE', id: 's1', occurredAt: '2026-10-09T10:00:00.000Z', recordedAt: '2026-10-09T10:00:00.000Z',
        reference: 'SO-2026-0042', status: 'CONFIRMED', amount: 410, currency: 'EGP',
        customer: { id: 'c1', displayName: 'Delta Motors' },
      },
      {
        kind: 'PAYMENT', id: 'p1', occurredAt: '2026-10-08T00:00:00.000Z', recordedAt: '2026-10-08T09:00:00.000Z',
        reference: 'CASH', amount: 150, currency: 'EGP', customer: { id: 'c1', displayName: 'Delta Motors' },
      },
      {
        kind: 'RECEIPT', id: 'b1', occurredAt: '2026-10-07T12:00:00.000Z', recordedAt: '2026-10-07T12:00:00.000Z',
        reference: 'SKU-1', quantity: 1284, product: { id: 'pr1', name: 'Brake pad', sku: 'SKU-1' },
      },
    ];
    renderPage();
    const panel = (await screen.findByText('SO-2026-0042')).closest('section')!;
    const p = within(panel);
    expect(p.getByText('Sale')).toBeTruthy();
    expect(p.getByText('Payment')).toBeTruthy();
    expect(p.getByText('Stock received')).toBeTruthy();
    expect(p.getByText('Cash')).toBeTruthy(); // the method code, translated
    expect(p.getByText('Confirmed')).toBeTruthy();
    expect(p.getByText('Brake pad')).toBeTruthy();
    expect(p.getByText('1,284 units')).toBeTruthy();
    expect(p.getByText('Oct 9, 2026')).toBeTruthy(); // occurredAt, not the missing createdAt
  });

  it('renders in Arabic: kinds and dates translated, no English left over', async () => {
    responses.recent = [
      {
        kind: 'SALE', id: 's1', occurredAt: '2026-10-09T10:00:00.000Z', recordedAt: '2026-10-09T10:00:00.000Z',
        reference: 'SO-1', status: 'CONFIRMED', amount: 410, currency: 'EGP',
        customer: { id: 'c1', displayName: 'دلتا موتورز' },
      },
    ];
    renderPage('ar');
    const panel = (await screen.findByText('SO-1')).closest('section')!;
    expect(within(panel).getByText('بيع')).toBeTruthy();
    expect(within(panel).queryByText('Sale')).toBeNull();
    expect(screen.getByTestId('quick-action-newSale').textContent).toContain('بيع جديد');
  });

  it('an unknown kind from a newer API still shows something readable', async () => {
    responses.recent = [
      { kind: 'REFUND', id: 'r1', occurredAt: '2026-10-09T10:00:00.000Z', recordedAt: '2026-10-09T10:00:00.000Z', reference: null },
    ];
    renderPage();
    expect(await screen.findByText('REFUND')).toBeTruthy();
  });
});

describe('every dashboard key exists in both languages', () => {
  it('en and ar have the same dashboard keys', () => {
    const keys = (o: object, prefix = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
      );
    expect(keys(ar.dashboard).sort()).toEqual(keys(en.dashboard).sort());
  });
});

