import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import AnalyticsPage from '@/app/[locale]/analytics/page';
import {
  ProfitAndLossSection,
  niceScale,
  periodParams,
  type Granularity,
  type PnlBucket,
  type ProfitAndLoss,
  tooltipPlace,
} from './profit-and-loss-section';

/**
 * Profit and loss at the top of Analytics (owner 2026-10-18, "Option A";
 * BUSINESS_LOGIC §9). The figures are the API's; this lays them out — four
 * tiles, how they add up, one chart, the largest expenses — keeps the period
 * in the address and asks for the days it names.
 */

const nav = vi.hoisted(() => ({ query: '', push: vi.fn() }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => '/en/analytics',
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
}));

const get = vi.fn();
let reply: Promise<unknown> | (() => Promise<unknown>);
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, opts?: { params?: Record<string, string> }) => {
      get(url, opts?.params);
      // The rest of the Analytics page asks for lists; only the P&L is an object.
      if (!url.startsWith('/analytics/profit-and-loss')) return Promise.resolve({ data: { data: [] } });
      const r = typeof reply === 'function' ? reply() : reply;
      return r.then((data) => ({ data: { data } }));
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

const bucket = (key: string, from: string, to: string, salesEgp: number, netProfitEgp: number): PnlBucket => ({
  key,
  from,
  to,
  salesEgp,
  grossProfitEgp: Math.round(salesEgp * 0.38 * 100) / 100,
  expensesEgp: 0,
  netProfitEgp,
});

const PNL: ProfitAndLoss = {
  from: '2026-09-01',
  to: '2026-10-18',
  allTime: true,
  salesEgp: 1_342_567.89,
  cogsEgp: 832_000,
  grossProfitEgp: 510_567.89,
  grossProfitPctOfSales: 38,
  expensesEgp: 385_712.4,
  recoveredEgp: 400,
  otherIncomeEgp: 0,
  exchangeDifferenceEgp: 210,
  netProfitEgp: 125_045.49,
  netProfitPctOfSales: 9.3,
  cashOutEgp: 912_345.67,
  expensesByCategory: [
    { category: 'rent', amountEgp: 200_000 },
    { category: 'goods_lost', amountEgp: 100_000 },
    { category: 'fuel', amountEgp: 50_000 },
    { category: 'salaries', amountEgp: 30_000 },
    { category: 'bank_fees', amountEgp: 4_000.25 },
    { category: 'utilities', amountEgp: 1_712.15 },
  ],
  granularity: 'month',
  buckets: [
    bucket('2026-09', '2026-09-01', '2026-09-30', 1_234.56, -2_100.25),
    bucket('2026-10', '2026-10-01', '2026-10-18', 1_341_333.33, 127_145.74),
  ],
};

/** `n` buckets of a granularity, as the API cuts them (shape only; the figures are made up). */
function bucketsOf(granularity: Granularity, n: number): PnlBucket[] {
  return Array.from({ length: n }, (_, i) => {
    if (granularity === 'month') {
      const m = new Date(Date.UTC(2026, i, 1)).toISOString().slice(0, 10);
      return bucket(m.slice(0, 7), m, m, 1_000 * (i + 1), 100 * (i % 3) - 50);
    }
    const step = granularity === 'week' ? 7 : 1;
    const from = new Date(Date.UTC(2026, 7, 1) + i * step * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(2026, 7, 1) + (i * step + step - 1) * 86_400_000).toISOString().slice(0, 10);
    return bucket(from, from, to, 1_000 * (i + 1), 100 * (i % 3) - 50);
  });
}

function renderIn(locale: 'en' | 'ar' = 'en', what: 'section' | 'page' = 'section') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>{what === 'page' ? <AnalyticsPage /> : <ProfitAndLossSection />}</QueryClientProvider>
    </NextIntlClientProvider>
  );
  const view = render(tree());
  // A fresh element, as a navigation gives: the same one would let React skip the render.
  return { ...view, again: () => view.rerender(tree()) };
}

beforeEach(() => {
  nav.query = '';
  nav.push.mockReset();
  get.mockReset();
  reply = () => Promise.resolve(PNL);
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('periodParams — Cairo days', () => {
  it('this month, last month (across a new year), this year, all time, custom', () => {
    expect(periodParams('month', '2026-02-14', { from: '', to: '' })).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodParams('lastMonth', '2026-01-05', { from: '', to: '' })).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(periodParams('lastMonth', '2028-03-31', { from: '', to: '' })).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodParams('year', '2026-10-18', { from: '', to: '' })).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(periodParams('all', '2026-10-18', { from: '2026-01-01', to: '' })).toEqual({});
    expect(periodParams('custom', '2026-10-18', { from: '2026-03-04', to: '' })).toEqual({ from: '2026-03-04' });
  });
});

describe('niceScale — the chart’s pounds axis', () => {
  it('always takes in zero, ends on round ticks, and never divides by nothing', () => {
    expect(niceScale(0, 1_341_333)).toEqual({ min: 0, max: 1_500_000, ticks: [0, 500_000, 1_000_000, 1_500_000] });
    const loss = niceScale(-2_100, 9_000);
    expect(loss.min).toBeLessThan(0);
    expect(loss.ticks).toContain(0);
    expect(niceScale(0, 0)).toEqual({ min: 0, max: 1, ticks: [0] });
    expect(niceScale(-500, -100).max).toBe(0);
  });
});

describe('the tiles', () => {
  it('this month by default (owner 2026-10-19): asks for this month’s days; four tiles, compact, the exact amount on hover', async () => {
    renderIn();
    const net = await screen.findByTestId('pnl-net-value');
    expect(get).toHaveBeenCalledWith('/analytics/profit-and-loss', { from: '2026-10-01', to: '2026-10-31' });
    expect(get).not.toHaveBeenCalledWith('/analytics/profit-and-loss', {});
    const value = (id: string) => screen.getByTestId(`${id}-value`);
    expect(value('pnl-tile-sales').textContent).toBe('1.34MEGP');
    expect(value('pnl-tile-sales').getAttribute('title')).toBe('1,342,567.89 EGP');
    expect(value('pnl-tile-expenses').textContent).toBe('385.7KEGP');
    expect(value('pnl-tile-expenses').getAttribute('title')).toBe('385,712.40 EGP');
    expect(value('pnl-tile-gross').getAttribute('title')).toBe('510,567.89 EGP');
    expect(net.textContent).toBe('125KEGP');
    expect(net.getAttribute('title')).toBe('125,045.49 EGP');
    expect(net.className).toContain('text-success');
    expect(screen.getByTestId('pnl-pct').textContent).toBe('9.3% of sales');
    expect(screen.getByTestId('pnl-gross-pct').textContent).toBe('38.0% of sales');
    expect(screen.getByTestId('pnl-tile-sales').textContent).toContain('Cost of goods 832K');
    expect(screen.getByTestId('pnl-tile-expenses').textContent).toContain('6 categories');
    expect(screen.getByTestId('pnl-range').textContent).toBe('Sep 1, 2026 – today');
    expect(within(screen.getByTestId('pnl-period')).getByRole('button', { name: 'This month' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(screen.getByTestId('pnl-period')).getByRole('button', { name: 'All time' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('no sales: both shares of sales are a dash, never NaN% or Infinity%', async () => {
    reply = () =>
      Promise.resolve({
        ...PNL,
        salesEgp: 0,
        cogsEgp: 0,
        grossProfitEgp: 0,
        grossProfitPctOfSales: null,
        netProfitEgp: -500,
        netProfitPctOfSales: null,
      });
    renderIn();
    expect((await screen.findByTestId('pnl-pct')).textContent).toBe('— of sales');
    expect(screen.getByTestId('pnl-gross-pct').textContent).toBe('— of sales');
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('a loss: net profit in the destructive colour, with the falling arrow — never green', async () => {
    reply = () => Promise.resolve({ ...PNL, netProfitEgp: -1234.5, netProfitPctOfSales: -6.2 });
    renderIn();
    const net = await screen.findByTestId('pnl-net-value');
    expect(net.className).toContain('text-destructive');
    expect(net.className).not.toContain('text-success');
    expect(net.textContent).toBe('-1.2KEGP');
    expect(net.getAttribute('title')).toBe('-1,234.50 EGP');
    expect(screen.getByTestId('pnl-pct').textContent).toBe('-6.2% of sales');
  });

  it('a loss in Arabic keeps its minus inside the digits’ LTR run, so it cannot drift to the far side', async () => {
    reply = () => Promise.resolve({ ...PNL, netProfitEgp: -1234.5, netProfitPctOfSales: -6.2 });
    renderIn('ar');
    const net = await screen.findByTestId('pnl-net-value');
    expect(net.querySelector('bdi[dir="ltr"]')!.textContent).toBe('-1.2');
    expect(net.textContent).toContain('ألف');
    expect(net.className).toContain('text-destructive');
  });

  it('how it adds up: sales, COGS, gross, expenses, the non-zero extras only, net — to the piastre', async () => {
    renderIn();
    // Folded away at first: the tiles are the summary, the list is on request.
    const open = await screen.findByRole('button', { name: 'How it adds up' });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(open.getAttribute('type')).toBe('button');
    expect(screen.queryByTestId('pnl-summary')).toBeNull();
    fireEvent.click(open);
    expect(open.getAttribute('aria-expanded')).toBe('true');
    const summary = screen.getByTestId('pnl-summary');
    const lines = [...summary.querySelectorAll('[data-line]')].map((l) => l.getAttribute('data-line'));
    // Other income is zero, so it is not shown; recovered and exchange are.
    expect(lines).toEqual(['sales', 'cogs', 'gross', 'expenses', 'recovered', 'exchange', 'net']);
    const line = (k: string) => summary.querySelector(`[data-line="${k}"]`)!.textContent;
    expect(line('sales')).toContain('1,342,567.89');
    expect(line('cogs')).toContain('832,000.00');
    expect(line('gross')).toContain('510,567.89');
    expect(line('expenses')).toContain('385,712.40');
    expect(line('recovered')).toContain('400.00');
    expect(line('exchange')).toContain('210.00');
    expect(line('net')).toContain('125,045.49');
  });

  // Owner 2026-10-23: Cash paid out left the dashboard; it lives here, for the period.
  it('cash paid out for the period sits under the account, apart from it — not one of its lines', async () => {
    renderIn();
    fireEvent.click(await screen.findByRole('button', { name: 'How it adds up' }));
    const cash = screen.getByTestId('pnl-cash-out');
    expect(cash.textContent).toContain('Cash paid out');
    expect(cash.textContent).toContain('912,345.67');
    expect(cash.textContent).toContain('Not a cost');
    // Outside the arithmetic: no sign, no data-line.
    expect(screen.getByTestId('pnl-summary').contains(cash)).toBe(false);
    expect(cash.querySelector('[data-line]')).toBeNull();
  });

  it('cash paid out in Arabic', async () => {
    renderIn('ar');
    fireEvent.click(await screen.findByRole('button', { name: ar.analytics.pnl.howItAddsUp }));
    expect(screen.getByTestId('pnl-cash-out').textContent).toContain(ar.analytics.pnl.cashOut);
  });

  it('an older API with no cash figure shows no line rather than a zero', async () => {
    const { cashOutEgp: _c, ...old } = PNL;
    void _c;
    reply = () => Promise.resolve(old);
    renderIn();
    fireEvent.click(await screen.findByRole('button', { name: 'How it adds up' }));
    expect(screen.queryByTestId('pnl-cash-out')).toBeNull();
  });
});

describe('the chart', () => {
  it.each([
    ['day', 18, 'by day'],
    ['week', 9, 'by week, Saturday to Friday'],
    ['month', 10, 'by month'],
  ] as const)('one column, one point and one hit target per %s bucket', async (granularity, n, says) => {
    reply = () => Promise.resolve({ ...PNL, granularity, buckets: bucketsOf(granularity, n) });
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    expect(chart.getAttribute('data-granularity')).toBe(granularity);
    expect(chart.querySelectorAll('[data-bucket]')).toHaveLength(n);
    expect(chart.querySelectorAll('[data-bar]')).toHaveLength(n);
    expect(chart.querySelectorAll('[data-point]')).toHaveLength(n);
    expect(screen.getByTestId('pnl-line').getAttribute('points')!.split(' ')).toHaveLength(n);
    expect(chart.textContent).toContain(says);
    // A legend names both series and what a red point means.
    expect(within(screen.getByTestId('pnl-legend')).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Sales',
      'Net profit',
      'Loss',
    ]);
  });

  it('a loss bucket’s point is red; a profit bucket’s is not', async () => {
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    const sep = chart.querySelector('[data-point="2026-09"]')!;
    const oct = chart.querySelector('[data-point="2026-10"]')!;
    expect(sep.getAttribute('data-loss')).toBe('true');
    expect(sep.className).toContain('bg-destructive');
    expect(oct.getAttribute('data-loss')).toBeNull();
    expect(oct.className).not.toContain('bg-destructive');
  });

  it('hovering a bucket shows its exact sales, gross and net profit; leaving hides it; a key does the same', async () => {
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    expect(screen.queryByTestId('pnl-tooltip')).toBeNull();
    fireEvent.pointerEnter(chart.querySelector('[data-bucket="2026-09"]')!);
    const tip = screen.getByTestId('pnl-tooltip');
    expect(tip.textContent).toContain('September 2026');
    expect(screen.getByTestId('pnl-tooltip-sales').textContent).toBe('1,234.56 EGP');
    expect(screen.getByTestId('pnl-tooltip-gross').textContent).toBe('469.13 EGP');
    expect(screen.getByTestId('pnl-tooltip-net').textContent).toBe('-2,100.25 EGP');
    expect(screen.getByTestId('pnl-tooltip-net').className).toContain('text-destructive');
    expect(tip.textContent).toContain('Net profit · Loss');

    fireEvent.pointerLeave(chart.querySelector('[data-bucket]')!.parentElement!.parentElement!);
    expect(screen.queryByTestId('pnl-tooltip')).toBeNull();

    // The keyboard reaches the same figures.
    fireEvent.focus(chart.querySelector('[data-bucket="2026-10"]')!);
    expect(screen.getByTestId('pnl-tooltip-sales').textContent).toBe('1,341,333.33 EGP');
    expect(screen.getByTestId('pnl-tooltip-net').textContent).toBe('127,145.74 EGP');
  });

  it('a week’s tooltip names its days, Saturday to Friday', async () => {
    reply = () =>
      Promise.resolve({
        ...PNL,
        granularity: 'week',
        buckets: [
          bucket('2026-08-01', '2026-08-04', '2026-08-07', 10, 5),
          bucket('2026-08-08', '2026-08-08', '2026-08-14', 20, 5),
        ],
      });
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    fireEvent.pointerEnter(chart.querySelector('[data-bucket="2026-08-08"]')!);
    expect(screen.getByTestId('pnl-tooltip').textContent).toContain('Aug 8 – Aug 14, 2026');
  });

  it('nothing recorded yet: a note in place of an empty frame', async () => {
    reply = () => Promise.resolve({ ...PNL, from: null, buckets: [] });
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    expect(chart.textContent).toContain(en.analytics.pnl.noMonths);
    expect(chart.querySelectorAll('[data-bucket]')).toHaveLength(0);
  });
});

describe('the expenses', () => {
  it('the largest four, by name, then one line folding the rest with its total; it opens in place and closes again', async () => {
    renderIn();
    const names = () =>
      within(screen.getByTestId('pnl-categories'))
        .getAllByRole('listitem')
        .map((li) => li.querySelector('bdi')!.textContent);
    await screen.findByTestId('pnl-categories');
    expect(names()).toEqual([
      en.codes.ledgerCategory.rent,
      en.analytics.pnl.goodsLost,
      en.codes.ledgerCategory.fuel,
      en.codes.ledgerCategory.salaries,
    ]);
    const more = screen.getByTestId('pnl-more');
    // 4,000.25 + 1,712.15, added in piastres: no 5,712.400000001.
    expect(more.textContent).toBe('2 more categories·5,712.40 EGP');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.getAttribute('type')).toBe('button');

    fireEvent.click(more);
    expect(names()).toHaveLength(6);
    expect(names().slice(4)).toEqual([en.codes.ledgerCategory.bank_fees, en.codes.ledgerCategory.utilities]);
    expect(more.textContent).toBe('Show fewer');
    expect(more.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(more);
    expect(names()).toHaveLength(4);
  });

  it('four or fewer: no fold line at all', async () => {
    reply = () => Promise.resolve({ ...PNL, expensesByCategory: PNL.expensesByCategory.slice(0, 4) });
    renderIn();
    await screen.findByTestId('pnl-categories');
    expect(screen.queryByTestId('pnl-more')).toBeNull();
  });
});

describe('the section in its place', () => {
  it('choosing All time writes it to the address, and the address is what is asked for', async () => {
    const { again } = renderIn();
    await screen.findByTestId('pnl-net');
    fireEvent.click(within(screen.getByTestId('pnl-period')).getByRole('button', { name: 'All time' }));
    expect(nav.push).toHaveBeenCalledWith('/en/analytics?period=all', { scroll: false });

    // The router changed the address: the section reads it back.
    nav.query = 'period=all';
    again();
    await vi.waitFor(() => expect(get).toHaveBeenLastCalledWith('/analytics/profit-and-loss', {}));
    expect(within(screen.getByTestId('pnl-period')).getByRole('button', { name: 'All time' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('back to This month drops the period from the address; Custom starts on this month so far', async () => {
    nav.query = 'period=year';
    renderIn();
    await screen.findByTestId('pnl-net');
    expect(get).toHaveBeenCalledWith('/analytics/profit-and-loss', { from: '2026-01-01', to: '2026-12-31' });
    fireEvent.click(screen.getByRole('button', { name: 'This month' }));
    expect(nav.push).toHaveBeenLastCalledWith('/en/analytics', { scroll: false });
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(nav.push).toHaveBeenLastCalledWith('/en/analytics?period=custom&from=2026-10-01&to=2026-10-18', { scroll: false });
  });

  it('a custom range from the address: asks for its days and shows the two date pickers', async () => {
    nav.query = 'period=custom&from=2026-03-01&to=2026-04-15';
    renderIn();
    await screen.findByTestId('pnl-net');
    expect(get).toHaveBeenCalledWith('/analytics/profit-and-loss', { from: '2026-03-01', to: '2026-04-15' });
    expect(screen.getByTestId('pnl-date-range')).toBeTruthy();
  });

  it('days in the address with no period (a link someone kept) are a custom range, not all time', async () => {
    nav.query = 'from=2026-05-01&to=2026-05-31';
    renderIn();
    await screen.findByTestId('pnl-net');
    expect(get).toHaveBeenCalledWith('/analytics/profit-and-loss', { from: '2026-05-01', to: '2026-05-31' });
    expect(screen.getByRole('button', { name: 'Custom' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('an unknown period in the address is the default, this month', async () => {
    nav.query = 'period=fortnight';
    renderIn();
    await screen.findByTestId('pnl-net');
    expect(get).toHaveBeenCalledWith('/analytics/profit-and-loss', { from: '2026-10-01', to: '2026-10-31' });
  });

  it('while it loads: a skeleton in the new shape — four tiles, the chart, the expense rows — and no spinner', async () => {
    reply = () => new Promise(() => {});
    renderIn();
    const skeleton = await screen.findByTestId('pnl-skeleton');
    expect(skeleton.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton.children).toHaveLength(4);
    expect(skeleton.children[0].children).toHaveLength(4);
    expect(document.querySelector('.animate-spin')).toBeNull();
    expect(screen.queryByTestId('pnl-net')).toBeNull();
  });

  it('the Analytics page no longer has a Revenue by month card, nor asks for it; Top products and cycles stay', async () => {
    renderIn('en', 'page');
    await screen.findByTestId('pnl-chart');
    expect(document.body.textContent).not.toMatch(/Revenue by month/i);
    expect(get.mock.calls.some(([url]) => String(url).includes('revenue-by-month'))).toBe(false);
    expect(screen.getByText(en.analytics.topProducts)).toBeTruthy();
    expect(screen.getByText(en.analytics.cycleProfitability)).toBeTruthy();
  });

  it('in Arabic: Arabic words, Latin digits, and time running right to left as the old chart did', async () => {
    renderIn('ar');
    const chart = await screen.findByTestId('pnl-chart');
    expect(screen.getByText(ar.analytics.pnl.title)).toBeTruthy();
    expect(chart.textContent).toContain(ar.analytics.pnl.chartTitle);
    expect(chart.textContent).toContain(ar.analytics.pnl.by.month);
    fireEvent.click(screen.getByRole('button', { name: ar.analytics.pnl.howItAddsUp }));
    expect(screen.getByTestId('pnl-summary').textContent).toContain(ar.analytics.pnl.grossProfit);
    expect(screen.getByRole('button', { name: ar.analytics.pnl.periods.all })).toBeTruthy();
    expect(screen.getByTestId('pnl-pct').textContent).toBe('9.3% من المبيعات');
    // Intl puts a no-break space before the word.
    expect(screen.getByTestId('pnl-tile-sales-value').textContent).toMatch(/^1\.34\sمليونEGP$/);
    // The digits are their own LTR run and the word sits outside it, so a
    // right-to-left reader meets "1.34" first, then "مليون".
    expect(screen.getByTestId('pnl-tile-sales-value').querySelector('bdi[dir="ltr"]')!.textContent).toBe('1.34');
    expect(screen.getByTestId('pnl-net-value').getAttribute('title')).toBe('125,045.49 EGP');
    expect(within(screen.getByTestId('pnl-categories')).getByText(ar.codes.ledgerCategory.rent)).toBeTruthy();
    expect(screen.getByTestId('pnl-more').textContent).toContain('فئتان أخريان');

    // September (the older) sits to the right of October.
    const left = (key: string) => parseFloat((chart.querySelector(`[data-point="${key}"]`) as HTMLElement).style.left);
    expect(left('2026-09')).toBeGreaterThan(left('2026-10'));

    fireEvent.pointerEnter(chart.querySelector('[data-bucket="2026-09"]')!);
    const tip = screen.getByTestId('pnl-tooltip');
    expect(tip.textContent).toContain('سبتمبر 2026');
    expect(tip.textContent).toContain(ar.analytics.pnl.loss);
    expect(screen.getByTestId('pnl-tooltip-net').textContent).toBe('-2,100.25 EGP');
  });

  it('in English the older bucket is on the left', async () => {
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    const left = (key: string) => parseFloat((chart.querySelector(`[data-point="${key}"]`) as HTMLElement).style.left);
    expect(left('2026-09')).toBeLessThan(left('2026-10'));
  });
});

/**
 * A phone-width screen, switchable mid-test as a rotation is: `matchMedia`
 * answers the app's phone query (below Tailwind's `sm`, 640px) from `width`,
 * and `resize(w)` tells every listener, as the browser does.
 */
const screenWidth = { width: 1440, listeners: new Set<() => void>() };
function installMatchMedia() {
  window.matchMedia = ((query: string) => {
    const max = Number(/max-width:\s*([\d.]+)px/.exec(query)?.[1] ?? Infinity);
    return {
      get matches() {
        return screenWidth.width <= max;
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => screenWidth.listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => screenWidth.listeners.delete(fn),
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}
function resize(width: number) {
  screenWidth.width = width;
  act(() => screenWidth.listeners.forEach((fn) => fn()));
}

/** This month to today (Sun Oct 18, 2026) by day, as the API sends it: every day, quiet ones too. */
function octoberDays(): PnlBucket[] {
  return Array.from({ length: 18 }, (_, i) => {
    const d = `2026-10-${String(i + 1).padStart(2, '0')}`;
    // Cents everywhere, a loss on the 4th and the 12th, nothing on the 7th.
    const sales = i === 6 ? 0 : 1_000 + i * 100.15;
    const net = i === 3 ? -2_500.5 : i === 11 ? -0.05 : i === 6 ? 0 : 150.1 + i;
    return { key: d, from: d, to: d, salesEgp: sales, grossProfitEgp: Math.round(sales * 38) / 100, expensesEgp: 10.01 * i, netProfitEgp: net };
  });
}
const DAY_PNL = (): ProfitAndLoss => ({ ...PNL, from: '2026-10-01', to: '2026-10-18', granularity: 'day', buckets: octoberDays() });

describe('the chart on a phone: a by-day period is drawn by week (owner 2026-10-19, Option 1)', () => {
  const realMatchMedia = window.matchMedia;
  beforeEach(() => {
    screenWidth.listeners.clear();
    screenWidth.width = 390;
    installMatchMedia();
    nav.query = 'period=month';
    reply = () => Promise.resolve(DAY_PNL());
  });
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  const axisSpans = (chart: HTMLElement) => [...chart.querySelectorAll('[data-axis-label]')];
  const axis = (chart: HTMLElement) => axisSpans(chart).map((s) => s.textContent);

  it('at 390px: four Saturday–Friday weeks cut to the month and today, a point each, short labels, "by week"', async () => {
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    expect(chart.getAttribute('data-folded')).toBe('week');
    expect(chart.getAttribute('data-granularity')).toBe('week');
    expect([...chart.querySelectorAll('[data-bucket]')].map((b) => b.getAttribute('data-bucket'))).toEqual([
      '2026-09-26', // Thu–Fri Oct 1–2, cut at the month's start
      '2026-10-03',
      '2026-10-10',
      '2026-10-17', // Sat–Sun Oct 17–18, cut at today
    ]);
    expect(chart.querySelectorAll('[data-bar]')).toHaveLength(4);
    expect(chart.querySelectorAll('[data-point]')).toHaveLength(4);
    expect(screen.getByTestId('pnl-line').getAttribute('points')!.split(' ')).toHaveLength(4);
    expect(axis(chart)).toEqual(['Oct 1', 'Oct 3', 'Oct 10', 'today']);
    // Every label is shown on a phone: none hidden below sm.
    expect(axisSpans(chart).every((s) => s.classList.contains('block'))).toBe(true);
    expect(chart.querySelector('h3')!.textContent).toBe('Sales and net profit · by week');
    // The week of the 4th lost money overall: its point is red.
    expect(chart.querySelector('[data-point="2026-10-03"]')!.getAttribute('data-loss')).toBe('true');
    expect(chart.querySelector('[data-point="2026-10-10"]')!.getAttribute('data-loss')).toBeNull();
  });

  it('a week’s column says its exact totals — the sum of its days, to the piastre', async () => {
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    // Oct 3–9 (i = 2..8): sales 1000 + i * 100.15, the 7th (i = 6) quiet.
    const sales = [2, 3, 4, 5, 7, 8].reduce((s, i) => s + Math.round((1_000 + i * 100.15) * 100), 0) / 100;
    const net = [2, 4, 5, 7, 8].reduce((s, i) => s + Math.round((150.1 + i) * 100), 0) / 100 - 2_500.5;
    expect(sales).toBe(8_904.35);
    expect(Math.round(net * 100) / 100).toBe(-1_724);
    expect(chart.querySelector('[data-bucket="2026-10-03"]')!.getAttribute('aria-label')).toBe(
      'Oct 3 – Oct 9, 2026: Sales 8,904.35 EGP, Net profit -1,724.00 EGP',
    );
  });

  it('tapping a week opens its own days: sales and net profit each, losses red, the week’s total under them', async () => {
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    expect(screen.queryByTestId('pnl-week')).toBeNull();
    fireEvent.pointerDown(chart.querySelector('[data-bucket="2026-10-03"]')!);
    fireEvent.click(chart.querySelector('[data-bucket="2026-10-03"]')!);
    const week = screen.getByTestId('pnl-week');
    expect(week.getAttribute('role')).toBe('dialog');
    expect(within(week).getByRole('heading').textContent).toBe('Oct 3 – Oct 9, 2026');
    const days = [...within(week).getByTestId('pnl-week-days').querySelectorAll('li')];
    expect(days.map((d) => d.getAttribute('data-day'))).toEqual([
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ]);
    const cell = (d: Element, id: string) => d.querySelector(`[data-testid="${id}"]`)!;
    expect(days[0].textContent).toContain('Sat, Oct 3');
    expect(days[6].textContent).toContain('Fri, Oct 9');
    expect(cell(days[0], 'pnl-day-sales').textContent).toBe('1,200.30');
    expect(cell(days[1], 'pnl-day-net').textContent).toBe('-2,500.50');
    expect(cell(days[1], 'pnl-day-net').className).toContain('text-destructive');
    expect(days[1].getAttribute('data-loss')).toBe('true');
    expect(cell(days[0], 'pnl-day-net').className).toContain('text-success');
    // The quiet day is there, at zero, not missing.
    expect(cell(days[4], 'pnl-day-sales').textContent).toBe('0.00');
    // The total is the days added up, and equals the column's.
    expect(within(week).getByTestId('pnl-week-sales').textContent).toBe('8,904.35');
    expect(within(week).getByTestId('pnl-week-net').textContent).toBe('-1,724.00');
    expect(within(week).getByTestId('pnl-week-net').className).toContain('text-destructive');
    // No tooltip over the dialog: the tap answered with the days.
    expect(screen.queryByTestId('pnl-tooltip')).toBeNull();

    // Closed, and opened again on another week: that week's days, not the last ones.
    fireEvent.click(within(week).getByRole('button', { name: en.common.close }));
    expect(screen.queryByTestId('pnl-week')).toBeNull();
    fireEvent.click(chart.querySelector('[data-bucket="2026-10-17"]')!);
    const last = screen.getByTestId('pnl-week');
    expect([...last.querySelectorAll('li')].map((d) => d.getAttribute('data-day'))).toEqual(['2026-10-17', '2026-10-18']);
    // Today is named as today.
    expect(last.querySelectorAll('li')[1].textContent).toContain('today');
  });

  it('the first, cut week opens only the days inside the period', async () => {
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    fireEvent.click(chart.querySelector('[data-bucket="2026-09-26"]')!);
    const week = screen.getByTestId('pnl-week');
    expect(within(week).getByRole('heading').textContent).toBe('Oct 1 – Oct 2, 2026');
    expect([...week.querySelectorAll('li')].map((d) => d.getAttribute('data-day'))).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('at 1440px the same period keeps its 18 day columns, its tooltip and "by day"; a tap opens nothing', async () => {
    screenWidth.width = 1440;
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    expect(chart.getAttribute('data-folded')).toBeNull();
    expect(chart.getAttribute('data-granularity')).toBe('day');
    expect(chart.querySelectorAll('[data-bucket]')).toHaveLength(18);
    expect(chart.querySelector('h3')!.textContent).toBe('Sales and net profit · by day');
    expect(axis(chart)[17]).toBe('Oct 18');
    fireEvent.pointerDown(chart.querySelector('[data-bucket="2026-10-04"]')!);
    fireEvent.click(chart.querySelector('[data-bucket="2026-10-04"]')!);
    expect(screen.getByTestId('pnl-tooltip-net').textContent).toBe('-2,500.50 EGP');
    expect(screen.queryByTestId('pnl-week')).toBeNull();
  });

  it('640px is already the wide layout; 639px is a phone', async () => {
    screenWidth.width = 640;
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    expect(chart.querySelectorAll('[data-bucket]')).toHaveLength(18);
    resize(639);
    expect(chart.querySelectorAll('[data-bucket]')).toHaveLength(4);
  });

  it('rotating or resizing switches between weeks and days without asking the API again, and closes an open week', async () => {
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    const asked = () => get.mock.calls.filter(([url]) => url === '/analytics/profit-and-loss').length;
    const before = asked();
    expect(chart.querySelectorAll('[data-bucket]')).toHaveLength(4);
    fireEvent.click(chart.querySelector('[data-bucket="2026-10-10"]')!);
    expect(screen.getByTestId('pnl-week')).toBeTruthy();

    resize(900);
    expect(chart.querySelectorAll('[data-bucket]')).toHaveLength(18);
    expect(screen.queryByTestId('pnl-week')).toBeNull();
    resize(390);
    expect(chart.querySelectorAll('[data-bucket]')).toHaveLength(4);
    // The week left open before the rotation does not spring back.
    expect(screen.queryByTestId('pnl-week')).toBeNull();
    expect(asked()).toBe(before);
  });

  it.each([
    ['week', 9, 'by week, Saturday to Friday'],
    ['month', 10, 'by month'],
  ] as const)('a period the API draws by %s is the same on a phone: its own buckets, nothing to open', async (granularity, n, says) => {
    reply = () => Promise.resolve({ ...PNL, granularity, buckets: bucketsOf(granularity, n) });
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    expect(chart.getAttribute('data-folded')).toBeNull();
    expect(chart.getAttribute('data-granularity')).toBe(granularity);
    expect(chart.querySelectorAll('[data-bucket]')).toHaveLength(n);
    expect(chart.textContent).toContain(says);
    fireEvent.click(chart.querySelector('[data-bucket]')!);
    expect(screen.queryByTestId('pnl-week')).toBeNull();
  });

  it('in Arabic: the weeks run right to left, the subtitle and the opened days are Arabic, minus signs kept', async () => {
    renderIn('ar');
    const chart = await screen.findByTestId('pnl-chart');
    expect(chart.querySelectorAll('[data-bucket]')).toHaveLength(4);
    expect(chart.querySelector('h3')!.textContent).toBe(`${ar.analytics.pnl.chartTitle} · ${ar.analytics.pnl.byWeekShort}`);
    const left = (key: string) => parseFloat((chart.querySelector(`[data-point="${key}"]`) as HTMLElement).style.left);
    // The older week sits to the right.
    expect(left('2026-09-26')).toBeGreaterThan(left('2026-10-03'));
    expect(left('2026-10-03')).toBeGreaterThan(left('2026-10-17'));
    expect(axis(chart)[3]).toBe(ar.analytics.pnl.today);

    fireEvent.click(chart.querySelector('[data-bucket="2026-10-03"]')!);
    const week = screen.getByTestId('pnl-week');
    expect(week.textContent).toContain(ar.analytics.pnl.weekTotal);
    expect(week.textContent).toContain(ar.analytics.pnl.netProfit);
    const net = week.querySelectorAll('li')[1].querySelector('[data-testid="pnl-day-net"]')!;
    expect(net.textContent).toBe('-2,500.50');
    // The minus stays with the digits: they are one LTR run inside the cell.
    expect(net.querySelector('bdi[dir="ltr"]')!.textContent).toBe('-2,500.50');
    expect(week.querySelectorAll('li')[0].textContent).toContain('السبت');
  });
});

describe('tooltipPlace — the tooltip never leaves the plot', () => {
  it('one bucket fills the plot: held to its right edge, not past it (All time with a single day)', () => {
    expect(tooltipPlace(50, 1)).toEqual({ right: '0px' });
  });
  it('the last of a few buckets: held to the left edge when there is no room on its left', () => {
    // Two buckets: the right one's centre is 75%, beside it on the left is 50% — room enough.
    expect(tooltipPlace(75, 2)).toEqual({ right: 'calc(50% + 4px)' });
    expect(tooltipPlace(25, 2)).toEqual({ left: 'calc(50% + 4px)' });
  });
  it('many buckets: beside the hovered one, as before', () => {
    expect(tooltipPlace(5, 10)).toEqual({ left: 'calc(10% + 4px)' });
    expect(tooltipPlace(95, 10)).toEqual({ right: 'calc(10% + 4px)' });
  });
});
