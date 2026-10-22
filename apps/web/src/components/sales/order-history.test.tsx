import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { OrderHistory, type OrderHistoryData } from './order-history';

/**
 * An order's full history on the sale popup (BUSINESS_LOGIC §4 "An order's
 * full history", owner 2026-10-22). The replay is the server's
 * (order-history.service); this checks the screen shows its events in its
 * order, every figure as sent, ends on what the order owes, and says when the
 * two disagree rather than hiding it.
 */

const state = vi.hoisted(() => ({
  history: null as unknown,
  fail: false,
  gets: 0,
}));

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => {
      state.gets += 1;
      if (state.fail) return Promise.reject({ response: { status: 500, data: { error: { code: 'ERROR', message: 'x' } } } });
      if (url === '/sales/orders/sale-1/history') return Promise.resolve({ data: { data: state.history } });
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
});

/** Koshary's order as it stood on 2026-10-22, the 100 off applied. */
const KOSHARY: OrderHistoryData = {
  orderId: 'sale-1',
  orderNo: 'ORD-2026-00002',
  status: 'PARTIALLY_PAID',
  events: [
    {
      kind: 'CREATED',
      date: '2026-10-01',
      at: '2026-10-01T08:00:00.000Z',
      by: 'Abdallah',
      reference: 'ORD-2026-00002',
      amount: '35200.00',
      effect: '0.00',
      owes: '0.00',
      lines: [{ product: 'Q58', productAr: 'كيو 58', qty: '5', unitPrice: '1250.00', lineTotal: '6250.00' }],
    },
    {
      kind: 'CONFIRMED',
      date: '2026-10-01',
      at: '2026-10-01T08:00:00.001Z',
      by: 'Abdallah',
      reference: 'ORD-2026-00002',
      amount: '35200.00',
      effect: '35200.00',
      owes: '35200.00',
    },
    {
      kind: 'RETURN',
      date: '2026-10-05',
      at: '2026-10-05T09:00:00.000Z',
      by: 'Shady',
      reference: 'RET-2026-00001',
      amount: '2500.00',
      effect: '-2500.00',
      owes: '32700.00',
      method: 'CREDIT_NOTE',
      reason: 'Wrong model',
      lines: [{ product: 'Q58', productAr: 'كيو 58', qty: '2', unitPrice: '1250.00' }],
    },
    {
      kind: 'PAYMENT',
      date: '2026-10-10',
      at: '2026-10-10T09:00:00.000Z',
      by: 'Fares',
      reference: 'PAY-2026-00004',
      amount: '5000.00',
      effect: '-5000.00',
      owes: '27700.00',
      method: 'CASH',
    },
    {
      kind: 'PRICE_ADJUSTED',
      date: '2026-10-22',
      at: '2026-10-22T09:00:00.000Z',
      by: 'Abdallah',
      reference: 'ORD-2026-00002',
      amount: '300.00',
      effect: '-300.00',
      owes: '27400.00',
      reason: '100 off',
      lines: [{ product: 'Q58', productAr: 'كيو 58', qty: '3', previousUnitPrice: '1250.00', unitPrice: '1150.00' }],
    },
  ],
  products: [
    {
      saleItemId: 'si-q58',
      product: 'Q58',
      productAr: 'كيو 58',
      startedWith: '5',
      returned: '2',
      holds: '3',
      soldAt: '1250.00',
      priceNow: '1150.00',
    },
  ],
  owes: '27400.00',
  replayedOwes: '27400.00',
};

beforeEach(() => {
  state.history = structuredClone(KOSHARY);
  state.fail = false;
  state.gets = 0;
});
afterEach(() => cleanup());

function wrap(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
          <OrderHistory orderId="sale-1" currency="EGP" />
        </div>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const events = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="history-event-"][data-kind]'));

describe('the timeline', () => {
  it('draws a skeleton in its own shape while loading, never a "Loading…" line', async () => {
    wrap();
    expect(screen.getByTestId('order-history-skeleton')).toBeTruthy();
    // The only "Loading" is the one a screen reader hears.
    for (const said of screen.queryAllByText(/Loading/)) expect(said.className).toContain('sr-only');
    await screen.findByTestId('order-history');
  });

  it('shows every event in the order the API sent, oldest first', async () => {
    wrap();
    await screen.findByTestId('history-events');
    expect(events().map((e) => e.dataset.kind)).toEqual(['CREATED', 'CONFIRMED', 'RETURN', 'PAYMENT', 'PRICE_ADJUSTED']);
    const labels = events().map((e) => e.querySelector('p')?.textContent ?? '');
    expect(labels[0]).toContain('Order created');
    expect(labels[2]).toContain('Return');
    expect(labels[2]).toContain('RET-2026-00001');
    expect(labels[4]).toContain('Price lowered');
  });

  it('each event says when, who and what: lines and prices, the refund and its reason, old → new price', async () => {
    wrap();
    await screen.findByTestId('history-events');
    const [created, , ret, pay, cut] = events();
    expect(created.textContent).toContain('by Abdallah');
    expect(created.textContent).toContain('Q58');
    expect(created.textContent).toContain('5 × 1,250.00');
    expect(ret.textContent).toContain('by Shady');
    expect(ret.textContent).toContain('Refund: 2,500.00');
    expect(ret.textContent).toContain('Credit');
    expect(ret.textContent).toContain('Reason: Wrong model');
    expect(ret.textContent).toContain('2 × 1,250.00');
    expect(pay.textContent).toContain('Cash');
    expect(pay.textContent).toContain('PAY-2026-00004');
    expect(cut.textContent).toContain('1,250.00 → 1,150.00');
    expect(cut.textContent).toContain('3 units');
    expect(cut.textContent).toContain('Reason: 100 off');
  });

  it('shows what was owed after each event exactly as sent — nothing summed in the browser', async () => {
    // Figures no sum of the amounts gives: the screen must print these, not its own.
    const odd = structuredClone(KOSHARY);
    odd.events = odd.events.map((e, i) => ({ ...e, owes: ['0.00', '35200.00', '32711.11', '27722.22', '27400.00'][i] }));
    state.history = odd;
    wrap();
    await screen.findByTestId('history-events');
    expect(events().map((e) => e.dataset.owes)).toEqual(['0.00', '35200.00', '32711.11', '27722.22', '27400.00']);
    expect(events()[2].textContent).toContain('32,711.11');
  });

  it("ends on the order's own outstanding, and shows both figures from the API", async () => {
    wrap();
    await screen.findByTestId('history-events');
    const last = events().at(-1)!;
    expect(last.dataset.owes).toBe(KOSHARY.owes);
    expect(screen.getByTestId('history-replayed-owes').textContent).toContain('27,400.00');
    expect(screen.getByTestId('history-owes').textContent).toContain('27,400.00');
    expect(screen.queryByTestId('history-mismatch')).toBeNull();
  });

  it('says so when the history and the order disagree, instead of showing one of them', async () => {
    state.history = { ...structuredClone(KOSHARY), owes: '27000.00' };
    wrap();
    const warning = await screen.findByTestId('history-mismatch');
    expect(warning.textContent).toContain('27,400.00');
    expect(warning.textContent).toContain('27,000.00');
    expect(screen.getByTestId('history-owes').textContent).toContain('27,000.00');
  });
});

describe('the per-product table', () => {
  it('started with, returned, holds now, price now', async () => {
    wrap();
    await screen.findByTestId('history-products');
    expect(screen.getByTestId('history-startedWith-si-q58').textContent).toBe('5');
    expect(screen.getByTestId('history-returned-si-q58').textContent).toBe('2');
    expect(screen.getByTestId('history-holds-si-q58').textContent).toBe('3');
    expect(screen.getByTestId('history-price-now-si-q58').textContent).toContain('1,150.00');
    expect(screen.getByTestId('history-products').querySelector('table')).toBeTruthy();
  });
});

describe('in Arabic', () => {
  it('labels, product names and events are Arabic; money stays a left-to-right run', async () => {
    wrap('ar');
    await screen.findByTestId('history-events');
    const products = screen.getByTestId('history-products');
    expect(within(products).getByText(ar.sales.history.startedWith)).toBeTruthy();
    expect(within(products).getByText(ar.sales.history.priceNow)).toBeTruthy();
    expect(products.textContent).toContain('كيو 58');
    const [created, , ret] = events();
    expect(created.textContent).toContain(ar.sales.history.kinds.CREATED);
    expect(ret.textContent).toContain(ar.sales.history.kinds.RETURN);
    expect(ret.textContent).toContain(ar.sales.creditNote);
    // Old → new reads right to left, each price its own run, and a Latin note
    // starting with a number keeps its words in order ("100 off", not "off 100").
    const cut = events()[4];
    expect(cut.textContent).toContain('⁨1,250.00⁩ ← ⁨1,150.00⁩');
    expect(cut.textContent).toContain('⁨100 off⁩');
    expect(screen.getByText(ar.sales.history.timeline)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Order created|Started with|Owes after/);
    const money = screen.getByTestId('history-owes').querySelector('[data-slot="money"]')!;
    expect(money.getAttribute('dir')).toBe('ltr');
  });
});

describe('empty and failed', () => {
  it('an order with no events says so', async () => {
    state.history = { ...structuredClone(KOSHARY), events: [] };
    wrap();
    expect(await screen.findByText(en.sales.history.empty)).toBeTruthy();
  });

  it('a failed load says so and tries again on request', async () => {
    state.fail = true;
    wrap();
    expect(await screen.findByText(en.sales.history.error)).toBeTruthy();
    state.fail = false;
    const before = state.gets;
    fireEvent.click(screen.getByRole('button', { name: en.sales.history.retry }));
    await waitFor(() => expect(state.gets).toBeGreaterThan(before));
    await screen.findByTestId('history-events');
  });
});
