import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { SummaryStrip, type SummaryCard } from './summary-strip';
import {
  CyclesSummary,
  ProductsSummary,
  SalesSummary,
  topEarningCycles,
} from '../summary/tab-summaries';

/**
 * The summary strip at the top of Cycles, Products and Sales (owner
 * 2026-10-18). The strip lays out what it is given; the tab summaries pick
 * with Analytics' own rules from the API's figures and never add up money.
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

const product = (name: string, units: number, revenue: number) => ({
  productId: `id-${name}`,
  name,
  nameAr: `ع-${name}`,
  totalQuantitySold: units,
  revenueEgp: revenue,
});

describe('ProductsSummary', () => {
  it('asks the API for its top three by units and keeps its order', async () => {
    answer({ '/analytics/top-products': [product('Y20', 28, 25000), product('Y30', 21, 25200)] });
    show(<ProductsSummary />);
    const strip = await screen.findByTestId('products-summary');
    expect(get).toHaveBeenCalledWith('/analytics/top-products?limit=3&by=units');
    const cards = within(strip).getAllByTestId('summary-card');
    expect(cards.map((c) => c.getAttribute('href'))).toEqual(['/products/id-Y20', '/products/id-Y30']);
    expect(cards[0].textContent).toContain('28 sold');
    expect(cards[0].textContent).toContain('25,000.00 EGP');
  });

  it('a product that sold nothing net of returns takes no card (the Analytics rule)', async () => {
    answer({ '/analytics/top-products': [product('A', 3, 30), product('B', 0, 0)] });
    show(<ProductsSummary />);
    const strip = await screen.findByTestId('products-summary');
    expect(within(strip).getAllByTestId('summary-card')).toHaveLength(1);
  });

  it('the API refusing (a role that may not read it) leaves the tab as it was', async () => {
    answer({ '/analytics/top-products': new Error('403') });
    const { container } = show(<ProductsSummary />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="products-summary-skeleton"]')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('shows the Arabic name in Arabic', async () => {
    answer({ '/analytics/top-products': [product('Y20', 2, 200)] });
    show(<ProductsSummary />, 'ar');
    expect(await screen.findByText('ع-Y20')).toBeTruthy();
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
    expect(units.textContent).toContain('3 lines');
    fireEvent.click(units);
    expect(onOpen).toHaveBeenCalledWith('id-SO-2');
  });

  it('a walk-in sale says Walk-in, never the shared record’s name; one line is singular', async () => {
    answer({
      '/analytics/top-orders': { mostRevenue: order('SO-9', 100, 1, 1, true), mostUnits: order('SO-9', 100, 1, 1, true) },
    });
    show(<SalesSummary onOpen={() => {}} />);
    const strip = await screen.findByTestId('sales-summary');
    expect(strip.textContent).toContain('Walk-in');
    expect(strip.textContent).not.toContain('Delta Motors');
    expect(strip.textContent).toContain('1 line');
    expect(strip.textContent).not.toContain('1 lines');
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
