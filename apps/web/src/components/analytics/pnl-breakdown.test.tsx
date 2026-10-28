import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { ProfitAndLossSection, type PnlBucket, type ProfitAndLoss } from './profit-and-loss-section';
import type { PnlBreakdownData } from './pnl-breakdown';

/**
 * What made a bar (owner 2026-10-28; BUSINESS_LOGIC §9 "What made a bar"):
 * clicking a bar of the profit and loss chart opens its breakdown — asked
 * for by the bar's own days, a skeleton while it loads, an empty period said
 * so, every row linked to its order, expense or cycle, the API's totals shown
 * as they come (nothing added up here), and "Show more" asking for the next
 * page of one list.
 */

const nav = vi.hoisted(() => ({ query: '', push: vi.fn() }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(nav.query),
  usePathname: () => '/en/analytics',
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const get = vi.fn();
/** What the breakdown endpoint answers, by its params; a promise or a value. */
let breakdownReply: (params: Record<string, string>) => Promise<unknown>;
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, opts?: { params?: Record<string, string> }) => {
      get(url, opts?.params);
      if (url === '/analytics/profit-and-loss/breakdown') {
        return breakdownReply(opts?.params ?? {}).then((data) => ({ data: { data } }));
      }
      if (url === '/analytics/profit-and-loss') return Promise.resolve({ data: { data: PNL } });
      return Promise.resolve({ data: { data: [] } });
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

const day = (d: string, salesEgp: number, netProfitEgp: number): PnlBucket => ({
  key: d,
  from: d,
  to: d,
  salesEgp,
  grossProfitEgp: 0,
  expensesEgp: 0,
  netProfitEgp,
});

/** October to the 18th by day: a loss on the 8th, nothing on the 11th. */
const BUCKETS: PnlBucket[] = Array.from({ length: 18 }, (_, i) => {
  const d = `2026-10-${String(i + 1).padStart(2, '0')}`;
  return i === 7 ? day(d, 300, -530) : i === 10 ? day(d, 0, 0) : day(d, 1000 + i, 100 + i);
});

const PNL: ProfitAndLoss = {
  from: '2026-10-01',
  to: '2026-10-18',
  allTime: false,
  salesEgp: 20_000,
  cogsEgp: 12_000,
  grossProfitEgp: 8_000,
  grossProfitPctOfSales: 40,
  expensesEgp: 1_000,
  recoveredEgp: 0,
  otherIncomeEgp: 0,
  exchangeDifferenceEgp: 0,
  netProfitEgp: 7_000,
  netProfitPctOfSales: 35,
  expensesByCategory: [],
  granularity: 'day',
  buckets: BUCKETS,
};

const order = (id: string, orderNo: string) => ({
  id,
  orderNo,
  soldOn: '2026-10-08',
  status: 'CONFIRMED',
  customer: 'Koshary Motors',
  customerId: 'c1',
  branch: 'Mokattam',
});

/** The 8th, a loss: a sale under cost, a return of an older sale, fuel paid by Shady, a friend repaid dear. */
const LOSS_DAY: PnlBreakdownData = {
  from: '2026-10-08',
  to: '2026-10-08',
  empty: false,
  totals: {
    salesEgp: 300,
    cogsEgp: 330,
    grossProfitEgp: -30,
    expensesEgp: 500,
    recoveredEgp: 0,
    otherIncomeEgp: 0,
    exchangeDifferenceEgp: 0,
    netProfitEgp: -530,
  },
  sections: {
    orders: {
      page: 1,
      pageSize: 2,
      total: 3,
      totalPages: 2,
      totals: { saleEgp: 700, returnsEgp: -400, priceCutsEgp: 0, revenueEgp: 300, cogsEgp: 330, grossProfitEgp: -30 },
      rows: [
        {
          day: '2026-10-08',
          orderId: 'o-old',
          order: { ...order('o-old', 'ORD-2026-00031'), soldOn: '2026-10-02' },
          saleEgp: 0,
          returnsEgp: -400,
          priceCutsEgp: 0,
          revenueEgp: -400,
          cogsEgp: -220,
          grossProfitEgp: -180,
          events: [{ kind: 'return', id: 'ret-1', day: '2026-10-08', revenueEgp: -400, cogsEgp: -220 }],
        },
        {
          day: '2026-10-08',
          orderId: 'o-cheap',
          order: order('o-cheap', 'ORD-2026-00040'),
          saleEgp: 300,
          returnsEgp: 0,
          priceCutsEgp: 0,
          revenueEgp: 300,
          cogsEgp: 330,
          grossProfitEgp: -30,
          events: [],
        },
      ],
    },
    expenses: {
      page: 1,
      pageSize: 2,
      total: 1,
      totalPages: 1,
      totals: { amountEgp: 500 },
      rows: [
        {
          kind: 'ledger',
          id: 'e-fuel',
          day: '2026-10-08',
          category: 'fuel',
          amountEgp: 500,
          entry: { id: 'e-fuel', type: 'EXPENSE', reason: 'Delivery to Mokattam', cycle: { id: 'cyc-1', code: 'CYC-2026-0002' }, paidBy: { id: 'u-shady', name: 'Shady' } },
          order: null,
          loss: null,
        },
      ],
    },
    exchange: {
      page: 1,
      pageSize: 2,
      total: 1,
      totalPages: 1,
      totals: { amountEgp: 0 },
      rows: [
        {
          id: 'rep-1',
          day: '2026-10-08',
          amountEgp: 0,
          repayment: {
            paidEgp: 1100,
            rateToEgp: 11,
            currency: 'AED',
            lender: 'Ahmad',
            cycle: { id: 'cyc-1', code: 'CYC-2026-0002' },
            purchaseOrder: { id: 'po-1', reference: 'PO-2026-0002' },
          },
        },
      ],
    },
    other: { page: 1, pageSize: 2, total: 0, totalPages: 0, totals: { recoveredEgp: 0, otherIncomeEgp: 0 }, rows: [] },
  },
};

/** The third order, on page 2 of the orders list. */
const ORDERS_PAGE_2: PnlBreakdownData = {
  ...LOSS_DAY,
  sections: {
    orders: {
      ...LOSS_DAY.sections.orders!,
      page: 2,
      rows: [
        {
          day: '2026-10-08',
          orderId: 'o-good',
          order: order('o-good', 'ORD-2026-00041'),
          saleEgp: 400,
          returnsEgp: 0,
          priceCutsEgp: 0,
          revenueEgp: 400,
          cogsEgp: 220,
          grossProfitEgp: 180,
          events: [],
        },
      ],
    },
  },
};

const EMPTY: PnlBreakdownData = {
  from: '2026-10-11',
  to: '2026-10-11',
  empty: true,
  totals: { salesEgp: 0, cogsEgp: 0, grossProfitEgp: 0, expensesEgp: 0, recoveredEgp: 0, otherIncomeEgp: 0, exchangeDifferenceEgp: 0, netProfitEgp: 0 },
  sections: {},
};

function renderIn(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ProfitAndLossSection />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const breakdownCalls = () => get.mock.calls.filter(([url]) => url === '/analytics/profit-and-loss/breakdown').map(([, p]) => p);

async function openBar(key: string) {
  const chart = await screen.findByTestId('pnl-chart');
  fireEvent.click(chart.querySelector(`[data-bucket="${key}"]`)!);
  return screen.getByTestId('pnl-breakdown');
}

beforeEach(() => {
  nav.query = '';
  get.mockReset();
  breakdownReply = (p) => Promise.resolve(p.from === '2026-10-11' ? EMPTY : p.page === '2' ? ORDERS_PAGE_2 : LOSS_DAY);
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('clicking a bar opens what made it', () => {
  it('asks for that bar’s days, shows a skeleton while it loads, then the API’s totals — a loss in red', async () => {
    let release: (v: unknown) => void = () => {};
    breakdownReply = () => new Promise((r) => (release = r));
    renderIn();
    const popup = await openBar('2026-10-08');
    expect(breakdownCalls()).toEqual([{ from: '2026-10-08', to: '2026-10-08' }]);
    expect(within(popup).getByRole('heading', { level: 2 }).textContent).toBe('Thu, Oct 8, 2026');
    expect(within(popup).getByTestId('pnl-breakdown-skeleton')).toBeTruthy();
    await act(async () => release(LOSS_DAY));
    const totals = await within(popup).findByTestId('pnl-breakdown-totals');
    expect(within(popup).queryByTestId('pnl-breakdown-skeleton')).toBeNull();
    const line = (k: string) => totals.querySelector(`[data-line="${k}"] dd`)!;
    expect(line('sales').textContent).toBe('300.00 EGP');
    expect(line('gross').textContent).toBe('-30.00 EGP');
    expect(line('expenses').textContent).toBe('500.00 EGP');
    expect(line('net').textContent).toBe('-530.00 EGP');
    expect(line('net').className).toContain('text-destructive');
    // The popup's net is the bar's own (the API reads the same parts; here, its figure is shown as sent).
    expect(screen.getByTestId('pnl-chart').querySelector('[data-bucket="2026-10-08"]')!.getAttribute('aria-label')).toContain('-530.00 EGP');
    // Zero lines that are not part of every bar stay out.
    expect(totals.querySelector('[data-line="recovered"]')).toBeNull();
  });

  it('an empty day says so, with no lists', async () => {
    renderIn();
    const popup = await openBar('2026-10-11');
    expect((await within(popup).findByTestId('pnl-breakdown-empty')).textContent).toBe(en.analytics.pnl.breakdown.empty);
    expect(within(popup).queryByTestId('pnl-breakdown-orders')).toBeNull();
    expect(within(popup).queryByTestId('pnl-breakdown-totals')).toBeNull();
  });

  it('each row links to its order, expense or cycle; a return on a later day than its sale says so; Paid by is named', async () => {
    renderIn();
    const popup = await openBar('2026-10-08');
    const orders = await within(popup).findByTestId('pnl-breakdown-orders');
    const rows = [...orders.querySelectorAll('li[data-order]')];
    expect(rows.map((r) => r.getAttribute('data-order'))).toEqual(['o-old', 'o-cheap']);
    expect(rows[0].querySelector('a')!.getAttribute('href')).toBe('/sales?order=o-old');
    expect(rows[0].querySelector('a')!.textContent).toBe('ORD-2026-00031');
    expect(rows[0].textContent).toContain('Koshary Motors · Mokattam');
    // The return is on the 8th, the sale on the 2nd: only the return is here.
    expect(rows[0].querySelector('[data-event="return"]')!.textContent).toBe('Returned Oct 8, 2026 · -400.00 EGP');
    expect(rows[0].textContent).not.toContain('Sold');
    expect(rows[1].textContent).toContain('Sold Oct 8, 2026');
    expect(rows[1].getAttribute('data-loss')).toBe('true');
    expect(rows[1].querySelector('[data-testid="pnl-bd-gross"]')!.textContent).toBe('-30.00 EGP');

    const expenses = within(popup).getByTestId('pnl-breakdown-expenses');
    const fuel = expenses.querySelector('li[data-expense="e-fuel"]')!;
    expect(within(fuel as HTMLElement).getByRole('link', { name: 'Fuel' }).getAttribute('href')).toBe('/ledger?entry=e-fuel');
    expect(fuel.querySelector('[data-testid="pnl-bd-paid-by"]')!.textContent).toBe('Paid by Shady');
    expect(within(fuel as HTMLElement).getByRole('link', { name: 'CYC-2026-0002' }).getAttribute('href')).toBe('/cycles/cyc-1/details');
    expect(fuel.textContent).toContain('Delivery to Mokattam');

    const exchange = within(popup).getByTestId('pnl-breakdown-exchange');
    expect(exchange.textContent).toContain('Ahmad repaid 1,100.00 EGP at 11');
    expect(within(exchange).getByRole('link', { name: 'CYC-2026-0002' }).getAttribute('href')).toBe('/cycles/cyc-1/details');
    // A list with nothing in the period is not shown.
    expect(within(popup).queryByTestId('pnl-breakdown-other')).toBeNull();
  });

  it('the business paying is said too, not left blank', async () => {
    breakdownReply = () =>
      Promise.resolve({
        ...LOSS_DAY,
        sections: {
          ...LOSS_DAY.sections,
          expenses: {
            ...LOSS_DAY.sections.expenses!,
            rows: [{ ...LOSS_DAY.sections.expenses!.rows[0], entry: { ...LOSS_DAY.sections.expenses!.rows[0].entry!, paidBy: null } }],
          },
        },
      });
    renderIn();
    const popup = await openBar('2026-10-08');
    expect((await within(popup).findByTestId('pnl-bd-paid-by')).textContent).toBe('Paid by the business');
  });

  it('paging: "Show more" asks for the next page of that list only, appends it, and the totals stay the API’s', async () => {
    renderIn();
    const popup = await openBar('2026-10-08');
    const orders = await within(popup).findByTestId('pnl-breakdown-orders');
    expect(orders.getAttribute('data-count')).toBe('3');
    const more = within(popup).getByTestId('pnl-breakdown-orders-more');
    expect(more.textContent).toBe('Show 1 more');
    expect(within(popup).queryByTestId('pnl-breakdown-expenses-more')).toBeNull();
    fireEvent.click(more);
    await waitFor(() => expect(orders.querySelectorAll('li[data-order]')).toHaveLength(3));
    expect(breakdownCalls()[1]).toEqual({ from: '2026-10-08', to: '2026-10-08', section: 'orders', page: '2', pageSize: '2' });
    expect([...orders.querySelectorAll('li[data-order]')].map((r) => r.getAttribute('data-order'))).toEqual(['o-old', 'o-cheap', 'o-good']);
    expect(within(popup).queryByTestId('pnl-breakdown-orders-more')).toBeNull();
    // The list's total is of every row, as sent — not the rows on screen added up.
    expect(within(popup).getByTestId('pnl-breakdown-orders-total').textContent).toContain('-30.00 EGP');
  });

  it('a refusal is said in the reader’s language, from its code', async () => {
    breakdownReply = () =>
      Promise.reject({
        isAxiosError: true,
        response: { status: 400, data: { error: { code: 'PNL_BREAKDOWN_TOO_LONG', message: 'x', params: { max: 31, days: 40 } } } },
      });
    renderIn('ar');
    const popup = await openBar('2026-10-08');
    expect((await within(popup).findByTestId('pnl-breakdown-error')).textContent).toBe(
      ar.errors.PNL_BREAKDOWN_TOO_LONG.replace('{max}', '31').replace('{days}', '40'),
    );
  });

  it('the second time: closed and another bar opened, it asks for that bar’s days and shows its own figures, not the last ones', async () => {
    renderIn();
    let popup = await openBar('2026-10-08');
    await within(popup).findByTestId('pnl-breakdown-totals');
    fireEvent.click(within(popup).getByRole('button', { name: en.common.close }));
    expect(screen.queryByTestId('pnl-breakdown')).toBeNull();
    // The next bar's answer is slow: until it comes, a skeleton — never the last bar's figures.
    let release: (v: unknown) => void = () => {};
    breakdownReply = () => new Promise((r) => (release = r));
    popup = await openBar('2026-10-11');
    expect(popup.getAttribute('data-from')).toBe('2026-10-11');
    expect(within(popup).getByTestId('pnl-breakdown-skeleton')).toBeTruthy();
    expect(within(popup).queryByTestId('pnl-breakdown-totals')).toBeNull();
    await act(async () => release(EMPTY));
    await within(popup).findByTestId('pnl-breakdown-empty');
    expect(within(popup).queryByTestId('pnl-breakdown-orders')).toBeNull();
    expect(breakdownCalls().map((p) => p.from)).toEqual(['2026-10-08', '2026-10-11']);
  });

  it('in Arabic: the titles are Arabic and the minus stays with the digits', async () => {
    renderIn('ar');
    const popup = await openBar('2026-10-08');
    const orders = await within(popup).findByTestId('pnl-breakdown-orders');
    expect(orders.textContent).toContain(ar.analytics.pnl.breakdown.ordersTitle);
    const net = within(popup).getByTestId('pnl-breakdown-totals').querySelector('[data-line="net"] [data-slot="money"]')!;
    expect(net.getAttribute('dir')).toBe('ltr');
    expect(net.textContent).toMatch(/^-530\.00/);
  });
});

/** A phone: the days are folded into weeks; a week's day, or the whole week, opens its breakdown. */
describe('on a phone', () => {
  const realMatchMedia = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: /max-width/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('a day of an opened week opens that day; "What made this week" opens the week cut to the period', async () => {
    renderIn();
    const chart = await screen.findByTestId('pnl-chart');
    expect(chart.getAttribute('data-folded')).toBe('week');
    fireEvent.click(chart.querySelector('[data-bucket="2026-10-03"]')!);
    const week = screen.getByTestId('pnl-week');
    fireEvent.click(within(week).getByRole('button', { name: 'See what made Thu, Oct 8, 2026' }));
    // One dialog at a time.
    expect(screen.queryByTestId('pnl-week')).toBeNull();
    expect(screen.getByTestId('pnl-breakdown').getAttribute('data-from')).toBe('2026-10-08');

    fireEvent.click(within(screen.getByTestId('pnl-breakdown')).getByRole('button', { name: en.common.close }));
    fireEvent.click(chart.querySelector('[data-bucket="2026-09-26"]')!);
    fireEvent.click(screen.getByTestId('pnl-week-open'));
    const popup = screen.getByTestId('pnl-breakdown');
    expect([popup.getAttribute('data-from'), popup.getAttribute('data-to')]).toEqual(['2026-10-01', '2026-10-02']);
  });
});
