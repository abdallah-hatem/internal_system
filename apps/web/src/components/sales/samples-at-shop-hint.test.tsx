import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import { SaleOrderForm, type SaleFormProduct, type SamplesSource } from './SaleOrderForm';
import type { ShopSamplesOrder } from './samples-at-shop-hint';

/**
 * New Order warns when the shop holds samples (BUSINESS_LOGIC §4, owner
 * 2026-10-25): pick a shop with samples out and the form says what it holds,
 * above the lines, with a link to that samples order's "They're buying". The
 * shop is picked the way a person picks it — the customer picker is opened and
 * an option clicked — and each test reads what they would see.
 */

const post = vi.fn();
const get = vi.fn();
/** What the API holds per shop; a shop missing here never answers. */
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
const SLOW = { id: 'c-slow', displayName: 'Slow Garage', type: 'B2B' };
const HELMET: SaleFormProduct = {
  id: 'p-helmet',
  name: 'Helmet',
  sku: 'HLM-1',
  listPrices: {
    B2B: { amount: '900.00', currency: 'EGP', source: 'SET' },
    B2C: { amount: '1100.00', currency: 'EGP', source: 'SET' },
  },
} as SaleFormProduct;

const ONE_HELMET: ShopSamplesOrder = {
  id: 'o-12',
  orderNo: 'ORD-0012',
  leftOn: '2026-10-20',
  lines: [{ productId: HELMET.id, name: 'Helmet', nameAr: 'خوذة', sku: 'HLM-1', units: '1' }],
};
const SEVERAL: ShopSamplesOrder = {
  id: 'o-15',
  orderNo: 'ORD-0015',
  leftOn: '2026-10-22',
  lines: [
    { productId: 'p-gloves', name: 'Gloves', nameAr: null, sku: 'GLV-1', units: '2' },
    { productId: HELMET.id, name: 'Helmet', nameAr: 'خوذة', sku: 'HLM-1', units: '3' },
  ],
};

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  held = { [NILE.id]: [ONE_HELMET], [DELTA.id]: [] };
});

function renderForm(
  opts: { locale?: 'en' | 'ar'; initial?: string; onOpenSamples?: (o: ShopSamplesOrder) => void; fromSamples?: SamplesSource } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const locale = opts.locale ?? 'en';
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SaleOrderForm
            customers={[NILE, DELTA, SLOW]}
            products={[HELMET]}
            stock={[{ productId: HELMET.id, availableStock: 20 }]}
            title="New order"
            onCancel={() => {}}
            onSaved={() => {}}
            initialCustomerId={opts.initial}
            onOpenSamples={opts.onOpenSamples}
            fromSamples={opts.fromSamples}
          />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

/** Open the customer picker and click the shop, as a person does. */
function pickShop(name: string) {
  fireEvent.click(screen.getAllByRole('combobox')[0]);
  fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }));
}
const hint = () => screen.queryByTestId('samples-at-shop-hint');

describe('New Order — the shop holds samples', () => {
  it('picking a shop with one sample out says so above the lines, naming the samples order and the day', async () => {
    renderForm();
    expect(hint()).toBeNull();
    pickShop('Nile Motors');
    await waitFor(() => expect(hint()).not.toBeNull());
    expect(hint()!.textContent).toContain('This shop holds 1 Helmet as a sample (ORD-0012, left');
    expect(hint()!.textContent).toContain(en.sales.samples.holdsAddHint);
    // Above the lines: the hint comes before the first line in the document.
    const firstLine = screen.getAllByTestId('sale-line')[0];
    expect(hint()!.compareDocumentPosition(firstLine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('several products on one order and two open orders: each product with its units, each order on its own', async () => {
    held[NILE.id] = [ONE_HELMET, SEVERAL];
    renderForm({ initial: NILE.id });
    await waitFor(() => expect(screen.getAllByTestId('samples-at-shop-order')).toHaveLength(2));
    const [first, second] = screen.getAllByTestId('samples-at-shop-order');
    expect(first.textContent).toContain('1 Helmet as a sample (ORD-0012');
    expect(second.textContent).toContain('2 Gloves and 3 Helmet as samples (ORD-0015');
  });

  it('a shop with no samples shows nothing', async () => {
    renderForm();
    pickShop('Delta Bikes');
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/sales/orders/samples-at-shop', { params: { customerId: DELTA.id } }),
    );
    // Let the answer land, then look.
    await act(async () => {});
    expect(hint()).toBeNull();
  });

  it('switching shop never leaves the last shop\'s hint behind — not while the next one loads, and it comes back on the second visit', async () => {
    renderForm();
    pickShop('Nile Motors');
    await waitFor(() => expect(hint()).not.toBeNull());

    // A shop whose answer has not come yet: Nile's hint must already be gone.
    pickShop('Slow Garage');
    expect(hint()).toBeNull();

    pickShop('Delta Bikes');
    await act(async () => {});
    expect(hint()).toBeNull();

    pickShop('Nile Motors');
    await waitFor(() => expect(hint()).not.toBeNull());
    expect(hint()!.textContent).toContain('ORD-0012');
  });

  it('walk-in has no shop, so no hint; turning it off brings the shop\'s hint back', async () => {
    renderForm({ initial: NILE.id });
    await waitFor(() => expect(hint()).not.toBeNull());
    fireEvent.click(screen.getByTestId('walk-in-switch'));
    expect(hint()).toBeNull();
    fireEvent.click(screen.getByTestId('walk-in-switch'));
    await waitFor(() => expect(hint()).not.toBeNull());
  });

  it('the hint never blocks: Create & confirm sends the order for the shop that holds samples, as typed', async () => {
    renderForm({ initial: NILE.id });
    await waitFor(() => expect(hint()).not.toBeNull());
    fireEvent.click(screen.getAllByRole('combobox')[3]);
    fireEvent.click(screen.getByRole('option', { name: /Helmet/ }));
    const qty = screen.getAllByTestId('sale-line')[0].querySelector<HTMLInputElement>('[data-field="quantity"]')!;
    fireEvent.focus(qty);
    fireEvent.change(qty, { target: { value: '5' } });
    expect((screen.getByTestId('sale-submit') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('sale-submit'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe('/sales/orders');
    expect(post.mock.calls[0][1]).toMatchObject({
      customerId: NILE.id,
      confirm: true,
      items: [{ productId: HELMET.id, quantity: 5 }],
    });
  });

  it('the link hands the samples order over to "They\'re buying", and is a button that never submits the form', async () => {
    const onOpenSamples = vi.fn();
    renderForm({ initial: NILE.id, onOpenSamples });
    await waitFor(() => expect(hint()).not.toBeNull());
    const link = screen.getByTestId('samples-at-shop-open');
    expect(link.textContent).toBe("They're buying — open ORD-0012");
    expect(link.getAttribute('type')).toBe('button');
    fireEvent.click(link);
    expect(onOpenSamples).toHaveBeenCalledWith(ONE_HELMET);
    // A submit would reach the API a tick later; nothing does.
    await act(async () => {});
    expect(post).not.toHaveBeenCalled();
  });

  it('completing samples is that order already: no hint there', async () => {
    renderForm({
      fromSamples: {
        id: ONE_HELMET.id,
        orderNo: ONE_HELMET.orderNo,
        customerId: NILE.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: HELMET.id, quantity: 1, unitPrice: 0 }],
      },
    });
    await act(async () => {});
    expect(hint()).toBeNull();
    expect(get).not.toHaveBeenCalledWith('/sales/orders/samples-at-shop', expect.anything());
  });

  it('in Arabic: the Arabic product name and sentence', async () => {
    renderForm({ locale: 'ar', initial: NILE.id });
    await waitFor(() => expect(hint()).not.toBeNull());
    expect(hint()!.textContent).toContain('هذا المحل لديه');
    expect(hint()!.textContent).toContain('خوذة');
    expect(hint()!.textContent).toContain(ar.sales.samples.holdsAddHint);
  });
});
