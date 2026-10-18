import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { SaleOrderForm, type SaleFormProduct } from './SaleOrderForm';
import {
  SamplesDecideDialog,
  initialRows,
  rowProblem,
  typeQty,
  type SamplesOrder,
} from './samples-decide';

/**
 * Samples at shops (BUSINESS_LOGIC §4, owner 2026-10-18), on screen: the
 * switch in the New Order popup, and the "They're buying" dialog. Each test
 * reaches the field the way a person does — the switch is clicked, a quantity
 * is typed — and reads what they would see.
 */

const post = vi.fn();
let answer: () => Promise<unknown> = () => new Promise(() => {});
vi.mock('@/lib/api', () => ({
  api: {
    post: (path: string, ...args: unknown[]) => {
      if (path === '/sales/price-check') return new Promise(() => {});
      post(path, ...args);
      return answer();
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
beforeEach(() => {
  post.mockReset();
  answer = () => new Promise(() => {});
});
afterEach(cleanup);

const SHOP = { id: 'c-shop', displayName: 'Nile Motors', type: 'B2B' };
const PISTON: SaleFormProduct = {
  id: 'p-piston',
  name: 'Piston kit',
  sku: 'PK-1',
  prices: [
    { channel: 'B2B', amount: 1800 },
    { channel: 'B2C', amount: 2100 },
  ],
};

function wrap(children: React.ReactNode, locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return (
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
}

function renderForm(locale: 'en' | 'ar' = 'en', onSaved = vi.fn()) {
  render(
    wrap(
      <SaleOrderForm
        customers={[SHOP]}
        products={[PISTON]}
        stock={[{ productId: PISTON.id, availableStock: 60 }]}
        title="New order"
        onCancel={() => {}}
        onSaved={onSaved}
        initialCustomerId={SHOP.id}
      />,
      locale,
    ),
  );
  return { onSaved };
}

const lines = () => screen.getAllByTestId('sale-line');
const field = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}
function pickProduct() {
  // Customer, channel, currency, then the line's product.
  fireEvent.click(screen.getAllByRole('combobox')[3]);
  fireEvent.click(screen.getByRole('option', { name: /Piston kit/ }));
}

describe('New Order popup — "Samples — no charge yet"', () => {
  it('off: an ordinary sale (draft, create & confirm, discount, a total)', () => {
    renderForm();
    const sw = screen.getByTestId('samples-switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('button', { name: en.sales.saveDraft })).toBeTruthy();
    expect(screen.getByTestId('sale-submit').textContent).toContain(en.sales.createAndConfirm);
    expect(field(lines()[0], 'discount')).not.toBeNull();
    expect(screen.getByTestId('walk-in-switch')).toBeTruthy();
  });

  it('on: amber with its explanation; prices optional, no discount, no draft, no walk-in, and the button reads "Leave samples"', () => {
    renderForm();
    fireEvent.click(screen.getByTestId('samples-switch'));
    const sw = screen.getByTestId('samples-switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.className).toMatch(/accent/); // the warning palette: amber, not a sale yet
    expect(sw.textContent).toContain(en.sales.samples.switchHint);
    expect(screen.queryByRole('button', { name: en.sales.saveDraft })).toBeNull();
    expect(screen.getByTestId('sale-submit').textContent).toContain(en.sales.samples.leave);
    expect(within(lines()[0]).getByText(en.sales.samples.priceOptional)).toBeTruthy();
    expect(field(lines()[0], 'discount')).toBeNull();
    expect(screen.queryByTestId('walk-in-switch')).toBeNull();
    expect(screen.getByTestId('order-total').textContent).toContain(en.sales.samples.noCharge);
    expect(screen.getByText(en.sales.samples.leftOn)).toBeTruthy();
  });

  it('turning samples on turns walk-in off — samples need a shop', () => {
    renderForm();
    fireEvent.click(screen.getByTestId('walk-in-switch'));
    expect(screen.getByTestId('walk-in-switch').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('samples-switch'));
    // Back off, walk-in is off too and the customer is there again.
    fireEvent.click(screen.getByTestId('samples-switch'));
    expect(screen.getByTestId('walk-in-switch').getAttribute('aria-checked')).toBe('false');
  });

  it('sends samples: true with the shop, and a price only where one is set — never a discount or a confirm', async () => {
    renderForm();
    fireEvent.click(screen.getByTestId('samples-switch'));
    pickProduct();
    typeInto(field(lines()[0], 'quantity')!, '4');
    // The list price (1800) filled the line; clearing it leaves no price at all.
    const price = field(lines()[0], 'unitPrice')!;
    expect(price.value).toContain('1,800');
    fireEvent.change(price, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('sale-submit'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0];
    expect(path).toBe('/sales/orders');
    expect(body).toMatchObject({ samples: true, customerId: SHOP.id, channel: 'B2B' });
    expect(body.confirm).toBeUndefined();
    expect(body.items).toEqual([{ productId: PISTON.id, quantity: 4 }]);
  });

  it('a price that is set is sent as a note', async () => {
    renderForm();
    fireEvent.click(screen.getByTestId('samples-switch'));
    pickProduct();
    typeInto(field(lines()[0], 'quantity')!, '2');
    fireEvent.click(screen.getByTestId('sale-submit'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].items).toEqual([{ productId: PISTON.id, quantity: 2, unitPrice: 1800 }]);
  });

  it('a refusal from the server is said in the reader’s language and the form stays open', async () => {
    answer = () =>
      Promise.reject({
        response: { data: { error: { code: 'NOT_ENOUGH_STOCK', message: 'x', params: { available: '60', product: 'Piston kit', wanted: '99' } } } },
      });
    renderForm();
    fireEvent.click(screen.getByTestId('samples-switch'));
    pickProduct();
    typeInto(field(lines()[0], 'quantity')!, '99');
    fireEvent.click(screen.getByTestId('sale-submit'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('samples-switch').getAttribute('aria-checked')).toBe('true');
  });

  it('Arabic: the switch, its explanation and the button are Arabic', () => {
    renderForm('ar');
    fireEvent.click(screen.getByTestId('samples-switch'));
    expect(screen.getByTestId('samples-switch').textContent).toContain(ar.sales.samples.switch);
    expect(screen.getByTestId('samples-switch').textContent).toContain(ar.sales.samples.switchHint);
    expect(screen.getByTestId('sale-submit').textContent).toContain(ar.sales.samples.leave);
  });
});

// ─── The decide dialog ───────────────────────────────────────────────

const ORDER: SamplesOrder = {
  id: 'o-1',
  orderNo: 'ORD-2026-00042',
  channel: 'B2B',
  currency: 'EGP',
  items: [
    { id: 'i-piston', productId: PISTON.id, product: { name: 'Piston kit', sku: 'PK-1' }, quantity: 5, unitPrice: 0 },
    { id: 'i-chain', productId: 'p-chain', product: { name: 'Chain', sku: 'CH-1' }, quantity: 3, unitPrice: 95 },
    { id: 'i-bolt', productId: 'p-bolt', product: { name: 'Bolt', sku: 'B-1' }, quantity: 2, unitPrice: 0 },
  ],
};

describe('The decision, as rules', () => {
  it('starts with everything bought; the price is the one noted, else the list price, else empty', () => {
    const rows = initialRows(ORDER, [PISTON]);
    expect(rows.map((r) => [r.buy, r.back, r.price])).toEqual([
      ['5', '0', '1800'], // list price for B2B
      ['3', '0', '95'], // noted when left
      ['2', '0', ''], // neither: empty, and required to buy
    ]);
    expect(rowProblem(rows[2])).toBe('PRICE_NEEDED');
  });

  it('buying + returned must be what is out; nothing negative; a bought line needs a price; nothing bought needs none', () => {
    const [row] = initialRows(ORDER, [PISTON]);
    expect(rowProblem({ ...row, buy: '3', back: '1' })).toBe('MUST_ADD_UP');
    expect(rowProblem({ ...row, buy: '3', back: '3' })).toBe('MUST_ADD_UP');
    expect(rowProblem({ ...row, buy: '', back: '5' })).toBe('MUST_ADD_UP');
    expect(rowProblem({ ...row, buy: '-1', back: '6' })).toBe('NEGATIVE');
    expect(rowProblem({ ...row, buy: '3', back: '2', price: '' })).toBe('PRICE_NEEDED');
    expect(rowProblem({ ...row, buy: '0', back: '5', price: '' })).toBeNull();
    expect(rowProblem({ ...row, buy: '3', back: '2', price: '0' })).toBeNull();
    // Thousandths: 0.1 + 0.2 of 0.3 out adds up.
    expect(rowProblem({ ...row, out: 0.3, buy: '0.1', back: '0.2' })).toBeNull();
  });

  it('typing one quantity fills the other with the rest — but never over a number the partner typed', () => {
    const [row] = initialRows(ORDER, [PISTON]);
    const a = typeQty(row, 'buy', '3');
    expect([a.buy, a.back]).toEqual(['3', '2']);
    const b = typeQty(a, 'back', '1'); // typed by hand: buy (typed) stays
    expect([b.buy, b.back]).toEqual(['3', '1']);
    // Returned was typed: it stays, even where the rest would differ (5 − 2 = 3).
    const c = typeQty(b, 'buy', '2');
    expect([c.buy, c.back]).toEqual(['2', '1']);
    // And the other way: returned typed first, then buying — buying is the rest
    // until it is typed itself.
    const [fresh] = initialRows(ORDER, [PISTON]);
    const d = typeQty(fresh, 'back', '4');
    expect([d.buy, d.back]).toEqual(['1', '4']);
  });
});

describe('"They\'re buying" dialog', () => {
  function renderDialog(locale: 'en' | 'ar' = 'en', onDone = vi.fn()) {
    render(wrap(<SamplesDecideDialog order={ORDER} products={[PISTON]} onClose={() => {}} onDone={onDone} />, locale));
    return { onDone };
  }
  const row = (i: number) => screen.getAllByTestId('samples-decide-line')[i];

  it('refuses to send a decision that does not add up or has no price, saying which line', () => {
    renderDialog();
    // Bolt has no price yet.
    fireEvent.click(screen.getByTestId('samples-decide-submit'));
    expect(post).not.toHaveBeenCalled();
    expect(within(row(2)).getByTestId('samples-decide-problem').textContent).toBe(en.sales.samples.priceNeeded);
    // Piston: 2 bought + 2 returned typed by hand is 4 of 5.
    typeInto(field(row(0), 'buyQty')!, '2');
    typeInto(field(row(0), 'returnQty')!, '2');
    expect(within(row(0)).getByTestId('samples-decide-problem').textContent).toContain('5');
    fireEvent.click(screen.getByTestId('samples-decide-submit'));
    expect(post).not.toHaveBeenCalled();
  });

  it('sends each line — bought, returned, and a price only for what is bought — and shows the sale total and what comes back', async () => {
    renderDialog();
    typeInto(field(row(0), 'buyQty')!, '3'); // returned fills to 2
    expect(field(row(0), 'returnQty')!.value).toBe('2');
    typeInto(field(row(2), 'buyQty')!, '0'); // nothing of the bolts
    // 3 × 1800 + 3 × 95 = 5,685.00; back: 2 + 2.
    expect(screen.getByTestId('samples-decide-total').textContent).toContain('5,685');
    expect(screen.getByTestId('samples-decide-back').textContent).toContain('4');
    fireEvent.click(screen.getByTestId('samples-decide-submit'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0];
    expect(path).toBe('/sales/orders/o-1/samples/decide');
    expect(body.lines).toEqual([
      { saleItemId: 'i-piston', buyQty: 3, returnQty: 2, unitPrice: 1800 },
      { saleItemId: 'i-chain', buyQty: 3, returnQty: 0, unitPrice: 95 },
      { saleItemId: 'i-bolt', buyQty: 0, returnQty: 2 },
    ]);
  });

  it('nothing bought: says so, and the button reads "Returned"', () => {
    renderDialog();
    for (const i of [0, 1, 2]) typeInto(field(row(i), 'buyQty')!, '0');
    expect(screen.getByTestId('samples-all-returned')).toBeTruthy();
    expect(screen.getByTestId('samples-decide-submit').textContent).toContain(en.sales.samples.returned);
  });

  it('Arabic labels', () => {
    renderDialog('ar');
    expect(screen.getByText(ar.sales.samples.decideTitle.replace('{orderNo}', ORDER.orderNo))).toBeTruthy();
    expect(within(row(0)).getByText(ar.sales.samples.buyQty)).toBeTruthy();
    expect(within(row(0)).getByText(ar.sales.samples.returnQty)).toBeTruthy();
    expect(within(row(0)).getByText(ar.sales.samples.priceEach)).toBeTruthy();
  });
});
