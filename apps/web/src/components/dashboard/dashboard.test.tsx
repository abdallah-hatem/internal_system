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

const KPIS = {
  totalRevenue: 1000, totalExpenses: 50, totalCogs: 400, totalCashOut: 600, totalCashIn: 700,
  cashOnHand: 100, netProfit: 550, activeCycles: 2, inventoryValue: 3000, receivables: 300,
  collected: 700, lowStockAlerts: 3, totalCustomers: 4, totalProducts: 5,
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

  it('thirteen tiles leave no lone tile: the last one takes the whole row, in two columns and in three', async () => {
    renderPage();
    const last = await tile('owedToLenders');
    expect(last.className.split(/\s+/)).toEqual(expect.arrayContaining(['col-span-2', 'lg:col-span-3']));
    expect((await tile('lowStockAlerts')).className).not.toMatch(/col-span/);
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
    for (const refused of ['/analytics/dashboard', '/analytics/top-products']) {
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
  it('a core partner sees all four, each opening the existing form', async () => {
    renderPage();
    await tile('revenue');
    expect(screen.getByTestId('quick-action-newSale').getAttribute('href')).toBe('/sales?new=1');
    expect(screen.getByTestId('quick-action-recordPayment').getAttribute('href')).toBe('/payments?new=1');
    expect(screen.getByTestId('quick-action-newCycle').getAttribute('href')).toBe('/cycles/new');
    expect(screen.getByTestId('quick-action-recordFuel').textContent).toContain('Fuel');
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
    await screen.findByTestId('your-cycles');
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


// ── Fuel, recorded from the dashboard (owner 2026-10-17) ─────────────
describe('the Fuel quick action', () => {
  const fuelButton = async () => {
    renderPage();
    await tile('revenue');
    return screen.getByTestId('quick-action-recordFuel');
  };
  const dialog = () => document.querySelector('[data-ledger-entry-dialog]');
  const amount = () => document.querySelector<HTMLInputElement>('#ledger-amount')!;
  const save = () => screen.getByRole('button', { name: en.common.save });

  it('opens the ledger form here, on Expense → Fuel, without leaving the dashboard', async () => {
    fireEvent.click(await fuelButton());
    expect(dialog()).toBeTruthy();
    expect(document.querySelector<HTMLInputElement>('input[type="hidden"][name="category"]')?.value).toBe('fuel');
    expect(screen.getByRole('radio', { name: new RegExp(en.ledger.kindExpense) }).getAttribute('aria-checked')).toBe('true');
    expect(amount().value).toBe('');
    expect(screen.getByTestId('tile-revenue')).toBeTruthy();
  });

  it('saves a fuel expense with no cycle, then closes', async () => {
    post.mockResolvedValue({ data: { data: { id: 'tx' } } });
    fireEvent.click(await fuelButton());
    fireEvent.focus(amount());
    fireEvent.change(amount(), { target: { value: '650' } });
    fireEvent.blur(amount());
    fireEvent.click(save());
    await waitFor(() => expect(dialog()).toBeNull());
    expect(post).toHaveBeenCalledTimes(1);
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'EXPENSE', direction: 'OUTFLOW', category: 'fuel', amount: 650 });
    expect(body).not.toHaveProperty('cycleId');
  });

  it('the second time opens a fresh form: Cancel leaves nothing behind', async () => {
    fireEvent.click(await fuelButton());
    fireEvent.focus(amount());
    fireEvent.change(amount(), { target: { value: '300' } });
    fireEvent.blur(amount());
    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }));
    expect(dialog()).toBeNull();
    fireEvent.click(screen.getByTestId('quick-action-recordFuel'));
    expect(amount().value).toBe('');
    expect(document.querySelector<HTMLInputElement>('input[type="hidden"][name="category"]')?.value).toBe('fuel');
    expect(post).not.toHaveBeenCalled();
  });

  it('with no amount, Save sends nothing and the form stays open', async () => {
    fireEvent.click(await fuelButton());
    fireEvent.click(save());
    expect(await screen.findByTestId('ledger-refusal')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
  });

  it('reads Fuel in Arabic', async () => {
    renderPage('ar');
    await tile('revenue');
    expect(screen.getByTestId('quick-action-recordFuel').textContent).toContain('بنزين');
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
    expect(icons.length).toBeGreaterThanOrEqual(13);
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

// Owner 2026-10-18: "maybe show some, then a see more?" — a phone shows six
// figures, the rest behind See more; a wider screen shows every tile.
describe('a phone shows six figures, then See more', () => {
  const FIRST = ['revenue', 'collected', 'receivables', 'netProfit', 'cashOnHand', 'inventoryValue'];
  const phoneHidden = (key: string) => screen.getByTestId(`tile-${key}`).className.split(/\s+/).includes('max-sm:hidden');

  it('the six show, the other seven wait — on a phone only', async () => {
    renderPage();
    await tile('revenue');
    for (const key of FIRST) expect(phoneHidden(key), key).toBe(false);
    for (const key of ['cogs', 'expenses', 'cashOut', 'activeCycles', 'unitsInStock', 'lowStockAlerts', 'owedToLenders']) {
      expect(phoneHidden(key), key).toBe(true);
    }
    const toggle = screen.getByTestId('tiles-toggle');
    expect(toggle.textContent).toContain('See more (7)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.className.split(/\s+/)).toContain('sm:hidden');
  });

  it('See more shows them all; See less folds them again', async () => {
    renderPage();
    await tile('revenue');
    fireEvent.click(screen.getByTestId('tiles-toggle'));
    expect(phoneHidden('cogs')).toBe(false);
    expect(phoneHidden('owedToLenders')).toBe(false);
    expect(screen.getByTestId('tiles-toggle').textContent).toContain('See less');
    expect(screen.getByTestId('tiles-toggle').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByTestId('tiles-toggle'));
    expect(phoneHidden('cogs')).toBe(true);
  });

  it('reads in Arabic', async () => {
    renderPage('ar');
    await tile('revenue');
    expect(screen.getByTestId('tiles-toggle').textContent).toContain('عرض المزيد (7)');
  });

  it('an investor, who has no business tiles, gets no toggle', async () => {
    auth.role = 'TEMP_INVESTOR';
    renderPage();
    await screen.findByTestId('your-cycles');
    expect(screen.queryByTestId('tiles-toggle')).toBeNull();
  });
});

// Owner 2026-10-18: "how is 21 sold on top of 28?" — the list is ranked by
// revenue but showed only units. Each row now shows its revenue first.
describe('top products show what they are ranked by', () => {
  it('revenue first and units under it, in the server\'s order, with "By revenue" in the heading', async () => {
    get.mockImplementation((url: string) => {
      if (url.startsWith('/analytics/dashboard')) return Promise.resolve({ data: { data: KPIS } });
      if (url.startsWith('/analytics/top-products')) {
        return Promise.resolve({
          data: {
            data: [
              { productId: 'p1', name: 'Y30 Headset', sku: 'PRD-000001', totalQuantitySold: 21, revenueEgp: 25200 },
              { productId: 'p4', name: 'Y20 FM', sku: 'PRD-000004', totalQuantitySold: 28, revenueEgp: 25000 },
            ],
          },
        });
      }
      if (url.startsWith('/customers/to-collect')) {
        return Promise.resolve({ data: { data: { totalOwed: '0.00', totalOverdue: '0.00', customers: 0, rows: [] } } });
      }
      return Promise.resolve({ data: { data: [] } });
    });
    renderPage();
    const revenues = await screen.findAllByTestId('top-product-revenue');
    expect(revenues.map((r) => r.textContent)).toEqual([expect.stringContaining('25,200.00'), expect.stringContaining('25,000.00')]);
    expect(screen.getAllByTestId('top-product-units').map((u) => u.textContent)).toEqual(['21 sold', '28 sold']);
    expect(screen.getByText('By revenue')).toBeTruthy();
  });
});
