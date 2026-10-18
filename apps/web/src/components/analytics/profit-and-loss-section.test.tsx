import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { ProfitAndLossSection, periodParams, type ProfitAndLoss } from './profit-and-loss-section';

/**
 * Profit and loss at the top of Analytics (owner 2026-10-18; BUSINESS_LOGIC
 * §9). The figures are the API's; this lays them out, keeps the period in the
 * address and asks for the days it names.
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

const PNL: ProfitAndLoss = {
  from: '2026-09-01',
  to: '2026-10-18',
  allTime: true,
  salesEgp: 20000,
  cogsEgp: 12400,
  grossProfitEgp: 7600,
  expensesEgp: 4285.75,
  recoveredEgp: 400,
  otherIncomeEgp: 0,
  exchangeDifferenceEgp: 210,
  netProfitEgp: 3504.25,
  netProfitPctOfSales: 17.5,
  expensesByCategory: [
    { category: 'rent', amountEgp: 3000 },
    { category: 'goods_lost', amountEgp: 700 },
    { category: 'fuel', amountEgp: 585.75 },
  ],
  months: [
    { month: '2026-09', netProfitEgp: -2100.25 },
    { month: '2026-10', netProfitEgp: 5604.5 },
  ],
};

function renderIn(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ProfitAndLossSection />
      </QueryClientProvider>
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

describe('the Profit and loss section', () => {
  it('all time by default: asks for no days, shows net profit, its share of sales and the range', async () => {
    renderIn();
    const net = await screen.findByTestId('pnl-net');
    expect(get).toHaveBeenCalledWith('/analytics/profit-and-loss', {});
    expect(net.textContent).toContain('3,504.25');
    expect(net.className).toContain('text-success');
    expect(screen.getByTestId('pnl-pct').textContent).toBe('17.5% of sales');
    expect(screen.getByTestId('pnl-range').textContent).toBe('Sep 1, 2026 – today');
    expect(within(screen.getByTestId('pnl-period')).getByRole('button', { name: 'All time' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('the summary: sales, COGS, gross, expenses, the non-zero extras only, net', async () => {
    renderIn();
    const summary = await screen.findByTestId('pnl-summary');
    const lines = [...summary.querySelectorAll('[data-line]')].map((l) => l.getAttribute('data-line'));
    // Other income is zero, so it is not shown; recovered and exchange are.
    expect(lines).toEqual(['sales', 'cogs', 'gross', 'expenses', 'recovered', 'exchange', 'net']);
    const line = (k: string) => summary.querySelector(`[data-line="${k}"]`)!.textContent;
    expect(line('sales')).toContain('Sales');
    expect(line('sales')).toContain('20,000.00');
    expect(line('cogs')).toContain('12,400.00');
    expect(line('gross')).toContain('7,600.00');
    expect(line('expenses')).toContain('4,285.75');
    expect(line('exchange')).toContain('210.00');
    expect(line('net')).toContain('3,504.25');
  });

  it('expenses by category with the ledger’s names, goods lost named; a bar per month, a loss drawn as one', async () => {
    renderIn();
    const cats = within(await screen.findByTestId('pnl-categories'));
    expect(cats.getAllByRole('listitem').map((li) => li.querySelector('bdi')!.textContent)).toEqual([
      en.codes.ledgerCategory.rent,
      en.analytics.pnl.goodsLost,
      en.codes.ledgerCategory.fuel,
    ]);
    const months = screen.getByTestId('pnl-months');
    const sep = months.querySelector('[data-month="2026-09"]')!;
    expect(sep.textContent).toContain('Sep 2026');
    expect(sep.textContent).toContain('-2,100.25');
    expect(sep.querySelector('[data-bar="loss"]')).toBeTruthy();
    expect(sep.querySelector('[data-bar="profit"]')).toBeNull();
    expect(sep.querySelector('[data-slot="money"]')!.className).toContain('text-destructive');
    const oct = months.querySelector('[data-month="2026-10"]')!;
    expect(oct.querySelector('[data-bar="profit"]')).toBeTruthy();
    // The largest month fills its half; the other is in proportion.
    expect((oct.querySelector('[data-bar="profit"]') as HTMLElement).style.width).toBe('100%');
  });

  it('choosing This month writes it to the address, and the address is what is asked for', async () => {
    const { again } = renderIn();
    await screen.findByTestId('pnl-net');
    fireEvent.click(within(screen.getByTestId('pnl-period')).getByRole('button', { name: 'This month' }));
    expect(nav.push).toHaveBeenCalledWith('/en/analytics?period=month', { scroll: false });

    // The router changed the address: the section reads it back.
    nav.query = 'period=month';
    again();
    await vi.waitFor(() =>
      expect(get).toHaveBeenLastCalledWith('/analytics/profit-and-loss', { from: '2026-10-01', to: '2026-10-31' }),
    );
    expect(within(screen.getByTestId('pnl-period')).getByRole('button', { name: 'This month' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('back to All time drops the period from the address; Custom starts on this month so far', async () => {
    nav.query = 'period=year';
    renderIn();
    await screen.findByTestId('pnl-net');
    expect(get).toHaveBeenCalledWith('/analytics/profit-and-loss', { from: '2026-01-01', to: '2026-12-31' });
    fireEvent.click(screen.getByRole('button', { name: 'All time' }));
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

  it('an unknown period in the address is all time', async () => {
    nav.query = 'period=fortnight';
    renderIn();
    await screen.findByTestId('pnl-net');
    expect(get).toHaveBeenCalledWith('/analytics/profit-and-loss', {});
  });

  it('no sales: the share of sales is a dash, never NaN% or Infinity%', async () => {
    reply = () =>
      Promise.resolve({ ...PNL, salesEgp: 0, cogsEgp: 0, grossProfitEgp: 0, netProfitEgp: -500, netProfitPctOfSales: null });
    renderIn();
    expect((await screen.findByTestId('pnl-pct')).textContent).toBe('— of sales');
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('a loss: the headline in the destructive colour', async () => {
    reply = () => Promise.resolve({ ...PNL, netProfitEgp: -1234.5, netProfitPctOfSales: -6.2 });
    renderIn();
    const net = await screen.findByTestId('pnl-net');
    expect(net.className).toContain('text-destructive');
    expect(net.className).not.toContain('text-success');
    expect(net.textContent).toContain('-1,234.50');
  });

  it('while it loads: a skeleton in the section’s shape, no spinner', async () => {
    reply = () => new Promise(() => {});
    renderIn();
    const skeleton = await screen.findByTestId('pnl-skeleton');
    expect(skeleton.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.animate-spin')).toBeNull();
    expect(screen.queryByTestId('pnl-net')).toBeNull();
  });

  it('in Arabic: the labels are Arabic, digits Latin', async () => {
    renderIn('ar');
    const summary = await screen.findByTestId('pnl-summary');
    expect(screen.getByText(ar.analytics.pnl.title)).toBeTruthy();
    expect(summary.textContent).toContain(ar.analytics.pnl.sales);
    expect(summary.textContent).toContain(ar.analytics.pnl.grossProfit);
    expect(screen.getByRole('button', { name: ar.analytics.pnl.periods.all })).toBeTruthy();
    expect(screen.getByTestId('pnl-pct').textContent).toBe('17.5% من المبيعات');
    expect(screen.getByTestId('pnl-net').textContent).toContain('3,504.25');
    expect(within(screen.getByTestId('pnl-categories')).getByText(ar.codes.ledgerCategory.rent)).toBeTruthy();
  });
});
