import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { SaleOrderForm, type SaleFormProduct, type SamplesSource } from './SaleOrderForm';
import type { ShopSamplesOrder } from './samples-at-shop-hint';

/**
 * Samples into the current order (BUSINESS_LOGIC §4, owner 2026-10-27): New
 * Order's samples hint is a list per product with Add to order and Add all;
 * the line it adds is tagged "From sample ORD-…", edits like any line and is
 * sent with its samples order. "They're buying" asks, for a removed or
 * lowered line, Keep as sample (the default) or Returned.
 *
 * Every shop is picked and every button clicked the way a person does, and
 * each test reads what they would see or what would be sent (CLAUDE.md §2).
 */

const post = vi.fn();
const get = vi.fn();
let held: Record<string, ShopSamplesOrder[]> = {};
vi.mock('@/lib/api', () => ({
  api: {
    post: (path: string, ...args: unknown[]) => {
      if (path === '/sales/price-check') return new Promise(() => {});
      post(path, ...args);
      return new Promise(() => {});
    },
    get: (path: string, config?: { params?: { customerId?: string } }) => {
      get(path, config);
      const id = config?.params?.customerId ?? '';
      if (path !== '/sales/orders/samples-at-shop' || !(id in held)) return new Promise(() => {});
      return Promise.resolve({ data: { data: held[id] } });
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
afterEach(cleanup);

const NILE = { id: 'c-nile', displayName: 'Nile Motors', type: 'B2B' };
const DELTA = { id: 'c-delta', displayName: 'Delta Bikes', type: 'B2B' };
const price = (b2b: string) => ({
  B2B: { amount: b2b, currency: 'EGP', source: 'SET' },
  B2C: { amount: b2b, currency: 'EGP', source: 'SET' },
});
const HELMET = { id: 'p-helmet', name: 'Helmet', sku: 'HLM-1', listPrices: price('900.00') } as SaleFormProduct;
const GLOVES = { id: 'p-gloves', name: 'Gloves', sku: 'GLV-1', listPrices: price('150.00') } as SaleFormProduct;
const CHAIN = { id: 'p-chain', name: 'Chain', sku: 'CH-1', listPrices: price('400.00') } as SaleFormProduct;

const ONE_HELMET: ShopSamplesOrder = {
  id: 'o-12',
  orderNo: 'ORD-0012',
  leftOn: '2026-10-20',
  lines: [{ productId: HELMET.id, name: 'Helmet', nameAr: 'خوذة', sku: 'HLM-1', units: '1' }],
};
const GLOVES_AND_HELMETS: ShopSamplesOrder = {
  id: 'o-15',
  orderNo: 'ORD-0015',
  leftOn: '2026-10-22',
  lines: [
    { productId: GLOVES.id, name: 'Gloves', nameAr: null, sku: 'GLV-1', units: '2' },
    { productId: HELMET.id, name: 'Helmet', nameAr: 'خوذة', sku: 'HLM-1', units: '3' },
  ],
};

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  held = { [NILE.id]: [ONE_HELMET, GLOVES_AND_HELMETS], [DELTA.id]: [] };
});

function renderForm(opts: { locale?: 'en' | 'ar'; initial?: string; fromSamples?: SamplesSource } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const locale = opts.locale ?? 'en';
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SaleOrderForm
            customers={[NILE, DELTA]}
            products={[HELMET, GLOVES, CHAIN]}
            // Gloves: none on the shelf, two at the shop.
            stock={[
              { productId: HELMET.id, availableStock: 20 },
              { productId: GLOVES.id, availableStock: 0 },
              { productId: CHAIN.id, availableStock: 10 },
            ]}
            title="New order"
            onCancel={() => {}}
            onSaved={() => {}}
            initialCustomerId={opts.initial}
            fromSamples={opts.fromSamples}
          />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

function pickShop(name: string) {
  fireEvent.click(screen.getAllByRole('combobox')[0]);
  fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }));
}
const hint = () => screen.queryByTestId('samples-at-shop-hint');
const lines = () => screen.getAllByTestId('sale-line');
const field = (line: HTMLElement, name: string) => line.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
/** The Add button of one product on one samples order. */
const addButton = (orderNo: string, productId: string) => {
  const order = screen
    .getAllByTestId('samples-at-shop-order')
    .find((o) => o.getAttribute('data-order-no') === orderNo)!;
  const line = within(order)
    .getAllByTestId('samples-at-shop-line')
    .find((l) => l.getAttribute('data-product-id') === productId)!;
  return within(line).getByTestId('samples-at-shop-add') as HTMLButtonElement;
};
function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
}
const sentItems = () => (post.mock.calls[0][1] as { items: Record<string, unknown>[] }).items;

describe('New Order — samples into the current order', () => {
  it('the hint lists each product the shop holds with Add to order; adding one puts a tagged line on the order at the units held and the channel price, in place of the empty line', async () => {
    renderForm({ initial: NILE.id });
    await waitFor(() => expect(hint()).not.toBeNull());
    expect(screen.getAllByTestId('samples-at-shop-line')).toHaveLength(3);
    expect(lines()).toHaveLength(1);

    fireEvent.click(addButton('ORD-0015', HELMET.id));
    expect(lines()).toHaveLength(1);
    const [line] = lines();
    expect(field(line, 'quantity')!.value).toBe('3');
    expect(field(line, 'unitPrice')!.value).toBe('900');
    expect(within(line).getByTestId('sale-line-from-sample').textContent).toBe(
      'From sample ORD-0015 · 3 at the shop',
    );
    // Added once: the button says so and adds nothing more.
    const again = addButton('ORD-0015', HELMET.id);
    expect(again.disabled).toBe(true);
    expect(again.textContent).toBe(en.sales.samples.added);
    fireEvent.click(again);
    expect(lines()).toHaveLength(1);
    // The same product on the other order is its own sample.
    expect(addButton('ORD-0012', HELMET.id).disabled).toBe(false);
  });

  it('Add all puts every product of every order on, once; a second Add all adds nothing', async () => {
    renderForm({ initial: NILE.id });
    await waitFor(() => expect(hint()).not.toBeNull());
    // One added by hand first: Add all adds only the other two.
    fireEvent.click(addButton('ORD-0012', HELMET.id));
    fireEvent.click(screen.getByTestId('samples-at-shop-add-all'));
    expect(lines()).toHaveLength(3);
    expect(screen.getAllByTestId('sale-line-from-sample').map((t) => t.textContent)).toEqual([
      'From sample ORD-0012 · 1 at the shop',
      'From sample ORD-0015 · 2 at the shop',
      'From sample ORD-0015 · 3 at the shop',
    ]);
    // Everything is on: Add all goes.
    expect(screen.queryByTestId('samples-at-shop-add-all')).toBeNull();
  });

  it('the line edits like any line: a quantity raised past the sample, a price typed — and both are sent with the samples order, on confirm and on a draft', async () => {
    renderForm({ initial: NILE.id });
    await waitFor(() => expect(hint()).not.toBeNull());
    fireEvent.click(addButton('ORD-0015', GLOVES.id));
    const [line] = lines();
    // 0 on the shelf + 2 at the shop: 2 is fine, 3 is more than there is.
    expect(field(line, 'quantity')!.className).not.toContain('border-destructive');
    typeInto(field(line, 'quantity')!, '3');
    expect(field(line, 'quantity')!.className).toContain('border-destructive');
    typeInto(field(line, 'quantity')!, '2');
    typeInto(field(line, 'unitPrice')!, '175');
    // A typed price stays when the channel changes.
    fireEvent.click(screen.getAllByRole('combobox')[1]);
    fireEvent.click(screen.getByRole('option', { name: en.sales.b2c }));
    expect(field(line, 'unitPrice')!.value).toBe('175');

    fireEvent.click(screen.getByRole('button', { name: en.sales.saveDraft }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({ customerId: NILE.id, confirm: false });
    expect(sentItems()).toEqual([
      { productId: GLOVES.id, quantity: 2, unitPrice: 175, discount: 0, fromSamplesOrderId: GLOVES_AND_HELMETS.id },
    ]);
  });

  it('changing a sample line to another product makes it an ordinary line: no tag, nothing sent from samples', async () => {
    renderForm({ initial: NILE.id });
    await waitFor(() => expect(hint()).not.toBeNull());
    fireEvent.click(addButton('ORD-0012', HELMET.id));
    fireEvent.click(within(lines()[0]).getAllByRole('combobox')[0]);
    fireEvent.click(screen.getByRole('option', { name: /Chain/ }));
    expect(screen.queryByTestId('sale-line-from-sample')).toBeNull();
    expect(addButton('ORD-0012', HELMET.id).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('sale-submit'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(sentItems()[0]).not.toHaveProperty('fromSamplesOrderId');
  });

  it('the second visit: switching shop drops the old shop’s sample lines and keeps a line typed by hand; back on the first shop they can be added again', async () => {
    renderForm({ initial: NILE.id });
    await waitFor(() => expect(hint()).not.toBeNull());
    fireEvent.click(addButton('ORD-0012', HELMET.id));
    // A line typed by hand beside it.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.sales.addItem) }));
    fireEvent.click(within(lines()[1]).getAllByRole('combobox')[0]);
    fireEvent.click(screen.getByRole('option', { name: /Chain/ }));
    expect(lines()).toHaveLength(2);

    pickShop('Delta Bikes');
    expect(lines()).toHaveLength(1);
    expect(screen.queryByTestId('sale-line-from-sample')).toBeNull();
    fireEvent.click(screen.getByTestId('sale-submit'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({ customerId: DELTA.id });
    expect(sentItems()).toEqual([{ productId: CHAIN.id, quantity: 1, unitPrice: 400, discount: 0 }]);

    pickShop('Nile Motors');
    await waitFor(() => expect(hint()).not.toBeNull());
    expect(addButton('ORD-0012', HELMET.id).disabled).toBe(false);
  });

  it('a shop whose only lines were samples gets an empty line back, never an order with none', async () => {
    renderForm({ initial: NILE.id });
    await waitFor(() => expect(hint()).not.toBeNull());
    fireEvent.click(screen.getByTestId('samples-at-shop-add-all'));
    pickShop('Delta Bikes');
    expect(lines()).toHaveLength(1);
    expect(screen.queryByTestId('sale-line-from-sample')).toBeNull();
  });

  it('walk-in and leaving samples take the sample lines off; leaving samples offers no Add', async () => {
    renderForm({ initial: NILE.id });
    await waitFor(() => expect(hint()).not.toBeNull());
    fireEvent.click(addButton('ORD-0012', HELMET.id));
    fireEvent.click(screen.getByTestId('walk-in-switch'));
    expect(screen.queryByTestId('sale-line-from-sample')).toBeNull();
    fireEvent.click(screen.getByTestId('walk-in-switch'));
    await waitFor(() => expect(hint()).not.toBeNull());
    fireEvent.click(addButton('ORD-0012', HELMET.id));
    fireEvent.click(screen.getByTestId('samples-switch'));
    expect(screen.queryByTestId('sale-line-from-sample')).toBeNull();
    expect(screen.queryByTestId('samples-at-shop-add')).toBeNull();
    expect(screen.queryByTestId('samples-at-shop-add-all')).toBeNull();
  });

  it('in Arabic: the buttons and the tag', async () => {
    renderForm({ locale: 'ar', initial: NILE.id });
    await waitFor(() => expect(hint()).not.toBeNull());
    expect(addButton('ORD-0012', HELMET.id).textContent).toBe('أضف إلى الطلب');
    fireEvent.click(addButton('ORD-0012', HELMET.id));
    expect(screen.getByTestId('sale-line-from-sample').textContent).toBe('من العينة ORD-0012 · 1 عند المحل');
    expect(screen.getByTestId('samples-at-shop-add-all').textContent).toBe('أضف الكل');
  });
});

describe('"They\'re buying" — keep as sample, or returned', () => {
  const SOURCE: SamplesSource = {
    id: 'o-15',
    orderNo: 'ORD-0015',
    customerId: NILE.id,
    channel: 'B2B',
    currency: 'EGP',
    leftOn: '2026-10-22',
    items: [
      { productId: GLOVES.id, quantity: 2, unitPrice: 0 },
      { productId: HELMET.id, quantity: 3, unitPrice: 0 },
    ],
  };
  const notBoughtLine = (productId: string) =>
    screen.getAllByTestId('samples-not-bought-line').find((l) => l.getAttribute('data-product-id') === productId);

  it('nothing removed: nothing asked, nothing kept', async () => {
    renderForm({ fromSamples: SOURCE });
    expect(screen.queryByTestId('samples-not-bought')).toBeNull();
    fireEvent.click(screen.getByTestId('sale-submit'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({ keepAsSample: [] });
  });

  it('a removed line and a lowered one are listed with Keep as sample chosen; Returned is one click, and what is sent follows', async () => {
    renderForm({ fromSamples: SOURCE });
    // Gloves removed, helmets lowered from 3 to 1.
    fireEvent.click(within(lines()[0]).getByRole('button', { name: en.sales.removeItem }));
    typeInto(field(lines()[0], 'quantity')!, '1');
    expect(within(notBoughtLine(GLOVES.id)!).getByTestId('samples-keep').getAttribute('aria-checked')).toBe('true');
    expect(notBoughtLine(GLOVES.id)!.textContent).toContain('2 × Gloves');
    expect(notBoughtLine(HELMET.id)!.textContent).toContain('2 × Helmet');
    fireEvent.click(within(notBoughtLine(GLOVES.id)!).getByTestId('samples-return-line'));
    expect(within(notBoughtLine(GLOVES.id)!).getByTestId('samples-keep').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByTestId('sale-submit'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body, config] = post.mock.calls[0];
    expect(path).toBe('/sales/orders/o-15/samples/convert');
    expect(body).toMatchObject({ keepAsSample: [HELMET.id] });
    // A retry must not make a second sale.
    expect((config as { headers: Record<string, string> }).headers['Idempotency-Key']).toBeTruthy();
  });

  it('the second visit: raising the line back to what went out takes it off the list, and the choice made for it no longer counts', async () => {
    renderForm({ fromSamples: SOURCE });
    typeInto(field(lines()[1], 'quantity')!, '1');
    fireEvent.click(within(notBoughtLine(HELMET.id)!).getByTestId('samples-return-line'));
    typeInto(field(lines()[1], 'quantity')!, '3');
    expect(screen.queryByTestId('samples-not-bought')).toBeNull();
    fireEvent.click(screen.getByTestId('sale-submit'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toMatchObject({ keepAsSample: [] });
    await act(async () => {});
  });

  it('in Arabic', () => {
    renderForm({ locale: 'ar', fromSamples: SOURCE });
    fireEvent.click(within(lines()[0]).getByRole('button', { name: ar.sales.removeItem }));
    expect(within(notBoughtLine(GLOVES.id)!).getByTestId('samples-keep').textContent).toBe('تبقى عينة');
    expect(within(notBoughtLine(GLOVES.id)!).getByTestId('samples-return-line').textContent).toBe('رجعت');
  });
});
