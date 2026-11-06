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
import { QUICK_ACTIONS, RIGHT_NOW_TILES, quickActionsFor } from '@/components/dashboard/dashboard-model';

const KPIS = {
  totalRevenue: 1000, totalExpenses: 50, totalCogs: 400, totalCashOut: 600, totalCashIn: 700,
  // Cash on hand is still in the response (the assistant reads it) and unlike
  // Cash from sales, so a tile showing the wrong one shows the wrong number.
  cashOnHand: 100, cashFromSalesEgp: 126400, netProfit: 550, activeCycles: 2, inventoryValue: 3000, receivables: 300,
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
    ['cashFromSales', '/payments'],
    ['activeCycles', '/cycles'],
    ['stock', '/inventory'],
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

  it('owed to lenders: many currencies and a missing rate stay on one line, every amount and the note still there (2026-11-02)', async () => {
    get.mockImplementation((url: string) => {
      if (url.startsWith('/analytics/dashboard')) {
        return Promise.resolve({
          data: {
            data: {
              ...KPIS,
              owedToLenders: {
                lines: [
                  { currency: 'AED', owed: '111482.31', rateToEgp: '13.8500', owedEgp: '1544029.99' },
                  { currency: 'HKD', owed: '1000.00', rateToEgp: null, owedEgp: null },
                  { currency: 'USD', owed: '2500.00', rateToEgp: '50.0000', owedEgp: '125000.00' },
                ],
                totalEgp: '1669029.99',
                missingRate: true,
              },
            },
          },
        });
      }
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    const el = await tile('owedToLenders');
    const lines = within(el).getByTestId('owed-to-lenders-lines');
    // One line that is cut at the tile's edge, never one that wraps.
    expect(lines.className).toContain('truncate');
    for (const amount of ['111,482.31 AED', '1,000.00 HKD', '2,500.00 USD']) {
      expect(lines.textContent).toContain(amount);
      expect(lines.parentElement!.getAttribute('title')).toContain(amount);
    }
    // The note is a hover and a screen reader away, with a sign on screen.
    expect(within(el).getByTestId('owed-to-lenders-no-rate')).toBeTruthy();
    expect(lines.parentElement!.getAttribute('title')).toContain(en.dashboard.owedToLendersNoRate);
    expect(within(el).getByText(en.dashboard.owedToLendersNoRate).className).toContain('sr-only');
  });

  it('owed to lenders: no sign when every currency has a rate', async () => {
    get.mockImplementation((url: string) => {
      if (url.startsWith('/analytics/dashboard')) {
        return Promise.resolve({
          data: { data: { ...KPIS, owedToLenders: { lines: [{ currency: 'AED', owed: '10.00', rateToEgp: '13.85', owedEgp: '138.50' }], totalEgp: '138.50', missingRate: false } } },
        });
      }
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    const el = await tile('owedToLenders');
    expect(within(el).queryByTestId('owed-to-lenders-no-rate')).toBeNull();
    expect(within(el).queryByText(en.dashboard.owedToLendersNoRate)).toBeNull();
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
    expect(icons).toHaveLength(10);
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
// four of This month; the rest of Right now waits behind See more — two tiles
// since Right now became six (2026-11-06). A wider screen shows every tile.
describe('a phone shows four and four, then See more', () => {
  const FIRST = ['cashFromSales', 'receivables', 'owedToLenders', 'stock', 'revenue', 'collected', 'netProfit', 'expenses'];
  const LATER = ['lowStockAlerts', 'activeCycles'];
  const phoneHidden = (key: string) => screen.getByTestId(`tile-${key}`).className.split(/\s+/).includes('max-sm:hidden');

  it('the eight show, the other two wait — on a phone only', async () => {
    renderPage();
    await tile('revenue');
    for (const key of FIRST) expect(phoneHidden(key), key).toBe(false);
    for (const key of LATER) expect(phoneHidden(key), key).toBe(true);
    const toggle = screen.getByTestId('tiles-toggle');
    expect(toggle.textContent).toContain('See more (2)');
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
    expect(screen.getByTestId('tiles-toggle').textContent).toContain('عرض المزيد (2)');
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
      'cashFromSales', 'receivables', 'owedToLenders', 'stock', 'lowStockAlerts', 'activeCycles',
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

  it('the labels say what each figure is: To collect, Stock', async () => {
    renderPage();
    expect((await tile('receivables')).textContent).toContain('To collect');
    expect((await tile('stock')).textContent).toContain('Stock');
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
    expect((await tile('cashFromSales')).textContent).toContain('126,400.00');
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

  it('a wide screen: Right now in two rows of three, no tile spanning; This month one row of four', async () => {
    renderPage();
    await tile('revenue');
    // Six tiles: three across wide, two across below — full rows either way,
    // so no tile needs to stretch over the row (2026-11-06).
    expect(screen.getByTestId('dashboard-right-now-grid').className.split(/\s+/)).toEqual(
      expect.arrayContaining(['grid-cols-2', '@[68rem]:grid-cols-3']),
    );
    for (const key of ['cashFromSales', 'receivables', 'owedToLenders', 'stock', 'lowStockAlerts', 'activeCycles']) {
      expect((await classes(key)).some((c) => c.includes('col-span')), key).toBe(false);
    }
    // Four in This month: two rows of two on a phone, one row of four wide.
    expect(screen.getByTestId('dashboard-this-month-grid').className.split(/\s+/)).toEqual(
      expect.arrayContaining(['grid-cols-2', '@[68rem]:grid-cols-4']),
    );
    for (const key of ['revenue', 'collected', 'netProfit', 'expenses']) {
      expect((await classes(key)).some((c) => c.includes('col-span')), key).toBe(false);
    }
  });

  it('the skeleton traces the two groups: headed, six then four, the phone’s hidden two hidden, a second line and a badge where the tile has one', async () => {
    get.mockImplementation((url: string) => {
      if (url.startsWith('/analytics/dashboard')) return new Promise(() => {});
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    const first = await screen.findByTestId('dashboard-right-now');
    const second = screen.getByTestId('dashboard-this-month');
    expect(within(first).getAllByTestId('skeleton-row')).toHaveLength(RIGHT_NOW_TILES.length);
    expect(within(first).getAllByTestId('skeleton-row')).toHaveLength(6);
    expect(within(second).getAllByTestId('skeleton-row')).toHaveLength(4);
    expect(within(first).getByRole('heading', { name: 'Right now' })).toBeTruthy();
    expect(within(second).getByRole('heading', { name: 'This month' })).toBeTruthy();
    // The same grid as the tiles, and no spans on either.
    expect(first.querySelector('.grid')!.className.split(/\s+/)).toContain('@[68rem]:grid-cols-3');
    const rn = within(first).getAllByTestId('skeleton-row');
    expect(rn.every((el) => !el.className.includes('col-span'))).toBe(true);
    // Hidden on a phone exactly where the tiles are: the last two.
    expect(rn.map((el) => el.className.split(/\s+/).includes('max-sm:hidden'))).toEqual([false, false, false, false, true, true]);
    // A text column of three lines — label, figure, second line — where the
    // tile carries a second line: Cash from sales and Owed to lenders.
    const lines = rn.map((el) => el.querySelector('.flex-1')!.children.length);
    expect(lines).toEqual([3, 2, 3, 2, 2, 2]);
    // The count pill beside Stock's label, and nowhere else.
    expect(rn.map((el) => !!el.querySelector('[data-testid="skeleton-badge"]'))).toEqual([false, false, false, true, false, false]);
  });

  it('…and the tiles carry that second line and badge exactly where the skeleton does', async () => {
    renderPage();
    await tile('revenue');
    const subs = await Promise.all(
      RIGHT_NOW_TILES.map(async (key) => (await tile(key)).querySelector('.flex-1')!.children.length),
    );
    expect(subs).toEqual([3, 2, 3, 2, 2, 2]);
    const badges = await Promise.all(RIGHT_NOW_TILES.map(async (key) => !!within(await tile(key)).queryByTestId('stat-badge')));
    expect(badges).toEqual([false, false, false, true, false, false]);
  });
});

// Owner 2026-11-06: "we don't need cash on hand, make it available cash from
// sales", and Stock value with Units in stock as one tile.
describe('Cash from sales replaces Cash on hand; one Stock tile', () => {
  it('Cash from sales is the first Right now tile, the server’s figure, saying what it is', async () => {
    renderPage();
    const el = await tile('cashFromSales');
    expect(el.textContent).toContain('Cash from sales');
    expect(el.textContent).toContain('126,400.00');
    expect(el.textContent).toContain('Paid in, less refunds');
    // One line, as the skeleton traces it: cut, never wrapped (it wrapped at 390).
    expect(within(el).getByTestId('cash-from-sales-sub').className.split(/\s+/)).toContain('truncate');
    expect(within(el).getByTestId('cash-from-sales-sub').getAttribute('title')).toBe('Paid in, less refunds');
    // Not cash on hand under a new name.
    expect(el.textContent).not.toContain('100.00 EGP');
    expect(within(screen.getByTestId('dashboard-right-now')).getAllByRole('link')[0]).toBe(el);
  });

  it('Cash on hand is gone from the dashboard, in both languages, though the API still sends it', async () => {
    renderPage();
    await tile('revenue');
    expect(screen.queryByTestId('tile-cashOnHand')).toBeNull();
    expect(screen.queryByText(/Cash on hand/i)).toBeNull();
    expect(document.body.textContent).not.toContain('Cash on hand');
    cleanup();
    renderPage('ar');
    await tile('revenue');
    expect(document.body.textContent).not.toContain('النقد المتاح');
    expect((await tile('cashFromSales')).textContent).toContain(ar.dashboard.cashFromSales);
    expect((await tile('cashFromSales')).textContent).toContain(ar.dashboard.cashFromSalesSub);
  });

  it('a negative figure (more refunded than paid) is shown as it is, never as zero', async () => {
    get.mockImplementation((url: string) => {
      if (url.startsWith('/analytics/dashboard')) return Promise.resolve({ data: { data: { ...KPIS, cashFromSalesEgp: -300 } } });
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    expect((await tile('cashFromSales')).textContent).toContain('-300.00');
  });

  it('an API older than the figure shows 0, not cash on hand', async () => {
    const old: Record<string, unknown> = { ...KPIS };
    delete old.cashFromSalesEgp;
    get.mockImplementation((url: string) => {
      if (url.startsWith('/analytics/dashboard')) return Promise.resolve({ data: { data: old } });
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    const el = await tile('cashFromSales');
    expect(el.textContent).toContain('0.00');
    expect(el.textContent).not.toContain('100.00');
  });

  it('Stock: the value as the figure, the unit count a small pill beside its title — not a second line', async () => {
    renderPage();
    const el = await tile('stock');
    expect(within(el).getByTestId('stat-figure').textContent).toContain('3,000.00');
    const label = within(el).getByTestId('stat-label');
    const badge = within(label).getByTestId('stat-badge');
    expect(badge.textContent).toBe('42');
    // Beside the title, after it, in the same line.
    expect(label.textContent).toMatch(/^Stock42/);
    // Muted, small, a pill — the screen reader hears the words instead.
    expect(badge.className.split(/\s+/)).toEqual(expect.arrayContaining(['rounded-full', 'bg-muted', 'text-muted-foreground']));
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(within(label).getByText('42 units in stock').className).toContain('sr-only');
    // No second line under the figure.
    expect(el.querySelector('.flex-1')!.children).toHaveLength(2);
    cleanup();
    renderPage('ar');
    const arEl = await tile('stock');
    expect(arEl.textContent).toContain(ar.dashboard.stock);
    expect(within(arEl).getByTestId('stat-badge').textContent).toBe('42');
    expect(within(arEl).getByText('42 قطعة في المخزون').className).toContain('sr-only');
  });

  it('there is no Units in stock tile, nor a Stock value one — Stock is the one place the count shows', async () => {
    renderPage();
    await tile('revenue');
    expect(screen.queryByTestId('tile-unitsInStock')).toBeNull();
    expect(screen.queryByTestId('tile-inventoryValue')).toBeNull();
    expect(RIGHT_NOW_TILES as readonly string[]).not.toContain('unitsInStock');
    expect(RIGHT_NOW_TILES as readonly string[]).not.toContain('inventoryValue');
    expect(document.body.textContent).not.toMatch(/Units in stock|Items in stock|Stock value/);
    // The count appears once on the whole dashboard: the badge.
    expect(screen.getAllByTestId('stat-badge')).toHaveLength(1);
  });

  it('Stock keeps fractional units (metres, kilos) and reads 0 when empty', async () => {
    get.mockImplementation((url: string) => {
      if (url.startsWith('/analytics/dashboard')) return Promise.resolve({ data: { data: { ...KPIS, unitsInStock: 12.5 } } });
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    expect(within(await tile('stock')).getByTestId('stat-badge').textContent).toBe('12.5');
    cleanup();
    get.mockImplementation((url: string) => {
      if (url.startsWith('/analytics/dashboard')) {
        const k: Record<string, unknown> = { ...KPIS, inventoryValue: 0 };
        delete k.unitsInStock;
        return Promise.resolve({ data: { data: k } });
      }
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    expect(within(await tile('stock')).getByTestId('stat-badge').textContent).toBe('0');
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
