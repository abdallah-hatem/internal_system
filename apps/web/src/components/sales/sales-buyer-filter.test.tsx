import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import en from '@/i18n/locales/en.json';
import type { CustomerBranch } from '@/lib/customer-branches';
import { SalesBuyerFilter } from './sales-buyer-filter';

/**
 * The Sales list's customer and branch filters (owner 2026-10-25): walk-in is
 * its own choice; a customer with branches shows them, with "On the owner";
 * another customer — even one whose branches are still loading — never shows
 * or keeps the last one's branch.
 */

let branchesOf: Record<string, CustomerBranch[] | Promise<CustomerBranch[]>> = {};
const asked: string[] = [];
vi.mock('@/lib/api', () => ({
  api: {
    get: async (path: string) => {
      asked.push(path);
      const id = /^\/customers\/([^/]+)\/branches$/.exec(path)?.[1];
      const list = id ? await (branchesOf[id] ?? []) : [];
      return { data: { data: list, meta: { noBranchOwed: '0.00', totalOwed: '0.00' } } };
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

const branch = (id: string, name: string, archived = false): CustomerBranch => ({
  id,
  name,
  address: null,
  phone: null,
  isDefault: false,
  archivedAt: archived ? '2026-10-20T10:00:00Z' : null,
  orderCount: 0,
  owed: '0.00',
});

const ZOGMAR = { id: 'c-zogmar', displayName: 'Ahmad Zogmar' };
const KOSHARY = { id: 'c-koshary', displayName: 'Koshary' };
const PLAIN = { id: 'c-plain', displayName: 'Nile Motors' };

/** The filters over a URL of their own; every change is recorded. */
const changes: Array<Record<string, string | null | undefined>> = [];
function Harness({ start }: { start: { customer: string; branch: string } }) {
  const [url, setUrl] = useState(start);
  return (
    <>
      <output data-testid="url">{`customer=${url.customer}&branch=${url.branch}`}</output>
      <SalesBuyerFilter
        customers={[ZOGMAR, KOSHARY, PLAIN]}
        customer={url.customer}
        branch={url.branch}
        onChange={(c) => {
          changes.push(c);
          setUrl((u) => ({
            customer: c.customer === undefined ? u.customer : (c.customer ?? ''),
            branch: c.branch ?? '',
          }));
        }}
      />
    </>
  );
}

function renderFilter(start = { customer: '', branch: '' }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <QueryClientProvider client={client}>
        <Harness start={start} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const customerPicker = () => within(screen.getByTestId('sales-customer-filter')).getByRole('combobox');
const branchFilter = () => screen.queryByTestId('sales-branch-filter');
const url = () => screen.getByTestId('url').textContent;

function choose(picker: HTMLElement, name: RegExp) {
  fireEvent.click(picker);
  fireEvent.click(screen.getByRole('option', { name }));
}

beforeEach(() => {
  changes.length = 0;
  asked.length = 0;
  branchesOf = {
    [ZOGMAR.id]: [branch('b-mok', 'Mokattam'), branch('b-master', 'Master'), branch('b-old', 'LS2', true)],
    [KOSHARY.id]: [branch('b-dokki', 'Dokki')],
  };
});
afterEach(cleanup);

describe('the Sales list customer filter', () => {
  it('walk-in is its own choice, beside every shop', () => {
    renderFilter();
    fireEvent.click(customerPicker());
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names[0]).toMatch(en.sales.walkInCustomer);
    expect(names.join('|')).toMatch(/Ahmad Zogmar.*Koshary.*Nile Motors/);
    fireEvent.click(screen.getAllByRole('option')[0]);
    expect(url()).toBe('customer=walk-in&branch=');
    // The walk-in buyer has no branches, and none are asked for.
    expect(branchFilter()).toBeNull();
    expect(asked).toEqual([]);
  });

  it('a customer with no branches shows no branch filter', async () => {
    renderFilter();
    choose(customerPicker(), /Nile Motors/);
    await waitFor(() => expect(asked).toContain(`/customers/${PLAIN.id}/branches`));
    await act(async () => {});
    expect(branchFilter()).toBeNull();
  });

  it('a customer with branches shows each of them and "On the owner"; one picked goes in the URL', async () => {
    renderFilter();
    choose(customerPicker(), /Ahmad Zogmar/);
    await waitFor(() => expect(branchFilter()).not.toBeNull());
    fireEvent.click(within(branchFilter()!).getByRole('combobox'));
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['Mokattam', 'Master', `LS2 (${en.branches.archivedTag})`, en.branches.noBranch]);
    fireEvent.click(screen.getByRole('option', { name: 'Master' }));
    expect(url()).toBe('customer=c-zogmar&branch=b-master');
  });

  it('another customer takes the branch off in the same change, and never shows the last one\'s branches', async () => {
    let release!: (b: CustomerBranch[]) => void;
    branchesOf[KOSHARY.id] = new Promise((r) => (release = r));
    renderFilter({ customer: ZOGMAR.id, branch: 'b-mok' });
    await waitFor(() => expect(branchFilter()).not.toBeNull());

    choose(customerPicker(), /Koshary/);
    // One change: the new customer and no branch — never Koshary with Mokattam.
    expect(changes).toEqual([{ customer: KOSHARY.id, branch: null }]);
    expect(url()).toBe('customer=c-koshary&branch=');
    // While Koshary's branches load, Zogmar's are not offered.
    expect(branchFilter()).toBeNull();

    await act(async () => release([branch('b-dokki', 'Dokki')]));
    await waitFor(() => expect(branchFilter()).not.toBeNull());
    fireEvent.click(within(branchFilter()!).getByRole('combobox'));
    expect(screen.queryByRole('option', { name: 'Mokattam' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Dokki' })).toBeTruthy();
  });

  it('back to the first customer (the second visit) shows its branches again, none picked', async () => {
    renderFilter({ customer: ZOGMAR.id, branch: 'b-mok' });
    await waitFor(() => expect(branchFilter()).not.toBeNull());
    choose(customerPicker(), /Nile Motors/);
    await waitFor(() => expect(branchFilter()).toBeNull());
    choose(customerPicker(), /Ahmad Zogmar/);
    await waitFor(() => expect(branchFilter()).not.toBeNull());
    expect(url()).toBe('customer=c-zogmar&branch=');
  });

  it('clearing the customer clears the branch too', async () => {
    renderFilter({ customer: ZOGMAR.id, branch: 'b-mok' });
    await waitFor(() => expect(branchFilter()).not.toBeNull());
    // The picker's own clear (×), pressed as a pointer does.
    fireEvent.pointerDown(within(screen.getByTestId('sales-customer-filter')).getByRole('button', { name: 'Clear' }));
    expect(changes.at(-1)).toEqual({ customer: null, branch: null });
    expect(url()).toBe('customer=&branch=');
    expect(branchFilter()).toBeNull();
  });
});
