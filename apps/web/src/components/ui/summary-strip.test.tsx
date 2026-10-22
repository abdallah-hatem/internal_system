import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { Package } from '@/components/ui/icons';
import { SummaryStrip, type SummaryCard } from './summary-strip';
import {
  CustomersSummary,
  CyclesSummary,
  PaymentsSummary,
  SalesSummary,
  StockSummary,
  topEarningCycles,
} from '../summary/tab-summaries';

/**
 * The summary strip at the top of Cycles, Products, Inventory, Sales,
 * Customers and Payments (owner 2026-10-18, reshaped 2026-10-22). The strip
 * lays out what it is given, each card with the dashboard tiles' icon badge;
 * the tab summaries show the API's figures and never add up money.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const get = vi.fn();
vi.mock('@/lib/api', () => ({ api: { get: (url: string) => get(url) } }));

// A loaded machine (several suites at once) answers a mocked query in more than 1s.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  get.mockReset();
});

function show(ui: ReactNode, locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
        <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>{ui}</div>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** What the API answers for `url`, in its `{ data }` envelope. */
function answer(byUrl: Record<string, unknown>) {
  get.mockImplementation((url: string) => {
    const key = Object.keys(byUrl).find((k) => url.startsWith(k));
    if (!key) return Promise.reject(new Error(`unexpected ${url}`));
    const body = byUrl[key];
    return body instanceof Error ? Promise.reject(body) : Promise.resolve({ data: { data: body } });
  });
}

const card = (n: number, extra: Partial<SummaryCard> = {}): SummaryCard => ({
  key: `k${n}`,
  label: `Label ${n}`,
  subject: `Subject ${n}`,
  value: `Value ${n}`,
  icon: Package,
  color: 'bg-indigo-500',
  ...extra,
});

describe('SummaryStrip', () => {
  it('shows each card: label, subject, figure', () => {
    show(<SummaryStrip label="Top" cards={[card(1, { sub: 'Sub 1' })]} />);
    const strip = screen.getByRole('region', { name: 'Top' });
    expect(within(strip).getByText('Label 1')).toBeTruthy();
    expect(within(strip).getByText('Subject 1')).toBeTruthy();
    expect(within(strip).getByText('Value 1')).toBeTruthy();
    expect(within(strip).getByText('Sub 1')).toBeTruthy();
  });

  it('every card wears its icon badge, in its colour, hidden from a screen reader', () => {
    show(<SummaryStrip label="Top" cards={[card(1), card(2, { color: 'bg-emerald-600' })]} />);
    const badges = screen.getAllByTestId('summary-card-icon');
    expect(badges).toHaveLength(2);
    expect(badges[0].className).toContain('bg-indigo-500');
    expect(badges[1].className).toContain('bg-emerald-600');
    expect(badges[0].getAttribute('aria-hidden')).toBe('true');
    expect(badges[0].querySelector('svg')).toBeTruthy();
  });

  it('a count card has no subject line: label, figure, sub — nothing empty between them', () => {
    show(<SummaryStrip label="Top" cards={[card(1, { subject: undefined, sub: 'Sub 1' })]} />);
    const c = screen.getByTestId('summary-card');
    expect(c.textContent).toBe('Label 1Value 1Sub 1');
    expect(c.querySelector('[dir="auto"]')).toBeNull();
  });

  it('the skeleton traces each card: the badge, and a subject line only where the card has one', () => {
    const { container } = show(
      <SummaryStrip label="Top" cards={[]} isLoading skeletonCount={2} skeletonSubject={[false, true]} />,
    );
    const [count, named] = [...container.querySelectorAll('[data-testid="summary-card-skeleton"]')];
    // Each skeleton: its text lines and the badge's block.
    const lines = (el: Element) => el.querySelectorAll('.animate-pulse, [class*="animate-pulse"]').length;
    expect(lines(named) - lines(count)).toBe(1);
  });

  it('no cards draws nothing at all — not an empty frame, not zeros', () => {
    const { container } = show(<SummaryStrip label="Top" cards={[]} />);
    expect(container.querySelector('[data-testid="summary-strip"]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('loading draws skeleton cards, not a spinner, and announces once', () => {
    const { container } = show(<SummaryStrip label="Top" cards={[card(1)]} isLoading skeletonCount={2} />);
    expect(container.querySelectorAll('[data-testid="summary-card-skeleton"]')).toHaveLength(2);
    // Not "skeleton-row": that id counts a list's rows (99-skeletons), and these are cards above it.
    expect(container.querySelectorAll('[data-testid="skeleton-row"]')).toHaveLength(0);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByText('Subject 1')).toBeNull();
  });

  it('never more than three cards, however many it is handed', () => {
    show(<SummaryStrip label="Top" cards={[1, 2, 3, 4, 5].map((n) => card(n))} />);
    expect(screen.getAllByTestId('summary-card')).toHaveLength(3);
    expect(screen.queryByText('Subject 4')).toBeNull();
  });

  it('a card with href is a link, with onClick a button (type=button), else plain', () => {
    const onClick = vi.fn();
    show(
      <SummaryStrip
        label="Top"
        cards={[card(1, { href: '/cycles/c1/details' }), card(2, { onClick }), card(3)]}
      />,
    );
    const [a, b, c] = screen.getAllByTestId('summary-card');
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('/cycles/c1/details');
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('type')).toBe('button');
    fireEvent.click(b);
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(c.tagName).toBe('DIV');
  });

  it('a long subject is cut with an ellipsis in its own direction, not pushing the card wide', () => {
    const long = 'X'.repeat(200);
    show(<SummaryStrip label="Top" cards={[card(1, { subject: long })]} />);
    const subject = screen.getByText(long);
    expect(subject.className).toContain('truncate');
    expect(subject.getAttribute('dir')).toBe('auto');
    expect(subject.getAttribute('title')).toBe(long);
  });

  it('uses no physical left/right classes, so Arabic mirrors', () => {
    const { container } = show(<SummaryStrip label="Top" cards={[card(1), card(2)]} />, 'ar');
    const classes = [...container.querySelectorAll('*')].map((el) => el.getAttribute('class') ?? '').join(' ');
    expect(classes).not.toMatch(/(^|\s)-?(pl|pr|ml|mr|left|right)-|text-left|text-right/);
    expect(classes).toContain('text-start');
  });
});

const cycle = (code: string, profit: number, roiPct: number | null = 10) => ({
  cycleId: `id-${code}`,
  cycleCode: code,
  profit,
  roiPct,
});

describe('topEarningCycles — Analytics ranking, three, money-makers only', () => {
  it('highest profit first, at most three', () => {
    const r = topEarningCycles([cycle('A', 100), cycle('B', 400), cycle('C', 300), cycle('D', 200)]);
    expect(r.map((c) => c.cycleCode)).toEqual(['B', 'C', 'D']);
  });

  it('equal profit falls to the code, whatever order the API sent', () => {
    const tied = [cycle('C', 500), cycle('A', 500), cycle('B', 500)];
    expect(topEarningCycles(tied).map((c) => c.cycleCode)).toEqual(['A', 'B', 'C']);
    expect(topEarningCycles([...tied].reverse()).map((c) => c.cycleCode)).toEqual(['A', 'B', 'C']);
  });

  it('a loss or a zero is never "top-earning"; none earning is none', () => {
    expect(topEarningCycles([cycle('L', -900), cycle('Z', 0), cycle('W', 1)]).map((c) => c.cycleCode)).toEqual(['W']);
    expect(topEarningCycles([cycle('L', -900), cycle('Z', 0)])).toEqual([]);
    expect(topEarningCycles([])).toEqual([]);
  });
});

describe('CyclesSummary', () => {
  it('shows the API profit as given, linked to the cycle, and no ROI line when ROI is unknown', async () => {
    answer({ '/analytics/cycle-profitability': [cycle('CYC-1', 12345.6, null), cycle('CYC-2', -50)] });
    show(<CyclesSummary />);
    const strip = await screen.findByTestId('cycles-summary');
    const cards = within(strip).getAllByTestId('summary-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('href')).toBe('/cycles/id-CYC-1/details');
    expect(cards[0].textContent).toContain('CYC-1');
    expect(cards[0].textContent).toContain('12,345.60 EGP');
    expect(cards[0].textContent).not.toContain('ROI');
  });

  it('no cycle has made money: nothing above the list', async () => {
    answer({ '/analytics/cycle-profitability': [cycle('CYC-1', 0)] });
    const { container } = show(<CyclesSummary />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="cycles-summary-skeleton"]')).toBeNull());
    expect(container.querySelector('[data-testid="cycles-summary"]')).toBeNull();
  });

  it('in Arabic: Latin digits, the cycle code isolated', async () => {
    answer({ '/analytics/cycle-profitability': [cycle('CYC-1', 1000, 12.5)] });
    show(<CyclesSummary />, 'ar');
    const strip = await screen.findByTestId('cycles-summary');
    expect(strip.textContent).toContain('1,000.00 EGP');
    expect(strip.textContent).toContain('12.5%');
    expect(strip.textContent).not.toMatch(/[٠-٩]/);
  });
});

describe('StockSummary — the Products and Inventory tabs (owner 2026-10-22)', () => {
  it('two cards: products and units in stock, the API’s figures as given, each with its icon', async () => {
    answer({ '/analytics/stock-summary': { totalProducts: 42, unitsInStock: 1234.5 } });
    show(<StockSummary testId="products-summary" />);
    const strip = await screen.findByTestId('products-summary');
    const [products, units] = within(strip).getAllByTestId('summary-card');
    expect(products.textContent).toContain(en.tabSummary.products);
    expect(products.textContent).toContain('42');
    expect(products.getAttribute('href')).toBe('/products');
    expect(units.textContent).toContain(en.tabSummary.unitsInStock);
    expect(units.textContent).toContain('1,234.5');
    expect(units.getAttribute('href')).toBe('/inventory');
    // The dashboard's Units in stock badge.
    expect(within(units).getByTestId('summary-card-icon').className).toContain('bg-orange-400');
    expect(within(strip).getAllByTestId('summary-card-icon')).toHaveLength(2);
  });

  it('none yet: the cards say 0, not nothing — a count is a figure', async () => {
    answer({ '/analytics/stock-summary': { totalProducts: 0, unitsInStock: 0 } });
    show(<StockSummary />);
    const strip = await screen.findByTestId('stock-summary');
    expect(within(strip).getAllByTestId('summary-card').map((c) => c.textContent?.includes('0'))).toEqual([true, true]);
  });

  it('the API refusing leaves the tab as it was', async () => {
    answer({ '/analytics/stock-summary': new Error('403') });
    const { container } = show(<StockSummary />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="stock-summary-skeleton"]')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('in Arabic: translated, Latin digits', async () => {
    answer({ '/analytics/stock-summary': { totalProducts: 1500, unitsInStock: 20 } });
    show(<StockSummary />, 'ar');
    const strip = await screen.findByTestId('stock-summary');
    expect(strip.textContent).toContain(ar.tabSummary.unitsInStock);
    expect(strip.textContent).toContain('1,500');
    expect(strip.textContent).not.toMatch(/[٠-٩]/);
  });
});

const order = (orderNo: string, revenueEgp: number, units: number, lines: number, walkIn = false) => ({
  orderId: `id-${orderNo}`,
  orderNo,
  customer: { id: 'c', displayName: 'Delta Motors', isWalkIn: walkIn },
  revenueEgp,
  units,
  lines,
});

describe('SalesSummary', () => {
  it('most revenue and largest order, each opening its own order', async () => {
    answer({
      '/analytics/top-orders': { mostRevenue: order('SO-1', 50000, 5, 2), mostUnits: order('SO-2', 1200, 65, 3) },
    });
    const onOpen = vi.fn();
    show(<SalesSummary onOpen={onOpen} />);
    const strip = await screen.findByTestId('sales-summary');
    const [rev, units] = within(strip).getAllByTestId('summary-card');
    expect(rev.textContent).toContain('SO-1');
    expect(rev.textContent).toContain('50,000.00 EGP');
    expect(rev.textContent).toContain('Delta Motors');
    expect(units.textContent).toContain('65 units');
    expect(units.textContent).toContain('3 products');
    fireEvent.click(units);
    expect(onOpen).toHaveBeenCalledWith('id-SO-2');
  });

  it('a walk-in sale says Walk-in, never the shared record’s name; one product is singular', async () => {
    answer({
      '/analytics/top-orders': { mostRevenue: order('SO-9', 100, 1, 1, true), mostUnits: order('SO-9', 100, 1, 1, true) },
    });
    show(<SalesSummary onOpen={() => {}} />);
    const strip = await screen.findByTestId('sales-summary');
    expect(strip.textContent).toContain('Walk-in');
    expect(strip.textContent).not.toContain('Delta Motors');
    expect(strip.textContent).toContain('1 product');
    expect(strip.textContent).not.toContain('1 products');
  });

  it('the largest order counts kinds of product, not lines: two lines of one product read "1 product"', async () => {
    answer({
      '/analytics/top-orders': { mostRevenue: null, mostUnits: { ...order('SO-3', 900, 30, 2), products: 1 } },
    });
    show(<SalesSummary onOpen={() => {}} />);
    const strip = await screen.findByTestId('sales-summary');
    expect(strip.textContent).toContain('1 product');
    expect(strip.textContent).not.toMatch(/line/);
  });

  it('nothing sold: nothing drawn', async () => {
    answer({ '/analytics/top-orders': { mostRevenue: null, mostUnits: null } });
    const { container } = show(<SalesSummary onOpen={() => {}} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="sales-summary-skeleton"]')).toBeNull());
    expect(container.querySelector('[data-testid="sales-summary"]')).toBeNull();
  });

  it('in Arabic every label is translated and the digits stay Latin', async () => {
    answer({
      '/analytics/top-orders': { mostRevenue: order('SO-1', 50000, 5, 2), mostUnits: order('SO-2', 1200, 65, 3) },
    });
    show(<SalesSummary onOpen={() => {}} />, 'ar');
    const strip = await screen.findByTestId('sales-summary');
    expect(strip.textContent).toContain(ar.tabSummary.mostRevenue);
    expect(strip.textContent).toContain('65');
    expect(strip.textContent).not.toMatch(/[٠-٩]/);
    expect(strip.textContent).not.toMatch(/tabSummary\./);
  });
});

describe('CustomersSummary (owner 2026-10-22)', () => {
  it('how many customers, and who has paid the most — linked to that customer', async () => {
    answer({
      '/analytics/customer-summary': {
        totalCustomers: 17,
        topPayer: { customerId: 'cust-1', displayName: 'Koshary', paidEgp: 5000 },
      },
    });
    show(<CustomersSummary />);
    const strip = await screen.findByTestId('customers-summary');
    const [count, top] = within(strip).getAllByTestId('summary-card');
    expect(count.textContent).toContain('17');
    expect(count.tagName).toBe('DIV');
    expect(top.textContent).toContain('Koshary');
    expect(top.textContent).toContain('5,000.00 EGP');
    expect(top.getAttribute('href')).toBe('/customers/cust-1');
    expect(within(strip).getAllByTestId('summary-card-icon')).toHaveLength(2);
  });

  it('nobody has paid yet: the count alone, no empty "paid the most" card', async () => {
    answer({ '/analytics/customer-summary': { totalCustomers: 3, topPayer: null } });
    show(<CustomersSummary />);
    const strip = await screen.findByTestId('customers-summary');
    expect(within(strip).getAllByTestId('summary-card')).toHaveLength(1);
    expect(strip.textContent).not.toContain(en.tabSummary.topPayer);
  });

  it('in Arabic: translated, the shop’s name isolated, Latin digits', async () => {
    answer({
      '/analytics/customer-summary': {
        totalCustomers: 2,
        topPayer: { customerId: 'c', displayName: 'Koshary Motors', paidEgp: 12500 },
      },
    });
    show(<CustomersSummary />, 'ar');
    const strip = await screen.findByTestId('customers-summary');
    expect(strip.textContent).toContain(ar.tabSummary.topPayer);
    expect(screen.getByText('Koshary Motors').getAttribute('dir')).toBe('auto');
    expect(strip.textContent).toContain('12,500.00 EGP');
    expect(strip.textContent).not.toMatch(/[٠-٩]/);
  });
});

const payment = (extra: Record<string, unknown> = {}) => ({
  paymentId: 'pay-1',
  amount: 25000,
  currency: 'EGP',
  receivedOn: '2026-10-18',
  reference: 'PAY-7',
  method: 'CASH',
  customer: { id: 'cust-9', displayName: 'Flesteeny', isWalkIn: false },
  ...extra,
});

describe('PaymentsSummary (owner 2026-10-22)', () => {
  it('the largest payment, who paid it, on which day and how — linked to the customer', async () => {
    answer({ '/analytics/payment-summary': { largest: payment() } });
    show(<PaymentsSummary />);
    const strip = await screen.findByTestId('payments-summary');
    const c = within(strip).getByTestId('summary-card');
    expect(c.textContent).toContain(en.tabSummary.largestPayment);
    expect(c.textContent).toContain('Flesteeny');
    expect(c.textContent).toContain('25,000.00 EGP');
    expect(c.textContent).toContain(en.codes.paymentMethod.CASH);
    expect(c.getAttribute('href')).toBe('/customers/cust-9');
    expect(within(c).getByTestId('summary-card-icon')).toBeTruthy();
  });

  it('a walk-in buyer says Walk-in and links nowhere (the shared record is not a customer)', async () => {
    answer({
      '/analytics/payment-summary': {
        largest: payment({ customer: { id: 'walk', displayName: 'Walk-in record', isWalkIn: true } }),
      },
    });
    show(<PaymentsSummary />);
    const c = within(await screen.findByTestId('payments-summary')).getByTestId('summary-card');
    expect(c.textContent).toContain('Walk-in');
    expect(c.textContent).not.toContain('Walk-in record');
    expect(c.tagName).toBe('DIV');
  });

  it('no payment yet: nothing drawn', async () => {
    answer({ '/analytics/payment-summary': { largest: null } });
    const { container } = show(<PaymentsSummary />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="payments-summary-skeleton"]')).toBeNull());
    expect(container.querySelector('[data-testid="payments-summary"]')).toBeNull();
  });

  it('in Arabic: translated, Latin digits', async () => {
    answer({ '/analytics/payment-summary': { largest: payment() } });
    show(<PaymentsSummary />, 'ar');
    const strip = await screen.findByTestId('payments-summary');
    expect(strip.textContent).toContain(ar.tabSummary.largestPayment);
    expect(strip.textContent).toContain('25,000.00 EGP');
    expect(strip.textContent).not.toMatch(/[٠-٩]/);
  });
});
