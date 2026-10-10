import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import { formatAmount } from '@/lib/numbers';
// The server's own formula, to hold the screen to.
import { saleOrderTotals } from '../../../../api/src/common/sale-totals';
import { SaleOrderForm, type SaleFormProduct } from './SaleOrderForm';

// `post` records the calls; `answer` is what the API replies. Kept apart because
// a vi.fn that returns a rejected promise chains its own bookkeeping onto it,
// and that copy rejects with nobody listening — a failure the form never had.
const post = vi.fn();
let answer: () => Promise<unknown> = () => new Promise(() => {});
vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => {
      post(...args);
      return answer();
    },
  },
}));

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
const WALKIN = { id: 'c-walkin', displayName: 'Walk-in', type: 'B2C' };
const PISTON: SaleFormProduct = {
  id: 'p-piston',
  name: 'Piston kit',
  sku: 'PK-1',
  prices: [
    { channel: 'B2B', amount: 1800 },
    { channel: 'B2C', amount: 2100 },
  ],
};

// A shop is chosen up front: the form refuses to send an order with no
// customer (it is noValidate, so it checks its own required pickers).
function renderForm(onSaved = vi.fn(), initialCustomerId: string | undefined = SHOP.id) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SaleOrderForm
            customers={[SHOP, WALKIN]}
            products={[PISTON]}
            stock={[{ productId: PISTON.id, availableStock: 60 }]}
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

beforeEach(() => post.mockReset());
afterEach(cleanup);

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

    // The walk-in customer switches the channel to B2C; the typed price stays.
    pick(0, 'Walk-in');
    expect(field(lines()[0], 'unitPrice').value).toBe('1,500');
  });

  it('an untouched list price follows the channel', () => {
    renderForm();
    pick(3, 'Piston kit');
    pick(0, 'Walk-in');
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
    const form = screen.getByTestId('sale-order-form');
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
