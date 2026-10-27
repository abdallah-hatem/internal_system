import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ToastProvider } from '@/components/ui/toast';
import type { CustomerBranch } from '@/lib/customer-branches';
import { SaleOrderForm, type SaleFormProduct } from './SaleOrderForm';
import { SamplesAtShopHint, type ShopSamplesOrder } from './samples-at-shop-hint';

/**
 * Samples by branch (BUSINESS_LOGIC §4 and §7, owner 2026-10-27: "what happens
 * when having samples for 2 branches, then we start an order on the third
 * branch, or even one of the 2?" — "build it"). New Order shows the order's
 * own branch's samples first and every other branch's under a collapsed "At
 * other branches"; Add all takes only the order's branch; a sample taken from
 * another branch says whose it is; changing the order's branch regroups and
 * re-tags. A customer with no branches sees the list as before.
 *
 * Every branch is picked and every button clicked as a person does, and each
 * test reads what they would see or what would be sent (CLAUDE.md §2).
 */

const post = vi.fn();
let held: Record<string, ShopSamplesOrder[]> = {};
let branchesOf: Record<string, CustomerBranch[]> = {};
vi.mock('@/lib/api', () => ({
  api: {
    post: (path: string, ...args: unknown[]) => {
      if (path === '/sales/price-check') return new Promise(() => {});
      post(path, ...args);
      return new Promise(() => {});
    },
    get: (path: string, config?: { params?: { customerId?: string } }) => {
      if (path === '/sales/orders/samples-at-shop') {
        const id = config?.params?.customerId ?? '';
        return id in held ? Promise.resolve({ data: { data: held[id] } }) : new Promise(() => {});
      }
      const id = /^\/customers\/([^/]+)\/branches$/.exec(path)?.[1];
      if (id) {
        return Promise.resolve({
          data: { data: branchesOf[id] ?? [], meta: { noBranchOwed: '0.00', totalOwed: '0.00' } },
        });
      }
      return new Promise(() => {});
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

const branch = (id: string, name: string, isDefault = false, archived = false): CustomerBranch => ({
  id,
  name,
  address: null,
  phone: null,
  isDefault,
  archivedAt: archived ? '2026-10-20T10:00:00Z' : null,
  orderCount: 0,
  owed: '0.00',
});

const ZOGMAR = { id: 'c-zogmar', displayName: 'Ahmad Zogmar', type: 'B2B' };
const NILE = { id: 'c-nile', displayName: 'Nile Motors', type: 'B2B' };
const price = (amount: string) => ({
  B2B: { amount, currency: 'EGP', source: 'SET' },
  B2C: { amount, currency: 'EGP', source: 'SET' },
});
const HELMET = { id: 'p-helmet', name: 'Helmet', sku: 'HLM-1', listPrices: price('900.00') } as SaleFormProduct;
const GLOVES = { id: 'p-gloves', name: 'Gloves', sku: 'GLV-1', listPrices: price('150.00') } as SaleFormProduct;
const CHAIN = { id: 'p-chain', name: 'Chain', sku: 'CH-1', listPrices: price('400.00') } as SaleFormProduct;

const LS2 = { id: 'b-ls2', name: 'LS2', archived: false };
const MASTER = { id: 'b-master', name: 'Master', archived: false };
const OLD = { id: 'b-old', name: 'Old Street', archived: true };

const AT_LS2: ShopSamplesOrder = {
  id: 'o-412',
  orderNo: 'ORD-0412',
  leftOn: '2026-10-20',
  branch: LS2,
  lines: [{ productId: HELMET.id, name: 'Helmet', nameAr: 'خوذة', sku: 'HLM-1', units: '1' }],
};
const AT_MASTER: ShopSamplesOrder = {
  id: 'o-415',
  orderNo: 'ORD-0415',
  leftOn: '2026-10-21',
  branch: MASTER,
  lines: [{ productId: GLOVES.id, name: 'Gloves', nameAr: null, sku: 'GLV-1', units: '2' }],
};
const ON_OWNER: ShopSamplesOrder = {
  id: 'o-399',
  orderNo: 'ORD-0399',
  leftOn: '2026-10-10',
  branch: null,
  lines: [{ productId: CHAIN.id, name: 'Chain', nameAr: null, sku: 'CH-1', units: '1' }],
};
const AT_OLD: ShopSamplesOrder = {
  id: 'o-400',
  orderNo: 'ORD-0400',
  leftOn: '2026-10-12',
  branch: OLD,
  lines: [{ productId: CHAIN.id, name: 'Chain', nameAr: null, sku: 'CH-1', units: '3' }],
};

beforeEach(() => {
  post.mockReset();
  // Mokattam is the default and holds nothing: the owner's "third branch".
  branchesOf = {
    [ZOGMAR.id]: [
      branch('b-mok', 'Mokattam', true),
      branch(MASTER.id, 'Master'),
      branch(LS2.id, 'LS2'),
      branch(OLD.id, 'Old Street', false, true),
    ],
  };
  held = { [ZOGMAR.id]: [ON_OWNER, AT_OLD, AT_LS2, AT_MASTER], [NILE.id]: [ON_OWNER] };
});

function renderForm(opts: { locale?: 'en' | 'ar'; initial?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const locale = opts.locale ?? 'en';
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SaleOrderForm
            customers={[ZOGMAR, NILE]}
            products={[HELMET, GLOVES, CHAIN]}
            stock={[
              { productId: HELMET.id, availableStock: 20 },
              { productId: GLOVES.id, availableStock: 5 },
              { productId: CHAIN.id, availableStock: 10 },
            ]}
            title="New order"
            onCancel={() => {}}
            onSaved={() => {}}
            initialCustomerId={opts.initial ?? ZOGMAR.id}
          />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const hint = () => screen.getByTestId('samples-at-shop-hint');
const others = () => screen.queryByTestId('samples-other-branches');
const othersToggle = () => screen.getByTestId('samples-other-branches-toggle');
const lines = () => screen.getAllByTestId('sale-line');
const tags = () => screen.queryAllByTestId('sale-line-from-sample');
/** The order numbers listed above the "At other branches" heading. */
const hereOrders = () =>
  within(hint())
    .queryAllByTestId('samples-at-shop-order')
    .filter((o) => !others()?.contains(o))
    .map((o) => o.getAttribute('data-order-no'));
const otherOrders = () =>
  others()
    ? within(others()!)
        .queryAllByTestId('samples-at-shop-order')
        .map((o) => o.getAttribute('data-order-no'))
    : [];
const addButton = (orderNo: string) => {
  const order = screen
    .getAllByTestId('samples-at-shop-order')
    .find((o) => o.getAttribute('data-order-no') === orderNo)!;
  return within(order).getByTestId('samples-at-shop-add') as HTMLButtonElement;
};
const rowText = (orderNo: string) =>
  within(
    screen.getAllByTestId('samples-at-shop-order').find((o) => o.getAttribute('data-order-no') === orderNo)!,
  ).getByTestId('samples-at-shop-line').firstElementChild!.textContent;
function pickBranch(name: string) {
  fireEvent.click(within(screen.getByTestId('sale-branch')).getByRole('combobox'));
  fireEvent.click(screen.getByRole('option', { name: new RegExp(`^${name}`) }));
}
/** Wait for the branches and the samples to be on screen. */
const ready = () => waitFor(() => expect(others()).not.toBeNull());

describe('New Order — samples by branch', () => {
  it('the order on a branch holding none (the third branch): "No samples at Mokattam", every other branch collapsed under its count, nothing for Add all', async () => {
    renderForm();
    await ready();
    expect(screen.getByTestId('samples-none-here').textContent).toBe('No samples at Mokattam.');
    expect(hereOrders()).toEqual([]);
    // Collapsed: the heading and its count, no rows.
    expect(othersToggle().getAttribute('aria-expanded')).toBe('false');
    expect(othersToggle().textContent).toBe('At other branches (4 samples)');
    expect(otherOrders()).toEqual([]);
    expect(screen.queryByTestId('samples-at-shop-add-all')).toBeNull();

    fireEvent.click(othersToggle());
    expect(othersToggle().getAttribute('aria-expanded')).toBe('true');
    expect(otherOrders()).toEqual(['ORD-0399', 'ORD-0400', 'ORD-0412', 'ORD-0415']);
    // Each row names its branch; no branch reads as the owner; archived says so.
    expect(rowText('ORD-0412')).toBe('Helmet × 1 · LS2 · ORD-0412');
    expect(rowText('ORD-0415')).toBe('Gloves × 2 · Master · ORD-0415');
    expect(rowText('ORD-0399')).toBe('Chain × 1 · On the owner · ORD-0399');
    expect(rowText('ORD-0400')).toBe('Chain × 3 · Old Street · Archived · ORD-0400');
  });

  it('the order on one of the two: its samples first, the others still under the heading; Add all takes only its own', async () => {
    renderForm();
    await ready();
    pickBranch('LS2');
    expect(hereOrders()).toEqual(['ORD-0412']);
    expect(screen.queryByTestId('samples-none-here')).toBeNull();
    expect(othersToggle().textContent).toBe('At other branches (3 samples)');

    fireEvent.click(screen.getByTestId('samples-at-shop-add-all'));
    expect(lines()).toHaveLength(1);
    expect(tags().map((t) => t.textContent)).toEqual(['From sample ORD-0412 · 1 at the shop']);
    expect(tags()[0].hasAttribute('data-other-branch')).toBe(false);
    // Everything on its own branch is on: Add all goes, the others are still there.
    expect(screen.queryByTestId('samples-at-shop-add-all')).toBeNull();
    fireEvent.click(othersToggle());
    expect(addButton('ORD-0415').disabled).toBe(false);
  });

  it("another branch's sample can be added, one at a time — the line says whose it is, and it is sent like any sample", async () => {
    renderForm();
    await ready();
    fireEvent.click(othersToggle());
    fireEvent.click(addButton('ORD-0415'));
    fireEvent.click(addButton('ORD-0399'));
    expect(tags().map((t) => t.textContent)).toEqual([
      "From Master's samples ORD-0415 · 2 at the shop",
      "From the owner's samples ORD-0399 · 1 at the shop",
    ]);
    expect(tags().every((t) => t.getAttribute('data-other-branch') === 'true')).toBe(true);

    fireEvent.click(screen.getByTestId('sale-submit'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = post.mock.calls[0][1] as { branchId: string; items: Record<string, unknown>[] };
    expect(body.branchId).toBe('b-mok');
    expect(body.items).toEqual([
      { productId: GLOVES.id, quantity: 2, unitPrice: 150, discount: 0, fromSamplesOrderId: AT_MASTER.id },
      { productId: CHAIN.id, quantity: 1, unitPrice: 400, discount: 0, fromSamplesOrderId: ON_OWNER.id },
    ]);
  });

  it('the second visit: changing the branch regroups the list, keeps the lines already added and re-tags them', async () => {
    renderForm();
    await ready();
    fireEvent.click(othersToggle());
    fireEvent.click(addButton('ORD-0415'));
    expect(tags()[0].textContent).toBe("From Master's samples ORD-0415 · 2 at the shop");

    pickBranch('Master');
    expect(hereOrders()).toEqual(['ORD-0415']);
    expect(lines()).toHaveLength(1);
    expect(tags()[0].textContent).toBe('From sample ORD-0415 · 2 at the shop');
    expect(tags()[0].hasAttribute('data-other-branch')).toBe(false);
    // Already on: nothing left for Add all on Master.
    expect(screen.queryByTestId('samples-at-shop-add-all')).toBeNull();

    pickBranch('Mokattam');
    expect(hereOrders()).toEqual([]);
    expect(lines()).toHaveLength(1);
    expect(tags()[0].textContent).toBe("From Master's samples ORD-0415 · 2 at the shop");
    expect(tags()[0].getAttribute('data-other-branch')).toBe('true');
  });

  it('a customer with no branches: no heading, no branch on the rows, Add all takes everything — as before', async () => {
    held[NILE.id] = [ON_OWNER, { ...AT_LS2, branch: null }];
    renderForm({ initial: NILE.id });
    await waitFor(() => expect(screen.getAllByTestId('samples-at-shop-line')).toHaveLength(2));
    expect(others()).toBeNull();
    expect(screen.queryByTestId('samples-none-here')).toBeNull();
    expect(rowText('ORD-0399')).toBe('1 × Chain');
    fireEvent.click(screen.getByTestId('samples-at-shop-add-all'));
    expect(tags().map((t) => t.textContent)).toEqual([
      'From sample ORD-0399 · 1 at the shop',
      'From sample ORD-0412 · 1 at the shop',
    ]);
  });

  it('in Arabic: the heading, the owner and the tag', async () => {
    renderForm({ locale: 'ar' });
    await ready();
    expect(othersToggle().textContent).toBe('في فروع أخرى (4 عينات)');
    fireEvent.click(othersToggle());
    expect(rowText('ORD-0399')).toBe('Chain × 1 · على المالك · ORD-0399');
    fireEvent.click(addButton('ORD-0412'));
    expect(tags()[0].textContent).toBe('من عينات LS2 ORD-0412 · 1 عند المحل');
  });
});

describe('the samples hint in the office chat', () => {
  it('names the branch above each order; the owner’s has none', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
        <SamplesAtShopHint orders={[AT_LS2, ON_OWNER]} href={(o) => `/sales?order=${o.id}`} />
      </NextIntlClientProvider>,
    );
    const [ls2, owner] = screen.getAllByTestId('samples-at-shop-order');
    expect(within(ls2).getByTestId('samples-at-shop-branch').textContent).toBe('LS2');
    expect(within(owner).queryByTestId('samples-at-shop-branch')).toBeNull();
    expect(screen.queryByTestId('samples-other-branches')).toBeNull();
  });
});
