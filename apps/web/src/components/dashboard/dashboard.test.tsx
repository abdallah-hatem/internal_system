import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';

// ── Doubles ──────────────────────────────────────────────────────────
// The locale-aware Link needs Next's router; an anchor with the same href is
// what the browser ends up with, and what these tests assert on.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
}));

const auth = vi.hoisted(() => ({ role: 'CORE_PARTNER' as string | undefined }));
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ user: auth.role ? { id: 'u1', email: 'x@y.z', role: auth.role } : null }),
}));

const responses = vi.hoisted(() => ({ cycles: [] as unknown[] }));
const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { get, post } }));

import DashboardPage from '@/app/[locale]/dashboard/page';
import { QUICK_ACTIONS, quickActionsFor } from '@/components/dashboard/dashboard-model';

const KPIS = {
  totalRevenue: 1000, totalExpenses: 50, totalCogs: 400, totalCashOut: 600, totalCashIn: 700,
  cashOnHand: 100, netProfit: 550, activeCycles: 2, inventoryValue: 3000, receivables: 300,
  collected: 700, lowStockAlerts: 3, totalCustomers: 4, totalProducts: 5, unitsInStock: 42,
  // This calendar month — deliberately unlike the all-time figures above, so
  // a tile reading the wrong one shows the wrong number.
  month: { from: '2026-10-01', to: '2026-10-23', revenue: 123.45, collected: 67.8, netProfit: -9.5, expenses: 21.25 },
};

beforeEach(() => {
  auth.role = 'CORE_PARTNER';
  responses.cycles = [];
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url: string) => {
    // What the Fuel form reads when it opens.
    if (url.startsWith('/cycles')) return Promise.resolve({ data: { data: [] } });
    if (url.startsWith('/currency-rates')) return Promise.resolve({ data: { data: {} } });
    if (url.startsWith('/analytics/dashboard')) return Promise.resolve({ data: { data: KPIS } });
    if (url.startsWith('/analytics/top-products')) return Promise.resolve({ data: { data: [] } });
    if (url.startsWith('/customers/to-collect')) {
      return Promise.resolve({ data: { data: { totalOwed: '0.00', totalOverdue: '0.00', customers: 0, rows: [] } } });
    }
    if (url.startsWith('/analytics/cycle-profitability')) {
      return Promise.resolve({ data: { data: responses.cycles } });
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
        <ToastProvider>
          <DashboardPage />
        </ToastProvider>
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
    ['expenses', '/ledger'],
    ['netProfit', '/analytics'],
    ['cashOnHand', '/ledger'],
    ['activeCycles', '/cycles'],
    ['inventoryValue', '/inventory'],
    ['unitsInStock', '/inventory'],
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

  it('cost of goods sold and cash paid out are not on the dashboard (owner 2026-10-23: on Analytics)', async () => {
    renderPage();
    await tile('revenue');
    expect(screen.queryByTestId('tile-cogs')).toBeNull();
    expect(screen.queryByTestId('tile-cashOut')).toBeNull();
    expect(screen.queryByText('Cost of Goods Sold')).toBeNull();
    expect(screen.queryByText('Cash Paid Out')).toBeNull();
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

// ── A role the business figures refuse: nothing at all ──────────────
// The investor's own "your cycles" dashboard (R1) went on 2026-10-19 with the
// owner's word that only the partners use the office: an investor is refused
// at the door (OFFICE_NOT_FOR_INVESTORS). A role that still got here sees no
// figures, and nothing it would be refused is asked for.
describe('a role the business-wide figures refuse', () => {
  it.each(['TEMP_INVESTOR', 'SHOP_OWNER_PORTAL'])('%s: the title only, no tile, no top products, nothing fetched', async (role) => {
    auth.role = role;
    renderPage();
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(screen.queryByTestId('tile-revenue')).toBeNull();
    expect(screen.queryByText('Top products')).toBeNull();
    expect(screen.queryByTestId('your-cycles')).toBeNull();
    const urls = get.mock.calls.map((c) => String(c[0]));
    for (const refused of ['/analytics/dashboard', '/analytics/top-products', '/analytics/cycle-profitability']) {
      expect(urls.some((u) => u.startsWith(refused)), refused).toBe(false);
    }
  });
});

// ── Quick actions ────────────────────────────────────────────────────
describe('quick actions follow the API roles', () => {
  it('a core partner sees the three, each opening the existing form', async () => {
    renderPage();
    await tile('revenue');
    expect(screen.getByTestId('quick-action-newSale').getAttribute('href')).toBe('/sales?new=1');
    expect(screen.getByTestId('quick-action-recordPayment').getAttribute('href')).toBe('/payments?new=1');
    expect(screen.getByTestId('quick-action-newCycle').getAttribute('href')).toBe('/cycles/new');
    const nav = screen.getByRole('navigation', { name: en.dashboard.quickActions });
    expect(nav.querySelectorAll('a, button')).toHaveLength(3);
  });

  it('support staff may sell and take payments but not start a cycle', async () => {
    auth.role = 'ADMIN_SUPPORT';
    renderPage();
    await tile('revenue');
    expect(screen.getByTestId('quick-action-newSale')).toBeTruthy();
    expect(screen.getByTestId('quick-action-recordPayment')).toBeTruthy();
    expect(screen.queryByTestId('quick-action-newCycle')).toBeNull();
    // POST /ledger is core partners only: a button support staff could not save from is a dead end.
    expect(screen.queryByTestId('quick-action-recordFuel')).toBeNull();
  });

  it.each(['TEMP_INVESTOR', 'SHOP_OWNER_PORTAL'])('%s sees no quick actions at all', async (role) => {
    auth.role = role;
    renderPage();
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(screen.queryByRole('navigation', { name: 'Quick actions' })).toBeNull();
    expect(screen.queryByText('New sale')).toBeNull();
    expect(screen.queryByText('Record payment')).toBeNull();
    expect(screen.queryByText('New cycle')).toBeNull();
    expect(screen.queryByTestId('quick-action-recordFuel')).toBeNull();
  });
});

// ── No activity feed (removed 2026-10-17, owner) ─────────────────────
describe('the dashboard carries no recent-activity feed', () => {
  it('no panel, and no feed is asked for', async () => {
    renderPage();
    await tile('revenue');
    await screen.findByText('Top products');
    expect(screen.queryByText('Recent activity')).toBeNull();
    const urls = get.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith('/analytics/recent-activity'))).toBe(false);
    expect(urls.some((u) => u.startsWith('/audit-logs'))).toBe(false);
  });

  it('renders in Arabic', async () => {
    renderPage('ar');
    await tile('revenue');
    expect(screen.getByTestId('quick-action-newSale').textContent).toContain('بيع جديد');
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


// ── No Fuel on the dashboard (owner 2026-10-18: "remove fuel from dashboard") ──
// Fuel is recorded from the Ledger page's quick-action strip only
// (ledger-quick-actions.test.tsx). The dashboard keeps the other three.
describe('the dashboard has no Fuel quick action', () => {
  it.each(['CORE_PARTNER', 'ADMIN_SUPPORT', 'TEMP_INVESTOR', 'SHOP_OWNER_PORTAL', undefined])(
    'role %s: no Fuel button, no ledger form, no Fuel label',
    async (role) => {
      auth.role = role;
      renderPage();
      if (role === 'CORE_PARTNER' || role === 'ADMIN_SUPPORT') await tile('revenue');
      else if (role) await screen.findByRole('heading', { name: 'Dashboard' });
      expect(screen.queryByTestId('quick-action-recordFuel')).toBeNull();
      expect(document.querySelector('[data-ledger-entry-dialog]')).toBeNull();
      const nav = screen.queryByRole('navigation', { name: en.dashboard.quickActions });
      if (nav) expect(nav.textContent).not.toContain(en.dashboard.actions.recordFuel);
    },
  );

  it('the model offers no fuel to any role', () => {
    for (const role of ['CORE_PARTNER', 'ADMIN_SUPPORT', 'TEMP_INVESTOR', 'SHOP_OWNER_PORTAL', undefined]) {
      expect(quickActionsFor(role).map((a) => a.key as string)).not.toContain('recordFuel');
    }
    expect(QUICK_ACTIONS.map((a) => a.key as string)).not.toContain('recordFuel');
  });

  it('nor in Arabic', async () => {
    renderPage('ar');
    await tile('revenue');
    expect(screen.queryByTestId('quick-action-recordFuel')).toBeNull();
    const nav = screen.getByRole('navigation', { name: ar.dashboard.quickActions });
    expect(nav.textContent).not.toContain(ar.dashboard.actions.recordFuel);
  });
});

// Owner 2026-10-18: on a phone the tiles dropped their icons and the dashboard
// read as grey numbers. Option A: every tile keeps its icon at every width —
// small above the label on a phone, beside the figure from sm up.
describe('every tile shows its icon on a phone too', () => {
  it('no tile hides its icon below sm, and the icon sits above the label there', async () => {
    renderPage();
    const el = await tile('revenue');
    const icons = screen.getAllByTestId('tile-icon');
    expect(icons).toHaveLength(11);
    for (const icon of icons) {
      expect(icon.className.split(/\s+/)).not.toContain('hidden');
      expect(icon.querySelector('svg')).toBeTruthy();
    }
    // Icon after the text in the DOM, so flex-col-reverse puts it on top on a phone.
    const body = el.firstElementChild as HTMLElement;
    expect(body.className).toContain('flex-col-reverse');
    expect(body.className).toContain('sm:flex-row');
    expect(body.lastElementChild?.getAttribute('data-testid')).toBe('tile-icon');
  });
});

// Owner 2026-10-23: a phone shows the first four Right now figures and the
// four of This month; the other three Right now tiles wait behind See more (3).
// A wider screen shows every tile.
describe('a phone shows four and four, then See more', () => {
  const FIRST = ['cashOnHand', 'receivables', 'owedToLenders', 'inventoryValue', 'revenue', 'collected', 'netProfit', 'expenses'];
  const LATER = ['unitsInStock', 'lowStockAlerts', 'activeCycles'];
  const phoneHidden = (key: string) => screen.getByTestId(`tile-${key}`).className.split(/\s+/).includes('max-sm:hidden');

  it('the eight show, the other three wait — on a phone only', async () => {
    renderPage();
    await tile('revenue');
    for (const key of FIRST) expect(phoneHidden(key), key).toBe(false);
    for (const key of LATER) expect(phoneHidden(key), key).toBe(true);
    const toggle = screen.getByTestId('tiles-toggle');
    expect(toggle.textContent).toContain('See more (3)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.className.split(/\s+/)).toContain('sm:hidden');
    // The toggle sits in Right now, under its tiles, before This month begins.
    expect(within(screen.getByTestId('dashboard-right-now')).getByTestId('tiles-toggle')).toBe(toggle);
  });

  it('See more shows them all; See less folds them again', async () => {
    renderPage();
    await tile('revenue');
    fireEvent.click(screen.getByTestId('tiles-toggle'));
    for (const key of LATER) expect(phoneHidden(key), key).toBe(false);
    expect(screen.getByTestId('tiles-toggle').textContent).toContain('See less');
    expect(screen.getByTestId('tiles-toggle').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByTestId('tiles-toggle'));
    expect(phoneHidden('activeCycles')).toBe(true);
    // Folding again never hides one of the eight.
    for (const key of FIRST) expect(phoneHidden(key), key).toBe(false);
  });

  it('reads in Arabic', async () => {
    renderPage('ar');
    await tile('revenue');
    expect(screen.getByTestId('tiles-toggle').textContent).toContain('عرض المزيد (3)');
  });

  it('an investor, who has no business tiles, gets no toggle', async () => {
    auth.role = 'TEMP_INVESTOR';
    renderPage();
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(screen.queryByTestId('tiles-toggle')).toBeNull();
  });
});

// Owner 2026-10-23, picked from a rendered sample, after asking "are the data
// filtered or all time, like net profit?" — the figures sit in two headed groups.
describe('two groups: Right now, then This month', () => {
  const keysIn = (group: string) =>
    [...screen.getByTestId(group).querySelectorAll('[data-testid^="tile-"]')]
      .map((el) => el.getAttribute('data-testid') ?? '')
      .filter((id) => id !== 'tile-icon')
      .map((id) => id.replace(/^tile-/, ''));
  const classes = async (key: string) => (await tile(key)).className.split(/\s+/);

  it('Right now holds today’s figures in the stated order; This month the month’s', async () => {
    renderPage();
    await tile('revenue');
    expect(keysIn('dashboard-right-now')).toEqual([
      'cashOnHand', 'receivables', 'owedToLenders', 'inventoryValue', 'unitsInStock', 'lowStockAlerts', 'activeCycles',
    ]);
    expect(keysIn('dashboard-this-month')).toEqual(['revenue', 'collected', 'netProfit', 'expenses']);
    // Right now comes first on the page.
    const first = screen.getByTestId('dashboard-right-now');
    const second = screen.getByTestId('dashboard-this-month');
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('each group is headed, in English and in Arabic', async () => {
    renderPage();
    await tile('revenue');
    expect(within(screen.getByTestId('dashboard-right-now')).getByRole('heading', { name: 'Right now' })).toBeTruthy();
    expect(within(screen.getByTestId('dashboard-this-month')).getByRole('heading', { name: 'This month' })).toBeTruthy();
    cleanup();
    renderPage('ar');
    await tile('revenue');
    expect(within(screen.getByTestId('dashboard-right-now')).getByRole('heading', { name: 'الآن' })).toBeTruthy();
    expect(within(screen.getByTestId('dashboard-this-month')).getByRole('heading', { name: 'هذا الشهر' })).toBeTruthy();
  });

  it('the labels say what each figure is: To collect, Stock value', async () => {
    renderPage();
    expect((await tile('receivables')).textContent).toContain('To collect');
    expect((await tile('inventoryValue')).textContent).toContain('Stock value');
  });

  it('This month’s figures are the API’s month block, not the all-time ones', async () => {
    renderPage();
    expect((await tile('revenue')).textContent).toContain('123.45');
    expect((await tile('revenue')).textContent).not.toContain('1,000.00');
    expect((await tile('collected')).textContent).toContain('67.80');
    expect((await tile('netProfit')).textContent).toContain('9.50');
    expect((await tile('netProfit')).textContent).not.toContain('550.00');
    expect((await tile('expenses')).textContent).toContain('21.25');
    // Right now still reads the figures of today.
    expect((await tile('cashOnHand')).textContent).toContain('100.00');
    expect((await tile('receivables')).textContent).toContain('300.00');
  });

  it('an API without the month block shows zeros, never the all-time figures under a This month heading', async () => {
    const old: Record<string, unknown> = { ...KPIS };
    delete old.month;
    get.mockImplementation((url: string) => {
      if (url.startsWith('/analytics/dashboard')) return Promise.resolve({ data: { data: old } });
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    expect((await tile('revenue')).textContent).toContain('0.00');
    expect((await tile('revenue')).textContent).not.toContain('1,000.00');
  });

  it('This month links to Analytics’ Profit and loss on This month', async () => {
    renderPage();
    await tile('revenue');
    const link = screen.getByTestId('dashboard-pnl-link');
    expect(link.getAttribute('href')).toBe('/analytics?period=month');
    expect(link.textContent).toContain('Profit and loss');
    cleanup();
    renderPage('ar');
    await tile('revenue');
    expect(screen.getByTestId('dashboard-pnl-link').textContent).toContain(ar.analytics.pnl.title);
  });

  it('a wide screen: a row of four then a row of three, each filling its width; no lone tile in two columns', async () => {
    renderPage();
    await tile('revenue');
    for (const key of ['cashOnHand', 'receivables', 'owedToLenders', 'inventoryValue']) {
      expect(await classes(key), key).toContain('@[68rem]:col-span-3');
    }
    for (const key of ['unitsInStock', 'lowStockAlerts', 'activeCycles']) {
      expect(await classes(key), key).toContain('@[68rem]:col-span-4');
    }
    expect(screen.getByTestId('dashboard-right-now-grid').className.split(/\s+/)).toContain('@[68rem]:grid-cols-12');
    // Seven in two columns: the last takes the row.
    expect(await classes('activeCycles')).toContain('col-span-2');
    expect(await classes('lowStockAlerts')).not.toContain('col-span-2');
    // Four in This month: two rows of two on a phone, one row of four wide.
    expect(screen.getByTestId('dashboard-this-month-grid').className.split(/\s+/)).toEqual(
      expect.arrayContaining(['grid-cols-2', '@[68rem]:grid-cols-4']),
    );
    for (const key of ['revenue', 'collected', 'netProfit', 'expenses']) {
      expect((await classes(key)).some((c) => c.includes('col-span')), key).toBe(false);
    }
  });

  it('the skeleton traces the two groups: headed, seven then four, with the tiles’ own spans', async () => {
    get.mockImplementation((url: string) => {
      if (url.startsWith('/analytics/dashboard')) return new Promise(() => {});
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    const first = await screen.findByTestId('dashboard-right-now');
    const second = screen.getByTestId('dashboard-this-month');
    expect(within(first).getAllByTestId('skeleton-row')).toHaveLength(7);
    expect(within(second).getAllByTestId('skeleton-row')).toHaveLength(4);
    expect(within(first).getByRole('heading', { name: 'Right now' })).toBeTruthy();
    expect(within(second).getByRole('heading', { name: 'This month' })).toBeTruthy();
    // The same spans as the tiles, so nothing moves when the figures land.
    const rn = within(first).getAllByTestId('skeleton-row').map((el) => el.className.split(/\s+/));
    expect(rn.slice(0, 4).every((c) => c.includes('@[68rem]:col-span-3'))).toBe(true);
    expect(rn.slice(4).every((c) => c.includes('@[68rem]:col-span-4'))).toBe(true);
    expect(rn[6]).toContain('col-span-2');
    expect(rn.slice(4).every((c) => c.includes('max-sm:hidden'))).toBe(true);
  });
});

// Owner 2026-10-18: "how is 21 sold on top of 28?", then "a chart for the
// top 5 sold products, as in qty not revenue". The card ranks by units (the
// default) or revenue, shows the ranked figure first with a bar, and remembers
// the choice on this device.
describe('top products: units or revenue, with bars', () => {
  const ROWS = {
    units: [
      { productId: 'p4', name: 'Y20 FM', sku: 'PRD-000004', totalQuantitySold: 28, revenueEgp: 25000 },
      { productId: 'p1', name: 'Y30 Headset', sku: 'PRD-000001', totalQuantitySold: 21, revenueEgp: 25200 },
      { productId: 'p5', name: 'Y12 PRO', sku: 'PRD-000005', totalQuantitySold: 0, revenueEgp: 0 },
    ],
    revenue: [
      { productId: 'p1', name: 'Y30 Headset', sku: 'PRD-000001', totalQuantitySold: 21, revenueEgp: 25200 },
      { productId: 'p4', name: 'Y20 FM', sku: 'PRD-000004', totalQuantitySold: 28, revenueEgp: 25000 },
    ],
  };
  const topUrls = () => get.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/analytics/top-products'));

  beforeEach(() => {
    window.localStorage.removeItem('topProductsBy');
    get.mockImplementation((url: string) => {
      if (url.startsWith('/analytics/dashboard')) return Promise.resolve({ data: { data: KPIS } });
      if (url.startsWith('/analytics/top-products')) {
        return Promise.resolve({ data: { data: url.includes('by=revenue') ? ROWS.revenue : ROWS.units } });
      }
      if (url.startsWith('/customers/to-collect')) {
        return Promise.resolve({ data: { data: { totalOwed: '0.00', totalOverdue: '0.00', customers: 0, rows: [] } } });
      }
      return Promise.resolve({ data: { data: [] } });
    });
  });

  const rows = async () => {
    const card = await screen.findByTestId('top-products');
    await within(card).findAllByTestId('top-product');
    return within(card).getAllByTestId('top-product');
  };
  const bar = (row: HTMLElement) => within(row).getByTestId('top-product-bar').style.width;

  it('units by default: asks the server for units, 28 before 21, units first, bars against the top seller', async () => {
    renderPage();
    const [a, b, c] = await rows();
    expect(topUrls().at(-1)).toContain('by=units');
    expect(a.textContent).toContain('Y20 FM');
    expect(a.firstElementChild!.textContent).toContain('28 sold');
    expect(within(a).getByTestId('top-product-revenue').textContent).toContain('25,000.00');
    expect([bar(a), bar(b), bar(c)]).toEqual(['100%', '75%', '0%']);
    expect(screen.getByRole('radio', { name: 'Units' }).getAttribute('aria-checked')).toBe('true');
  });

  it('Revenue re-asks the server, puts revenue first, and the bar follows it', async () => {
    renderPage();
    await rows();
    fireEvent.click(screen.getByRole('radio', { name: 'Revenue' }));
    await waitFor(() => expect(topUrls().at(-1)).toContain('by=revenue'));
    await waitFor(async () => expect((await rows())[0].textContent).toContain('Y30 Headset'));
    const [a, b] = await rows();
    expect(a.firstElementChild!.textContent).toContain('25,200.00');
    expect(bar(a)).toBe('100%');
    expect(bar(b)).toBe('99%');
  });

  it('the choice is remembered on this device — the second visit opens on Revenue', async () => {
    renderPage();
    await rows();
    fireEvent.click(screen.getByRole('radio', { name: 'Revenue' }));
    await waitFor(() => expect(topUrls().at(-1)).toContain('by=revenue'));
    cleanup();
    get.mockClear();
    renderPage();
    await rows();
    expect(topUrls().every((u) => u.includes('by=revenue'))).toBe(true);
    expect(screen.getByRole('radio', { name: 'Revenue' }).getAttribute('aria-checked')).toBe('true');
  });

  it('storage that refuses (a private window) breaks nothing: the switch still works', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    renderPage();
    await rows();
    fireEvent.click(screen.getByRole('radio', { name: 'Revenue' }));
    await waitFor(() => expect(topUrls().at(-1)).toContain('by=revenue'));
    setItem.mockRestore();
    // Back to units so the next test starts clean.
    fireEvent.click(screen.getByRole('radio', { name: 'Units' }));
  });

  it('reads in Arabic', async () => {
    renderPage('ar');
    await rows();
    expect(screen.getByRole('radio', { name: 'الكمية' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'الإيراد' })).toBeTruthy();
  });
});
