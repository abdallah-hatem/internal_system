import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import { ToastProvider } from '@/components/ui/toast';
import type { CustomerBranch } from '@/lib/customer-branches';
import { SaleOrderForm, type SaleFormProduct } from './SaleOrderForm';

/**
 * New Order's branch (BUSINESS_LOGIC §7, owner 2026-10-25: "not required
 * because default to the default"). The picker starts on the customer's
 * default branch and can be changed; switching customer never carries the
 * last customer's branch into the order — not even while the new customer's
 * branches are still loading.
 */

const post = vi.fn();
/** Each customer's branches as the API lists them; a promise to hold one back. */
let branchesOf: Record<string, CustomerBranch[] | Promise<CustomerBranch[]>> = {};
vi.mock('@/lib/api', () => ({
  api: {
    get: async (path: string) => {
      const id = /^\/customers\/([^/]+)\/branches$/.exec(path)?.[1];
      const list = id ? await (branchesOf[id] ?? []) : [];
      return {
        data: { data: list, meta: { noBranchOwed: '0.00', totalOwed: '0.00' } },
      };
    },
    post: (path: string, ...args: unknown[]) => {
      if (path === '/sales/price-check') {
        return Promise.resolve({
          data: {
            data: {
              compared: false,
              lines: [],
              belowCostLines: 0,
              totalLossEgp: '0.00',
            },
          },
        });
      }
      post(path, ...args);
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

const OWNER = { id: 'c-owner', displayName: 'Ahmad Zogmar', type: 'B2B' };
const OTHER_OWNER = { id: 'c-other', displayName: 'Koshary', type: 'B2B' };
const PLAIN = { id: 'c-plain', displayName: 'Nile Motors', type: 'B2B' };
const NO_DEFAULT = {
  id: 'c-nodefault',
  displayName: 'Delta Spares',
  type: 'B2B',
};
const ONE_BRANCH = { id: 'c-one', displayName: 'Giza Bikes', type: 'B2B' };
const PISTON: SaleFormProduct = {
  id: 'p-piston',
  name: 'Piston kit',
  sku: 'PK-1',
  listPrices: {
    B2B: { amount: '1800.00', currency: 'EGP', source: 'SET' },
    B2C: null,
  },
};

beforeEach(() => {
  post.mockReset();
  branchesOf = {
    [OWNER.id]: [branch('b-mok', 'Mokattam', true), branch('b-master', 'Master'), branch('b-ls2', 'LS2')],
    [OTHER_OWNER.id]: [branch('b-dokki', 'Dokki'), branch('b-nasr', 'Nasr City', true)],
    [NO_DEFAULT.id]: [branch('b-a', 'Alpha'), branch('b-b', 'Beta')],
    [ONE_BRANCH.id]: [branch('b-only', 'Only one', true)],
  };
});
afterEach(cleanup);

function renderForm(initialCustomerId = OWNER.id) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SaleOrderForm
            customers={[OWNER, OTHER_OWNER, PLAIN, NO_DEFAULT, ONE_BRANCH]}
            products={[PISTON]}
            stock={[{ productId: PISTON.id, availableStock: 60 }]}
            title="New sale"
            onCancel={() => {}}
            onSaved={() => {}}
            initialCustomerId={initialCustomerId}
          />
        </ToastProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const branchPicker = () => within(screen.getByTestId('sale-branch')).getByRole('combobox');
const customerPicker = () => screen.getAllByRole('combobox')[0];

function chooseCustomer(name: string) {
  fireEvent.click(customerPicker());
  fireEvent.click(screen.getByRole('option', { name: new RegExp(name) }));
}

/** A product on the line, then Create & confirm; what was sent. */
async function sendOrder() {
  const line = screen.getAllByTestId('sale-line')[0];
  fireEvent.click(within(line).getByRole('combobox'));
  fireEvent.click(screen.getByRole('option', { name: /Piston kit/ }));
  fireEvent.click(screen.getByRole('button', { name: en.sales.createAndConfirm }));
  // The mutation sends on the next tick.
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  return post.mock.calls[0][1] as Record<string, unknown>;
}

describe('SaleOrderForm — the branch', () => {
  it('starts on the default branch and sends it', async () => {
    renderForm();
    await waitFor(() => expect(branchPicker().textContent).toContain('Mokattam'));
    expect(screen.getByTestId('sale-branch-hint').textContent).toMatch(/default branch/i);
    expect((await sendOrder()).branchId).toBe('b-mok');
  });

  it('sends the branch the person picked instead', async () => {
    renderForm();
    await waitFor(() => expect(branchPicker().textContent).toContain('Mokattam'));
    fireEvent.click(branchPicker());
    fireEvent.click(screen.getByRole('option', { name: /LS2/ }));
    expect((await sendOrder()).branchId).toBe('b-ls2');
  });

  it('switching to a customer with no branches drops the branch', async () => {
    renderForm();
    await waitFor(() => expect(branchPicker().textContent).toContain('Mokattam'));
    fireEvent.click(branchPicker());
    fireEvent.click(screen.getByRole('option', { name: /LS2/ }));
    chooseCustomer('Nile Motors');
    await waitFor(() => expect(screen.queryByTestId('sale-branch')).toBeNull());
    const body = await sendOrder();
    expect(body.customerId).toBe(PLAIN.id);
    expect(body).not.toHaveProperty('branchId');
  });

  it("switching to another owner starts on that owner's default, never the last one's branch", async () => {
    renderForm();
    await waitFor(() => expect(branchPicker().textContent).toContain('Mokattam'));
    chooseCustomer('Koshary');
    await waitFor(() => expect(branchPicker().textContent).toContain('Nasr City'));
    expect(await sendOrder()).toMatchObject({
      customerId: OTHER_OWNER.id,
      branchId: 'b-nasr',
    });
  });

  it("sends no stale branch while the new customer's branches are still loading", async () => {
    let release: (list: CustomerBranch[]) => void = () => {};
    branchesOf[OTHER_OWNER.id] = new Promise((resolve) => (release = resolve));
    renderForm();
    await waitFor(() => expect(branchPicker().textContent).toContain('Mokattam'));
    // A branch picked by hand for the first owner…
    fireEvent.click(branchPicker());
    fireEvent.click(screen.getByRole('option', { name: /LS2/ }));
    chooseCustomer('Koshary');
    const body = await sendOrder();
    expect(body.customerId).toBe(OTHER_OWNER.id);
    // Left to the server, which puts it on Koshary's own default.
    expect(body).not.toHaveProperty('branchId');
    await act(async () => release([branch('b-dokki', 'Dokki', true)]));
  });

  it('with no default branch the picker starts empty, says so, and sends none', async () => {
    renderForm(NO_DEFAULT.id);
    await waitFor(() => expect(screen.getByTestId('sale-branch')).toBeTruthy());
    expect(branchPicker().textContent).toMatch(/on the owner/i);
    expect(screen.getByTestId('sale-branch-hint').textContent).toMatch(/no default branch/i);
    expect(await sendOrder()).not.toHaveProperty('branchId');
  });

  it('a customer with one branch picks none: no picker', async () => {
    renderForm(ONE_BRANCH.id);
    // Give the branches time to arrive, then look.
    await act(async () => {});
    expect(screen.queryByTestId('sale-branch')).toBeNull();
  });

  it('never offers an archived branch', async () => {
    branchesOf[OWNER.id] = [
      branch('b-mok', 'Mokattam', true),
      branch('b-master', 'Master', false, true),
      branch('b-ls2', 'LS2'),
    ];
    renderForm();
    await waitFor(() => expect(branchPicker().textContent).toContain('Mokattam'));
    fireEvent.click(branchPicker());
    expect(screen.queryByRole('option', { name: /Master/ })).toBeNull();
  });
});
