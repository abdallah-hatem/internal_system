import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { formatAmount } from '@/lib/numbers';
import { businessToday } from '@/lib/dates';
// The server's own formula, to hold the screen to.
import { saleOrderTotals } from '../../../../api/src/common/sale-totals';
import {
  centsText,
  type CostLayer,
  priceAgainstCost,
  unitFigure,
} from '../../../../api/src/common/below-cost';
import ar from '@/i18n/locales/ar.json';
import { SaleOrderForm, type SaleFormProduct } from './SaleOrderForm';

// `post` records the calls; `answer` is what the API replies. Kept apart because
// a vi.fn that returns a rejected promise chains its own bookkeeping onto it,
// and that copy rejects with nobody listening — a failure the form never had.
const post = vi.fn();
let answer: () => Promise<unknown> = () => new Promise(() => {});
// The price check (L4) is a request of its own, answered by `priceCheckAnswer`
// and recorded in `priceCheck`, so `post` still means "the order was sent".
const priceCheck = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    post: (path: string, ...args: unknown[]) => {
      if (path === '/sales/price-check') {
        priceCheck(...args);
        return Promise.resolve({ data: { data: priceCheckAnswer(args[0] as PriceCheckBody) } });
      }
      post(path, ...args);
      return answer();
    },
  },
}));

/**
 * The server's price check, run on the server's own function over a shelf the
 * test sets: the piston kits landed at 2,000 each unless a test says otherwise.
 */
interface PriceCheckBody {
  currency: string;
  items: { productId: string; quantity: number; unitPrice: number; discount?: number }[];
}
let shelf = new Map<string, CostLayer[]>();
function priceCheckAnswer(body: PriceCheckBody) {
  const r = priceAgainstCost(body.items, shelf);
  return {
    currency: body.currency,
    compared: true,
    lines: r.lines.map((l, i) => ({
      line: i + 1,
      productId: l.productId,
      costed: l.costed,
      belowCost: l.belowCost,
      code: l.belowCost ? 'BELOW_COST' : null,
      unitCostEgp: l.costed ? unitFigure(l.costCents, body.items[i].quantity) : null,
      unitPriceEgp: l.costed ? unitFigure(l.netCents, body.items[i].quantity) : null,
      lossEgp: l.costed ? centsText(l.lossCents) : null,
    })),
    belowCostLines: r.lines.filter((l) => l.belowCost).length,
    totalLossEgp: centsText(r.totalLossCents),
  };
}

beforeAll(() => {
  // cmdk and Radix measure and scroll things jsdom does not lay out.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

const SHOP = { id: 'c-shop', displayName: 'Nile Motors', type: 'B2B' };
const RETAIL = { id: 'c-retail', displayName: 'Mona Retail', type: 'B2C' };
const PISTON: SaleFormProduct = {
  id: 'p-piston',
  name: 'Piston kit',
  sku: 'PK-1',
  prices: [
    { channel: 'B2B', amount: 1800 },
    { channel: 'B2C', amount: 2100 },
  ],
  // As the API resolves them (§3, 2026-10-18): both set.
  listPrices: {
    B2B: { amount: '1800.00', currency: 'EGP', source: 'SET' },
    B2C: { amount: '2100.00', currency: 'EGP', source: 'SET' },
  },
};

// A shop is chosen up front: the form refuses to send an order with no
// customer (it is noValidate, so it checks its own required pickers).
function renderForm(
  onSaved = vi.fn(),
  initialCustomerId: string | undefined = SHOP.id,
  locale: 'en' | 'ar' = 'en',
  products: SaleFormProduct[] = [PISTON],
) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SaleOrderForm
            customers={[SHOP, RETAIL]}
            products={products}
            stock={products.map((p) => ({ productId: p.id, availableStock: 60 }))}
            title="New sale"
            onCancel={() => {}}
            onSaved={onSaved}
            initialCustomerId={initialCustomerId}
          />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { onSaved };
}

const lines = () => screen.getAllByTestId('sale-line');
const field = (line: HTMLElement, name: string) =>
  line.querySelector<HTMLInputElement>(`[data-field="${name}"]`)!;

/** Type the way a person does: focus, then a change, then leave. */
function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

/** Open a picker (the nth combobox) and click an option by its label. */
function pick(nth: number, label: string) {
  fireEvent.click(screen.getAllByRole('combobox')[nth]);
  fireEvent.click(screen.getByRole('option', { name: new RegExp(label) }));
}

const amount = (cents: number) => formatAmount(cents / 100);

beforeEach(() => {
  post.mockReset();
  priceCheck.mockReset();
  shelf = new Map([[PISTON.id, [{ qty: 60, unitCostEgp: '2000.0000' }]]]);
});
afterEach(cleanup);

describe("the product picker names each product's category (owner 2026-10-27)", () => {
  const HEADSET: SaleFormProduct = {
    ...PISTON,
    id: 'p-y20',
    name: 'Y20 headset',
    sku: 'Y20',
    category: { name: 'Intercoms', nameAr: 'إنتركم' },
  };
  const BARE: SaleFormProduct = { ...PISTON, id: 'p-bare', name: 'Bare part', sku: 'BP-1', category: null };
  // The picker offers its search box once a list is long enough to need one.
  const FILLER: SaleFormProduct[] = Array.from({ length: 8 }, (_, i) => ({
    ...PISTON,
    id: `p-f${i}`,
    name: `Filler ${i}`,
    sku: `F-${i}`,
    category: { name: 'Engine' },
  }));

  beforeEach(() => {
    shelf = new Map(
      [HEADSET, BARE, ...FILLER].map((p) => [p.id, [{ qty: 60, unitCostEgp: '2000.0000' }]]),
    );
  });

  const productPicker = () => screen.getAllByRole('combobox')[3]; // customer, channel, currency, then the line

  it('beside the name, in the reader\'s language; a product with no category shows its name alone', () => {
    renderForm(undefined, SHOP.id, 'en', [HEADSET, BARE]);
    fireEvent.click(productPicker());
    expect(screen.getByRole('option', { name: /Y20 headset · Intercoms/ })).toBeTruthy();
    // The label alone; the line under it (SKU · stock) has its own dots.
    expect(screen.getByRole('option', { name: /^Bare part/ }).querySelector('bdi')?.textContent).toBe('Bare part');
  });

  it('in Arabic the category is its Arabic name', () => {
    renderForm(undefined, SHOP.id, 'ar', [HEADSET]);
    fireEvent.click(productPicker());
    expect(screen.getByRole('option', { name: /إنتركم/ })).toBeTruthy();
  });

  it('the search finds a product by its category, in either language', () => {
    renderForm(undefined, SHOP.id, 'en', [HEADSET, BARE, ...FILLER]);
    for (const term of ['Intercoms', 'إنتركم']) {
      fireEvent.click(productPicker());
      fireEvent.change(screen.getByPlaceholderText(en.placeholders.searchProducts), { target: { value: term } });
      expect(screen.getByRole('option', { name: /Y20 headset/ })).toBeTruthy();
      expect(screen.queryByRole('option', { name: /Bare part/ })).toBeNull();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    }
  });
});

describe('SaleOrderForm', () => {
  it('starts with one empty item row', () => {
    renderForm();
    expect(lines()).toHaveLength(1);
  });

  it('The running total equals the server formula for the same lines, discounts included', () => {
    renderForm();
    typeInto(field(lines()[0], 'quantity'), '3');
    typeInto(field(lines()[0], 'unitPrice'), '33.33');
    typeInto(field(lines()[0], 'discount'), '0.99');

    fireEvent.click(screen.getByRole('button', { name: /add item/i }));
    typeInto(field(lines()[1], 'quantity'), '1.255');
    typeInto(field(lines()[1], 'unitPrice'), '19.99');
    typeInto(field(lines()[1], 'discount'), '5');

    const server = saleOrderTotals([
      { quantity: 3, unitPrice: 33.33, discount: 0.99 },
      { quantity: 1.255, unitPrice: 19.99, discount: 5 },
    ]);
    // 99.00 + 20.09 — a float `qty * price - discount` would say 119.0875.
    expect(server.subtotalCents).toBe(11909);
    expect(screen.getByTestId('order-total').textContent).toContain(amount(server.subtotalCents));
    const lineTotals = screen.getAllByTestId('line-total').map((el) => el.textContent);
    expect(lineTotals[0]).toContain(amount(server.lines[0].lineTotalCents));
    expect(lineTotals[1]).toContain(amount(server.lines[1].lineTotalCents));
  });

  it('each line is rounded to the cent before the lines are summed, as the server stores them', () => {
    // 0.001 × 5 = 0.005, which the server stores as 0.01 per line. Two such
    // lines owe 0.02; summing first and rounding once would show 0.01 — a
    // case where `qty * price` on screen and the stored order really differ.
    renderForm();
    typeInto(field(lines()[0], 'quantity'), '0.001');
    typeInto(field(lines()[0], 'unitPrice'), '5');
    fireEvent.click(screen.getByRole('button', { name: /add item/i }));
    typeInto(field(lines()[1], 'quantity'), '0.001');
    typeInto(field(lines()[1], 'unitPrice'), '5');

    const server = saleOrderTotals([
      { quantity: 0.001, unitPrice: 5 },
      { quantity: 0.001, unitPrice: 5 },
    ]);
    expect(server.subtotalCents).toBe(2);
    expect(screen.getByTestId('order-total').textContent).toContain(amount(2));
  });

  it('a discount larger than the line is flagged on the line before anything is sent', () => {
    renderForm();
    typeInto(field(lines()[0], 'quantity'), '1');
    typeInto(field(lines()[0], 'unitPrice'), '100');
    typeInto(field(lines()[0], 'discount'), '9999');
    expect(screen.getByText(en.sales.discountTooLarge)).toBeTruthy();
  });

  it('a negative discount cannot be entered, so no request carries one (DISCOUNT_NEGATIVE is the server’s backstop)', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'o1', orderNo: 'ORD-1', status: 'DRAFT' } } });
    const { onSaved } = renderForm();
    pick(3, 'Piston kit');
    typeInto(field(lines()[0], 'discount'), '-50');
    // The money field takes digits and a point only; the sign never lands.
    expect(field(lines()[0], 'discount').value).not.toContain('-');
    fireEvent.click(screen.getByRole('button', { name: en.sales.saveDraft }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1].items[0].discount).toBeGreaterThanOrEqual(0);
  });

  it('a list price fills an untouched line', () => {
    renderForm();
    pick(3, 'Piston kit'); // customer, channel, currency, then the line's product
    expect(field(lines()[0], 'unitPrice').value).toBe('1,800');
  });

  it('a typed price is not overwritten — not by choosing the product, nor by changing the channel', () => {
    renderForm();
    typeInto(field(lines()[0], 'unitPrice'), '1500');
    pick(3, 'Piston kit');
    expect(field(lines()[0], 'unitPrice').value).toBe('1,500');

    // A retail customer switches the channel to B2C; the typed price stays.
    pick(0, 'Mona Retail');
    expect(field(lines()[0], 'unitPrice').value).toBe('1,500');
  });

  it('an untouched list price follows the channel', () => {
    renderForm();
    pick(3, 'Piston kit');
    pick(0, 'Mona Retail');
    expect(field(lines()[0], 'unitPrice').value).toBe('2,100');
  });

  it('stays open on refusal, with its lines intact and the translated reason shown', async () => {
    const refusal = {
      response: {
        data: {
          error: {
            code: 'NOT_ENOUGH_STOCK',
            message: 'Only 60.000 of Piston kit is in stock, so 80.000 cannot be sold.',
            params: { available: '60.000', product: 'Piston kit', wanted: '80.000' },
          },
        },
      },
    };
    answer = () => Promise.reject(refusal);
    const { onSaved } = renderForm();
    pick(3, 'Piston kit');
    typeInto(field(lines()[0], 'quantity'), '80');

    fireEvent.click(screen.getByRole('button', { name: en.sales.createAndConfirm }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      en.errors.NOT_ENOUGH_STOCK.replace('{available}', '60.000')
        .replace('{product}', 'Piston kit')
        .replace('{wanted}', '80.000'),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(lines()).toHaveLength(1);
    expect(field(lines()[0], 'quantity').value).toBe('80');
    expect(field(lines()[0], 'unitPrice').value).toBe('1,800');
    expect(post.mock.calls[0][1]).toMatchObject({ confirm: true });
  });

  it('Create & confirm sends confirm: true with the idempotency key; Save as draft does not confirm', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'o1', orderNo: 'ORD-1', status: 'CONFIRMED' } } });
    const { onSaved } = renderForm();
    pick(3, 'Piston kit');
    fireEvent.click(screen.getByRole('button', { name: en.sales.createAndConfirm }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const [path, body, config] = post.mock.calls[0];
    expect(path).toBe('/sales/orders');
    expect(body).toMatchObject({ confirm: true, channel: 'B2B' });
    expect(body.items[0]).toEqual({ productId: PISTON.id, quantity: 1, unitPrice: 1800, discount: 0 });
    expect(config.headers['Idempotency-Key']).toBeTruthy();
    expect(onSaved.mock.calls[0][0].confirmed).toBe(true);

    cleanup();
    post.mockClear();
    const second = renderForm();
    pick(3, 'Piston kit');
    fireEvent.click(screen.getByRole('button', { name: en.sales.saveDraft }));
    await waitFor(() => expect(second.onSaved).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({ confirm: false });
  });

  it('a double-click sends one request', async () => {
    let resolve!: (v: unknown) => void;
    const pending = new Promise((r) => (resolve = r));
    answer = () => pending;
    renderForm();
    pick(3, 'Piston kit');
    const button = screen.getByRole('button', { name: en.sales.createAndConfirm });
    // Both clicks land before React re-renders the button as disabled.
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(post).toHaveBeenCalled());
    // And a third once the button reads as busy.
    fireEvent.click(button);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ data: { data: { id: 'o1' } } }));
  });

  it('noValidate: an order with no customer or no product names them in the reader\'s words and sends nothing', () => {
    renderForm(vi.fn(), '');
    const form = screen.getByTestId('sale-order-form').querySelector('form')!;
    expect(form.hasAttribute('novalidate')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: en.sales.createAndConfirm }));
    const alert = screen.getByTestId('form-problem');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe(
      en.validation.requiredNamed.replace('{fields}', `${en.sales.customer}, ${en.sales.product}`),
    );
    expect(post).not.toHaveBeenCalled();
  });

  // UI audit #5: the banner outlived the problem — both pickers chosen and it
  // still said to fill them in, until the next submit.
  it('the "fill in the required fields" banner follows the fields: it narrows as one is chosen and goes when both are', () => {
    renderForm(vi.fn(), '');
    fireEvent.click(screen.getByRole('button', { name: en.sales.createAndConfirm }));
    expect(screen.getByTestId('form-problem')).toBeTruthy();

    pick(0, 'Nile Motors');
    expect(screen.getByTestId('form-problem').textContent).toBe(
      en.validation.requiredNamed.replace('{fields}', en.sales.product),
    );

    pick(3, 'Piston kit');
    expect(screen.queryByTestId('form-problem')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('a line added after a refused submit does not bring the banner back before the next submit', () => {
    renderForm(vi.fn(), '');
    fireEvent.click(screen.getByRole('button', { name: en.sales.saveDraft }));
    pick(0, 'Nile Motors');
    pick(3, 'Piston kit');
    fireEvent.click(screen.getByRole('button', { name: /add item/i }));
    expect(screen.queryByTestId('form-problem')).toBeNull();

    // The second submit finds the new empty line and says so again.
    fireEvent.click(screen.getByRole('button', { name: en.sales.saveDraft }));
    expect(screen.getByTestId('form-problem').textContent).toBe(
      en.validation.requiredNamed.replace('{fields}', en.sales.product),
    );
    expect(post).not.toHaveBeenCalled();
  });

  // UI audit #33: only the banner reported; nothing showed which field was empty.
  it('a refused submit marks the empty pickers themselves, and only those; choosing one clears its mark', () => {
    renderForm(vi.fn(), '');
    fireEvent.click(screen.getByRole('button', { name: en.sales.createAndConfirm }));

    // A picker is marked when "Required" shows under it, inside its own box.
    const marked = () =>
      screen
        .getAllByRole('combobox')
        .filter((c) => c.parentElement?.querySelector('[data-slot="select-error"]'));
    const [customer, , , product] = screen.getAllByRole('combobox');
    expect(marked()).toEqual([customer, product]);
    expect(within(lines()[0]).getByText(en.common.required)).toBeTruthy();

    pick(0, 'Nile Motors');
    expect(marked()).toEqual([product]);
    pick(3, 'Piston kit');
    expect(marked()).toEqual([]);
  });

  it('the first empty picker takes the focus on a refused submit', () => {
    renderForm(vi.fn(), SHOP.id);
    fireEvent.click(screen.getByRole('button', { name: en.sales.createAndConfirm }));
    expect(document.activeElement).toBe(screen.getAllByRole('combobox')[3]);
  });

  it('the remove button on a line is a button that does not submit', () => {
    renderForm();
    const remove = within(lines()[0]).getAllByRole('button', { name: en.sales.removeItem })[0];
    expect(remove.getAttribute('type')).toBe('button');
    fireEvent.click(remove);
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId('sale-line')).toHaveLength(0);
  });
});

// ─── Walk-in (BUSINESS_LOGIC §4, 2026-10-11; W2) ─────────────────────────
// With the switch on the pickers are: payment method, channel, currency, then
// the line's product — the method takes the customer's place.
describe('SaleOrderForm — walk-in', () => {
  const walkInSwitch = () => screen.getByRole('switch', { name: en.sales.walkIn });
  const turnOn = () => fireEvent.click(walkInSwitch());
  const customerPicker = () => document.querySelector('input[type="hidden"][name="customerId"]');
  const customerPlus = () => document.querySelector('[data-quick-create="customer"]');
  const sell = () => screen.getByRole('button', { name: en.sales.sellAndTakePayment });
  const comboText = (nth: number) => screen.getAllByRole('combobox')[nth].textContent;
  const PAID = { data: { data: { id: 'o1', orderNo: 'ORD-1', status: 'PAID' } } };

  it('the switch is a button that never submits the form, and starts off', () => {
    renderForm();
    expect(walkInSwitch().getAttribute('type')).toBe('button');
    expect(walkInSwitch().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(walkInSwitch());
    expect(walkInSwitch().getAttribute('aria-checked')).toBe('true');
    expect(post).not.toHaveBeenCalled();
  });

  it('on: the customer picker and its + go, a payment method shows with Cash chosen, and the channel is fixed to B2C', () => {
    renderForm();
    expect(customerPicker()).toBeTruthy();
    expect(customerPlus()).toBeTruthy();
    turnOn();
    expect(customerPicker()).toBeNull();
    expect(customerPlus()).toBeNull();
    expect(document.querySelector('input[type="hidden"][name="paymentMethod"]')?.getAttribute('value')).toBe('CASH');
    expect(comboText(0)).toContain(en.codes.paymentMethod.CASH);
    expect(comboText(1)).toContain(en.sales.b2c);
    expect((screen.getAllByRole('combobox')[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('the method list is the payment dialog’s: every method, translated', () => {
    renderForm();
    turnOn();
    fireEvent.click(screen.getAllByRole('combobox')[0]);
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    for (const m of ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'MOBILE_WALLET'] as const) {
      expect(names.some((n) => n?.includes(en.codes.paymentMethod[m]))).toBe(true);
    }
    expect(names).toHaveLength(4);
  });

  it('retail list prices fill an untouched line, whether the product is chosen before or after the switch', () => {
    renderForm();
    pick(3, 'Piston kit');
    expect(field(lines()[0], 'unitPrice').value).toBe('1,800');
    turnOn();
    expect(field(lines()[0], 'unitPrice').value).toBe('2,100');

    fireEvent.click(screen.getByRole('button', { name: /add item/i }));
    pick(4, 'Piston kit'); // the second line's product
    expect(field(lines()[1], 'unitPrice').value).toBe('2,100');
  });

  it('a typed price is never overwritten — not by turning walk-in on, nor off again', () => {
    renderForm();
    pick(3, 'Piston kit');
    typeInto(field(lines()[0], 'unitPrice'), '1950');
    turnOn();
    expect(field(lines()[0], 'unitPrice').value).toBe('1,950');
    fireEvent.click(walkInSwitch());
    expect(field(lines()[0], 'unitPrice').value).toBe('1,950');
  });

  it('only one way out: Sell & take payment — no draft, no Create & confirm', () => {
    renderForm();
    turnOn();
    expect(sell().getAttribute('type')).toBe('submit');
    expect(screen.queryByRole('button', { name: en.sales.saveDraft })).toBeNull();
    expect(screen.queryByRole('button', { name: en.sales.createAndConfirm })).toBeNull();
    // Enter in a field submits the first submit button, which is now the sale.
    // The buttons sit in the dialog's fixed footer and belong to the form by
    // its id, so ask the form which submit buttons are its own.
    const form = screen.getByTestId('sale-order-form').querySelector('form')!;
    const submits = Array.from(form.elements).filter(
      (el) => el instanceof HTMLButtonElement && el.type === 'submit',
    );
    expect(submits).toHaveLength(1);
  });

  it('the total reads as paid, by the chosen method', () => {
    renderForm();
    expect(screen.queryByTestId('walk-in-paid')).toBeNull();
    turnOn();
    expect(screen.getByTestId('walk-in-paid-badge').textContent).toBe(en.sales.paid);
    expect(screen.getByTestId('walk-in-paid').textContent).toBe(
      en.sales.walkInPaidBy.replace('{method}', en.codes.paymentMethod.CASH),
    );
    pick(0, en.codes.paymentMethod.MOBILE_WALLET);
    expect(screen.getByTestId('walk-in-paid').textContent).toContain(en.codes.paymentMethod.MOBILE_WALLET);
  });

  it('sends walkIn: true, the method and confirm: true, with no customerId — even with a shop chosen before', async () => {
    answer = () => Promise.resolve(PAID);
    const { onSaved } = renderForm(); // opened on Nile Motors
    turnOn();
    pick(0, en.codes.paymentMethod.BANK_TRANSFER);
    pick(3, 'Piston kit');
    typeInto(field(lines()[0], 'quantity'), '2');
    fireEvent.click(sell());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    const [path, body, config] = post.mock.calls[0];
    expect(path).toBe('/sales/orders');
    expect(body).toEqual({
      walkIn: true,
      channel: 'B2C',
      currency: 'EGP',
      // The day of the sale, always said: today unless an earlier one was chosen.
      orderedOn: businessToday(),
      confirm: true,
      payment: { method: 'BANK_TRANSFER' },
      items: [{ productId: PISTON.id, quantity: 2, unitPrice: 2100, discount: 0 }],
    });
    expect('customerId' in body).toBe(false);
    expect(config.headers['Idempotency-Key']).toBeTruthy();
    expect(onSaved.mock.calls[0][0]).toMatchObject({ confirmed: true, walkIn: true });
  });

  it('no customer is required: a walk-in with no shop chosen goes straight through', async () => {
    answer = () => Promise.resolve(PAID);
    const { onSaved } = renderForm(vi.fn(), '');
    turnOn();
    pick(3, 'Piston kit');
    fireEvent.click(sell());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('form-problem')).toBeNull();
  });

  it('a product is still required: an empty line sends nothing and says so', () => {
    renderForm(vi.fn(), '');
    turnOn();
    fireEvent.click(sell());
    expect(screen.getByTestId('form-problem').textContent).toBe(
      en.validation.requiredNamed.replace('{fields}', en.sales.product),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('a double-click sends one request', async () => {
    let resolve!: (v: unknown) => void;
    const pending = new Promise((r) => (resolve = r));
    answer = () => pending;
    renderForm();
    turnOn();
    pick(3, 'Piston kit');
    act(() => {
      fireEvent.click(sell());
      fireEvent.click(sell());
    });
    await waitFor(() => expect(post).toHaveBeenCalled());
    fireEvent.click(sell());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect((sell() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(PAID));
  });

  it('a refusal shows translated and keeps everything: the switch, the method, the lines and their prices', async () => {
    answer = () =>
      Promise.reject({
        response: {
          data: {
            error: {
              code: 'NOT_ENOUGH_STOCK',
              message: 'Only 60.000 of Piston kit is in stock, so 80.000 cannot be sold.',
              params: { available: '60.000', product: 'Piston kit', wanted: '80.000' },
            },
          },
        },
      });
    const { onSaved } = renderForm();
    turnOn();
    pick(0, en.codes.paymentMethod.CHEQUE);
    pick(3, 'Piston kit');
    typeInto(field(lines()[0], 'quantity'), '80');
    typeInto(field(lines()[0], 'discount'), '15');
    fireEvent.click(sell());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      en.errors.NOT_ENOUGH_STOCK.replace('{available}', '60.000')
        .replace('{product}', 'Piston kit')
        .replace('{wanted}', '80.000'),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(walkInSwitch().getAttribute('aria-checked')).toBe('true');
    expect(comboText(0)).toContain(en.codes.paymentMethod.CHEQUE);
    expect(field(lines()[0], 'quantity').value).toBe('80');
    expect(field(lines()[0], 'unitPrice').value).toBe('2,100');
    expect(field(lines()[0], 'discount').value).toBe('15');
    // And it can be sent again: the first was refused whole.
    expect((sell() as HTMLButtonElement).disabled).toBe(false);
  });

  it('a walk-in refusal code reads in the reader’s words, not the server’s English', async () => {
    answer = () =>
      Promise.reject({
        response: { data: { error: { code: 'WALK_IN_NOT_DRAFT', message: 'A walk-in sale cannot be a draft.' } } },
      });
    renderForm();
    turnOn();
    pick(3, 'Piston kit');
    fireEvent.click(sell());
    expect((await screen.findByRole('alert')).textContent).toBe(en.errors.WALK_IN_NOT_DRAFT);
  });

  it('off again: the customer, its +, the channel, the list prices and the draft button all come back', () => {
    renderForm(); // Nile Motors, B2B
    pick(3, 'Piston kit');
    turnOn();
    expect(field(lines()[0], 'unitPrice').value).toBe('2,100');
    fireEvent.click(walkInSwitch());

    expect(customerPicker()?.getAttribute('value')).toBe(SHOP.id);
    expect(customerPlus()).toBeTruthy();
    expect(comboText(0)).toContain(SHOP.displayName);
    expect(comboText(1)).toContain(en.sales.b2b);
    expect((screen.getAllByRole('combobox')[1] as HTMLButtonElement).disabled).toBe(false);
    expect(field(lines()[0], 'unitPrice').value).toBe('1,800');
    expect(screen.getByRole('button', { name: en.sales.saveDraft })).toBeTruthy();
    expect(screen.getByRole('button', { name: en.sales.createAndConfirm })).toBeTruthy();
    expect(screen.queryByTestId('walk-in-paid')).toBeNull();
  });

  it('off again and sold to the shop: the request is an ordinary sale with no walk-in or payment in it', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'o2', orderNo: 'ORD-2', status: 'CONFIRMED' } } });
    const { onSaved } = renderForm();
    turnOn();
    fireEvent.click(walkInSwitch());
    pick(3, 'Piston kit');
    fireEvent.click(screen.getByRole('button', { name: en.sales.createAndConfirm }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const body = post.mock.calls[0][1];
    expect(body).toMatchObject({ customerId: SHOP.id, channel: 'B2B', confirm: true });
    expect('walkIn' in body).toBe(false);
    expect('payment' in body).toBe(false);
    expect(onSaved.mock.calls[0][0].walkIn).toBe(false);
  });

  it('a channel the seller chose by hand is the one restored, not the customer’s default', () => {
    renderForm(); // Nile Motors is B2B
    pick(1, en.sales.b2c);
    turnOn();
    fireEvent.click(walkInSwitch());
    expect(comboText(1)).toContain(en.sales.b2c);
  });
});

describe('SaleOrderForm — selling below cost (L4, §4)', () => {
  // The piston kits landed at 2,000 each; the B2B list price is 1,800.
  const warningOn = (line: HTMLElement) => within(line).queryByTestId('below-cost-line');
  const total = () => screen.queryByTestId('below-cost-total');
  /** Money as the screen writes it, with the bidi isolates taken out. */
  const text = (el: HTMLElement | null) => (el?.textContent ?? '').replace(/[\u2066-\u2069]/g, '').replace(/\u00a0/g, ' ');

  it('a line priced below cost says so: each costs 2,000.00, selling at 1,800.00, a loss of 600.00 on 3', async () => {
    renderForm();
    pick(3, 'Piston kit');
    typeInto(field(lines()[0], 'quantity'), '3');

    await waitFor(() => expect(warningOn(lines()[0])).toBeTruthy());
    expect(text(warningOn(lines()[0]))).toBe(
      'Below cost: each costs 2,000.00 EGP, you’re selling at 1,800.00 EGP, a loss of 600.00 EGP on this line.',
    );
    expect(text(total())).toContain('600.00 EGP');
  });

  it('it is the house warning — the amber accent token SettlementWarnings uses, a status, never the red refusal style', async () => {
    renderForm();
    pick(3, 'Piston kit');
    const warning = await waitFor(() => {
      const w = warningOn(lines()[0]);
      expect(w).toBeTruthy();
      return w!;
    });
    expect(warning.className).toMatch(/accent-50/);
    expect(warning.className).not.toMatch(/destructive|red-/);
    expect(warning.getAttribute('role')).toBe('status');
    expect(total()!.className).toMatch(/accent-50/);
  });

  it('live: raising the price clears it, a discount brings it back, the quantity moves the loss', async () => {
    renderForm();
    pick(3, 'Piston kit');
    await waitFor(() => expect(warningOn(lines()[0])).toBeTruthy());

    typeInto(field(lines()[0], 'unitPrice'), '2100');
    await waitFor(() => expect(warningOn(lines()[0])).toBeNull());
    expect(total()).toBeNull();

    // 2 × 2,100 − 300 = 3,900 against 4,000.
    typeInto(field(lines()[0], 'quantity'), '2');
    typeInto(field(lines()[0], 'discount'), '300');
    await waitFor(() => expect(text(warningOn(lines()[0]))).toContain('a loss of 100.00 EGP'));
    expect(text(warningOn(lines()[0]))).toContain('you’re selling at 1,950.00 EGP');

    typeInto(field(lines()[0], 'quantity'), '4');
    // 4 × 2,100 − 300 = 8,100 against 8,000: above cost again.
    await waitFor(() => expect(warningOn(lines()[0])).toBeNull());
  });

  it('exactly at cost is not a warning', async () => {
    renderForm();
    pick(3, 'Piston kit');
    await waitFor(() => expect(warningOn(lines()[0])).toBeTruthy());
    typeInto(field(lines()[0], 'unitPrice'), '2000');
    await waitFor(() => expect(warningOn(lines()[0])).toBeNull());
  });

  it('the total adds up every line below cost, and only those', async () => {
    renderForm();
    pick(3, 'Piston kit'); // 1 at 1,800: a loss of 200
    fireEvent.click(screen.getByRole('button', { name: /add item/i }));
    pick(4, 'Piston kit');
    typeInto(field(lines()[1], 'quantity'), '2');
    typeInto(field(lines()[1], 'unitPrice'), '1500'); // 2 at 1,500: a loss of 1,000
    fireEvent.click(screen.getByRole('button', { name: /add item/i }));
    pick(5, 'Piston kit');
    typeInto(field(lines()[2], 'unitPrice'), '2500'); // above cost

    await waitFor(() => expect(text(total())).toContain('1,200.00 EGP'));
    expect(warningOn(lines()[0])).toBeTruthy();
    expect(warningOn(lines()[1])).toBeTruthy();
    expect(warningOn(lines()[2])).toBeNull();
  });

  it('the request is the lines as typed, discount and currency included', async () => {
    renderForm();
    pick(3, 'Piston kit');
    typeInto(field(lines()[0], 'quantity'), '2');
    typeInto(field(lines()[0], 'discount'), '50');
    await waitFor(() =>
      expect(priceCheck).toHaveBeenLastCalledWith({
        currency: 'EGP',
        items: [{ productId: PISTON.id, quantity: 2, unitPrice: 1800, discount: 50 }],
      }),
    );
  });

  it('no stock behind the line, no warning (confirming refuses it anyway)', async () => {
    shelf = new Map();
    renderForm();
    pick(3, 'Piston kit');
    await waitFor(() => expect(priceCheck).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(warningOn(lines()[0])).toBeNull();
    expect(total()).toBeNull();
  });

  it('a warning never blocks: Create & confirm still sends the order', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'o1', orderNo: 'ORD-1', status: 'CONFIRMED' } } });
    const { onSaved } = renderForm();
    pick(3, 'Piston kit');
    await waitFor(() => expect(warningOn(lines()[0])).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: en.sales.createAndConfirm }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe('/sales/orders');
  });

  it('a walk-in sale is checked the same way', async () => {
    renderForm();
    fireEvent.click(screen.getByTestId('walk-in-switch'));
    pick(3, 'Piston kit'); // payment method, channel, currency, then the line
    typeInto(field(lines()[0], 'unitPrice'), '1000');
    await waitFor(() => expect(text(warningOn(lines()[0]))).toContain('a loss of 1,000.00 EGP'));
  });

  it('in Arabic the sentence is Arabic and each amount is its own left-to-right run', async () => {
    renderForm(vi.fn(), SHOP.id, 'ar');
    fireEvent.click(screen.getAllByRole('combobox')[3]);
    fireEvent.click(screen.getByRole('option', { name: /Piston kit/ }));
    const warning = await waitFor(() => {
      const w = warningOn(lines()[0]);
      expect(w).toBeTruthy();
      return w!;
    });
    expect(warning.textContent).toContain('أقل من التكلفة');
    // One run, kept on one line: a no-break space before the currency.
    expect(warning.textContent).toContain('\u20662,000.00\u00a0EGP\u2069');
    expect(total()!.textContent).toContain('\u2066200.00\u00a0EGP\u2069');
  });
});

describe('SaleOrderForm — the sale date (§4, 2026-10-16)', () => {
  // 10:00 in Cairo on 16 October 2026. Only the clock is faked.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T07:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const saleDate = () => document.querySelector<HTMLInputElement>('input[type="hidden"][name="orderedOn"]')!;
  const openCalendar = () =>
    fireEvent.click(document.querySelector<HTMLElement>('[data-date-picker="orderedOn"]')!);
  const dayButton = (day: string) => document.querySelector<HTMLButtonElement>(`[data-day="${day}"]`);

  it('is there, labelled, and starts on today in Cairo', () => {
    renderForm();
    expect(screen.getByText(en.sales.saleDate)).toBeTruthy();
    expect(saleDate().value).toBe('2026-10-16');
    expect(screen.queryByTestId('back-dated-note')).toBeNull();
  });

  it('today by default: Create & confirm sends orderedOn = today', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'o1', orderNo: 'ORD-1', status: 'CONFIRMED' } } });
    const { onSaved } = renderForm();
    pick(3, 'Piston kit');
    fireEvent.click(screen.getByRole('button', { name: en.sales.createAndConfirm }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({ orderedOn: '2026-10-16', confirm: true });
  });

  it('an earlier day chosen in the calendar is the one sent — on a draft too — and the form says what that means', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'o1', orderNo: 'ORD-1', status: 'DRAFT' } } });
    const { onSaved } = renderForm();
    openCalendar();
    fireEvent.click(dayButton('2026-10-05')!);
    expect(saleDate().value).toBe('2026-10-05');
    expect(screen.getByTestId('back-dated-note').textContent).toBe(en.sales.backDatedNote);
    pick(3, 'Piston kit');
    fireEvent.click(screen.getByRole('button', { name: en.sales.saveDraft }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({ orderedOn: '2026-10-05', confirm: false });
  });

  it('a day that has not come cannot be picked', () => {
    renderForm();
    openCalendar();
    expect(dayButton('2026-10-17')!.disabled).toBe(true);
    expect(dayButton('2026-10-16')!.disabled).toBe(false);
  });

  it('the price check is asked about the chosen day, so the cost is what that day could draw', async () => {
    renderForm();
    pick(3, 'Piston kit');
    openCalendar();
    fireEvent.click(dayButton('2026-10-05')!);
    await waitFor(() =>
      expect(priceCheck.mock.calls.some(([body]) => body.orderedOn === '2026-10-05')).toBe(true),
    );
  });

  it('a walk-in sale carries the day too', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'o1', orderNo: 'ORD-1', status: 'PAID' } } });
    const { onSaved } = renderForm(vi.fn(), undefined);
    fireEvent.click(screen.getByTestId('walk-in-switch'));
    openCalendar();
    fireEvent.click(dayButton('2026-10-02')!);
    pick(3, 'Piston kit');
    fireEvent.click(screen.getByRole('button', { name: en.sales.sellAndTakePayment }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({ walkIn: true, orderedOn: '2026-10-02' });
  });

  it('the refusal for stock that had not arrived by then reads in the reader’s words, and the form keeps the day and the lines', async () => {
    answer = () =>
      Promise.reject({
        response: {
          data: {
            error: {
              code: 'NOT_ENOUGH_STOCK_ON_DATE',
              message: 'English fallback',
              params: { product: 'Piston kit', day: '2026-10-05', available: '2.000', wanted: '5.000' },
            },
          },
        },
      });
    renderForm(vi.fn(), SHOP.id, 'ar');
    openCalendar();
    fireEvent.click(dayButton('2026-10-05')!);
    pick(3, 'Piston kit');
    fireEvent.click(screen.getByRole('button', { name: ar.sales.createAndConfirm }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('2026-10-05');
    expect(alert.textContent).not.toContain('English fallback');
    expect(alert.textContent).toContain(ar.errors.NOT_ENOUGH_STOCK_ON_DATE.split('{')[0]);
    expect(saleDate().value).toBe('2026-10-05');
    expect(lines()).toHaveLength(1);
  });
});

describe('SaleOrderForm — the default price (§3, owner 2026-10-18)', () => {
  // No price set on either channel: the API sends landed 1,500 + 20% = 1,800
  // as the DEFAULT. B2C is set at 2,100 to show the two side by side.
  const CHAIN: SaleFormProduct = {
    id: 'p-chain',
    name: 'Chain kit',
    sku: 'CK-1',
    prices: [{ channel: 'B2C', amount: 2100 }],
    listPrices: {
      B2B: { amount: '1800.00', currency: 'EGP', source: 'DEFAULT', markupPct: 20 },
      B2C: { amount: '2100.00', currency: 'EGP', source: 'SET' },
    },
  };
  const hint = () => lines()[0].querySelector('[data-testid="default-price-hint"]');

  it('an untouched line starts at the default, and says it is the default', () => {
    renderForm(vi.fn(), SHOP.id, 'en', [CHAIN]);
    pick(3, 'Chain kit');
    expect(field(lines()[0], 'unitPrice').value).toBe('1,800');
    expect(hint()?.textContent).toBe('Default (landed + 20%)');
  });

  it('a set price fills the line with no hint', () => {
    renderForm(vi.fn(), RETAIL.id, 'en', [CHAIN]);
    pick(3, 'Chain kit');
    expect(field(lines()[0], 'unitPrice').value).toBe('2,100');
    expect(hint()).toBeNull();
  });

  it('a typed price is never overwritten by the default, and the hint goes', () => {
    renderForm(vi.fn(), SHOP.id, 'en', [CHAIN]);
    typeInto(field(lines()[0], 'unitPrice'), '1650');
    pick(3, 'Chain kit');
    expect(field(lines()[0], 'unitPrice').value).toBe('1,650');
    expect(hint()).toBeNull();
  });

  it('what is saved is the line as it stands — the default it started from, as the line price — and no product price is written', async () => {
    answer = () => Promise.resolve({ data: { data: { id: 'o1', orderNo: 'ORD-1', status: 'DRAFT' } } });
    const { onSaved } = renderForm(vi.fn(), SHOP.id, 'en', [CHAIN]);
    pick(3, 'Chain kit');
    fireEvent.click(screen.getByRole('button', { name: en.sales.saveDraft }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(post.mock.calls).toHaveLength(1);
    expect(post.mock.calls[0][0]).toBe('/sales/orders');
    expect(post.mock.calls[0][1].items[0]).toMatchObject({ productId: CHAIN.id, unitPrice: 1800 });
  });

  it('in Arabic the hint is Arabic', () => {
    renderForm(vi.fn(), SHOP.id, 'ar', [CHAIN]);
    fireEvent.click(screen.getAllByRole('combobox')[3]);
    fireEvent.click(screen.getByRole('option', { name: /Chain kit/ }));
    expect(hint()?.textContent).toBe('افتراضي (التكلفة الإجمالية + 20٪)');
  });
});
