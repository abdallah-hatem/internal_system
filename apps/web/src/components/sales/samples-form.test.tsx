import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import {
  SaleOrderForm,
  linesFromSamples,
  outOnSamples,
  type SaleFormProduct,
  type SamplesSource,
} from './SaleOrderForm';
import { businessToday } from '@/lib/dates';

/**
 * Samples at shops (BUSINESS_LOGIC §4, owner 2026-10-18), on screen: the
 * switch in the New Order popup, and "They're buying" — the same popup opened
 * pre-filled from the samples (owner 2026-10-18, round 2). Each test
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
  // As the API resolves them (§3, 2026-10-18): both set.
  listPrices: {
    B2B: { amount: '1800.00', currency: 'EGP', source: 'SET' },
    B2C: { amount: '2100.00', currency: 'EGP', source: 'SET' },
  },
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

  it('the switch box is readable: strong accent text on the pale box when on, the normal text colours when off — and no dark-mode swap to pale text', () => {
    renderForm();
    const sw = screen.getByTestId('samples-switch');
    const [title, hint] = sw.querySelectorAll<HTMLElement>('span.block');
    expect(title.textContent).toBe(en.sales.samples.switch);
    expect(hint.textContent).toBe(en.sales.samples.switchHint);
    // Off: the form's own text colours on the page's background.
    expect(title.className).toContain('text-foreground');
    expect(hint.className).toContain('text-muted-foreground');
    fireEvent.click(sw);
    // On: accent-900 (#7c2d12) on accent-50 (#fff7ed), 8.8:1 — both lines.
    expect(sw.className).toContain('bg-accent-50');
    for (const line of [title, hint]) {
      expect(line.className).toContain('text-accent-900');
      expect(line.className).not.toMatch(/text-accent-(?:[1-6]00)\b/);
    }
    // The office has one light palette; `dark:` follows the OS and turned the
    // text pale on the pale box (the owner's screenshot).
    expect(sw.outerHTML).not.toMatch(/dark:/);
  });

  it('Arabic: the switch, its explanation and the button are Arabic', () => {
    renderForm('ar');
    fireEvent.click(screen.getByTestId('samples-switch'));
    expect(screen.getByTestId('samples-switch').textContent).toContain(ar.sales.samples.switch);
    expect(screen.getByTestId('samples-switch').textContent).toContain(ar.sales.samples.switchHint);
    expect(screen.getByTestId('sale-submit').textContent).toContain(ar.sales.samples.leave);
  });
});

// ─── "They're buying": the same popup, pre-filled from the samples ───

const CHAIN: SaleFormProduct = {
  id: 'p-chain',
  name: 'Chain',
  sku: 'CH-1',
  prices: [{ channel: 'B2B', amount: 120 }],
  listPrices: { B2B: { amount: '120.00', currency: 'EGP', source: 'SET' } },
};
const BOLT: SaleFormProduct = { id: 'p-bolt', name: 'Bolt', sku: 'B-1' };
const MIRROR: SaleFormProduct = {
  id: 'p-mirror',
  name: 'Mirror',
  sku: 'MR-1',
  prices: [
    { channel: 'B2B', amount: 300 },
    { channel: 'B2C', amount: 350 },
  ],
  listPrices: {
    B2B: { amount: '300.00', currency: 'EGP', source: 'SET' },
    B2C: { amount: '350.00', currency: 'EGP', source: 'SET' },
  },
};
const SOURCE: SamplesSource = {
  id: 'o-1',
  orderNo: 'ORD-2026-00042',
  customerId: SHOP.id,
  channel: 'B2B',
  currency: 'EGP',
  leftOn: '2026-10-08',
  items: [
    { productId: PISTON.id, quantity: '5', unitPrice: '0' }, // no price noted: the B2B price
    { productId: CHAIN.id, quantity: '3', unitPrice: '95' }, // noted when left
    { productId: BOLT.id, quantity: '2', unitPrice: '0' }, // neither
  ],
};

function renderCompleting(locale: 'en' | 'ar' = 'en', onSaved = vi.fn()) {
  render(
    wrap(
      <SaleOrderForm
        customers={[SHOP]}
        products={[PISTON, CHAIN, BOLT, MIRROR]}
        // On the shelf: 1 piston, no chains or bolts, 10 mirrors.
        stock={[
          { productId: PISTON.id, availableStock: 1 },
          { productId: MIRROR.id, availableStock: 10 },
        ]}
        title="Complete sale from samples ORD-2026-00042"
        fromSamples={SOURCE}
        onCancel={() => {}}
        onSaved={onSaved}
      />,
      locale,
    ),
  );
  return { onSaved };
}
const productOf = (line: HTMLElement) => within(line).getAllByRole('combobox')[0].textContent;

describe('"They\'re buying" — the New Order popup, pre-filled from the samples', () => {
  it('opens on the shop, today and every line that went out, with its price; one button, "Complete sale", and the line saying what removing does', () => {
    renderCompleting();
    expect(screen.getByText('Complete sale from samples ORD-2026-00042')).toBeTruthy();
    expect(screen.getByTestId('samples-convert-note').textContent).toBe(
      '10 units were out as samples; for anything you remove or lower, choose below whether it stays a sample or comes back to the shelf.',
    );
    const customer = screen.getAllByRole('combobox')[0];
    expect(customer.textContent).toContain('Nile Motors');
    expect((customer as HTMLButtonElement).disabled).toBe(true);
    expect(lines().map(productOf)).toEqual([
      expect.stringContaining('Piston kit'),
      expect.stringContaining('Chain'),
      expect.stringContaining('Bolt'),
    ]);
    expect(lines().map((l) => field(l, 'quantity')!.value)).toEqual(['5', '3', '2']);
    expect(lines().map((l) => field(l, 'unitPrice')!.value)).toEqual(['1,800', '95', '']);
    // A sale's fields: discount and line totals are there, as on any order.
    expect(field(lines()[0], 'discount')).not.toBeNull();
    expect(screen.getByTestId('order-total').textContent).toContain('9,285');
    // Not a new order: no samples switch, no walk-in, no draft.
    expect(screen.queryByTestId('samples-switch')).toBeNull();
    expect(screen.queryByTestId('walk-in-switch')).toBeNull();
    expect(screen.queryByRole('button', { name: en.sales.saveDraft })).toBeNull();
    expect(screen.getByTestId('sale-submit').textContent).toContain(en.sales.samples.complete);
  });

  it('saves exactly the lines on screen — a lowered quantity, a removed line, an added product, a discount — to the convert endpoint, dated today', async () => {
    const { onSaved } = renderCompleting();
    answer = () => Promise.resolve({ data: { data: { id: 'o-1', orderNo: 'ORD-2026-00042', status: 'CONFIRMED' } } });
    typeInto(field(lines()[0], 'quantity')!, '3');
    // The bolts came back: their line goes, and they are marked Returned —
    // without the click they would stay at the shop as samples (owner 2026-10-27).
    fireEvent.click(within(lines()[2]).getByRole('button', { name: en.sales.removeItem }));
    expect(lines()).toHaveLength(2);
    const bolts = screen
      .getAllByTestId('samples-not-bought-line')
      .find((l) => l.getAttribute('data-product-id') === BOLT.id)!;
    fireEvent.click(within(bolts).getByTestId('samples-return-line'));
    // And the shop takes two mirrors that were never samples.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.sales.addItem) }));
    fireEvent.click(within(lines()[2]).getAllByRole('combobox')[0]);
    fireEvent.click(screen.getByRole('option', { name: /Mirror/ }));
    typeInto(field(lines()[2], 'quantity')!, '2');
    typeInto(field(lines()[1], 'discount')!, '15');
    // 3 × 1800 + (3 × 95 − 15) + 2 × 300 = 6,270.
    expect(screen.getByTestId('order-total').textContent).toContain('6,270');
    fireEvent.click(screen.getByTestId('sale-submit'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0];
    expect(path).toBe('/sales/orders/o-1/samples/convert');
    expect(body).toEqual({
      customerId: SHOP.id,
      channel: 'B2B',
      currency: 'EGP',
      orderedOn: businessToday(),
      items: [
        { productId: PISTON.id, quantity: 3, unitPrice: 1800, discount: 0 },
        { productId: CHAIN.id, quantity: 3, unitPrice: 95, discount: 15 },
        { productId: MIRROR.id, quantity: 2, unitPrice: 300, discount: 0 },
      ],
      // The pistons not bought stay at the shop: Keep as sample, the default.
      keepAsSample: [PISTON.id],
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onSaved.mock.calls[0][0]).toMatchObject({ fromSamples: true, confirmed: true, samples: false });
  });

  it('a product’s units out on the order count as available to it: 1 on the shelf + 5 out is 6, and 7 is too many', () => {
    renderCompleting();
    const piston = lines()[0];
    typeInto(field(piston, 'quantity')!, '6');
    expect(field(piston, 'quantity')!.className).not.toContain('border-destructive');
    typeInto(field(piston, 'quantity')!, '7');
    expect(field(piston, 'quantity')!.className).toContain('border-destructive');
    expect(piston.textContent).toContain(`6 ${en.sales.inStock}`);
    // The chain has none on the shelf, but its 3 out make it sellable in the picker.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en.sales.addItem) }));
    fireEvent.click(within(lines()[3]).getAllByRole('combobox')[0]);
    const chain = screen.getByRole('option', { name: /Chain/ });
    expect(chain.getAttribute('aria-disabled')).not.toBe('true');
    expect(chain.textContent).toContain(`3 ${en.sales.inStock}`);
  });

  it('a price noted when left is kept when the channel changes; a list price follows the channel', () => {
    renderCompleting();
    fireEvent.click(screen.getAllByRole('combobox')[1]); // channel
    fireEvent.click(screen.getByRole('option', { name: en.sales.b2c }));
    // Piston had no noted price: it takes the B2C price; the chain keeps its 95.
    expect(field(lines()[0], 'unitPrice')!.value).toBe('2,100');
    expect(field(lines()[1], 'unitPrice')!.value).toBe('95');
  });

  it('the server’s refusal is said in the reader’s language, and every line stays as typed', async () => {
    answer = () =>
      Promise.reject({
        response: {
          data: {
            error: {
              code: 'SAMPLES_EXTRA_NOT_IN_STOCK',
              message: 'x',
              params: { out: '5', product: 'Piston kit', wanted: '9', extra: '4', available: '1' },
            },
          },
        },
      });
    renderCompleting();
    typeInto(field(lines()[0], 'quantity')!, '9');
    fireEvent.click(screen.getByTestId('sale-submit'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      '5 of Piston kit went out as samples; selling 9 needs 4 more from the shelf, and only 1 is there.',
    );
    expect(field(lines()[0], 'quantity')!.value).toBe('9');
    expect(lines()).toHaveLength(3);
  });

  it('linesFromSamples: the quantity out, the noted price (typed), else the channel’s price, else nothing', () => {
    const rows = linesFromSamples(SOURCE, [PISTON, CHAIN, BOLT]);
    expect(rows.map((r) => [r.productId, r.quantity, r.unitPrice, r.priceTyped])).toEqual([
      [PISTON.id, 5, 1800, false],
      [CHAIN.id, 3, 95, true],
      [BOLT.id, 2, 0, false],
    ]);
    expect(outOnSamples(SOURCE, PISTON.id)).toBe(5);
    expect(outOnSamples(SOURCE, MIRROR.id)).toBe(0);
    expect(outOnSamples(undefined, PISTON.id)).toBe(0);
  });

  it('Arabic: the line under the title and the button are Arabic', () => {
    renderCompleting('ar');
    expect(screen.getByTestId('samples-convert-note').textContent).toBe(
      'خرجت 10 وحدات كعينات؛ لأي شيء تحذفه أو تنقصه، اختر بالأسفل هل يبقى عينة أم يرجع إلى الرف.',
    );
    expect(screen.getByTestId('sale-submit').textContent).toContain(ar.sales.samples.complete);
  });
});
