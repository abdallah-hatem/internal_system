import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import en from '@/i18n/locales/en.json';
import { SalesBuyerFilter } from './sales-buyer-filter';

/**
 * The Sales list's customer filter (owner 2026-10-25): walk-in is its own
 * choice beside every shop; picking, changing and clearing each write the URL
 * once, and a second visit starts from what the URL says.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

const ZOGMAR = { id: 'c-zogmar', displayName: 'Ahmad Zogmar' };
const KOSHARY = { id: 'c-koshary', displayName: 'Koshary' };
const PLAIN = { id: 'c-plain', displayName: 'Nile Motors' };

/** The filter over a URL of its own; every change is recorded. */
const changes: Array<{ customer: string | null }> = [];
function Harness({ start }: { start: string }) {
  const [customer, setCustomer] = useState(start);
  return (
    <>
      <output data-testid="url">{`customer=${customer}`}</output>
      <SalesBuyerFilter
        customers={[ZOGMAR, KOSHARY, PLAIN]}
        customer={customer}
        onChange={(c) => {
          changes.push(c);
          setCustomer(c.customer ?? '');
        }}
      />
    </>
  );
}

function renderFilter(start = '') {
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <Harness start={start} />
    </NextIntlClientProvider>,
  );
}

const customerPicker = () => within(screen.getByTestId('sales-customer-filter')).getByRole('combobox');
const url = () => screen.getByTestId('url').textContent;

function choose(name: RegExp) {
  fireEvent.click(customerPicker());
  fireEvent.click(screen.getByRole('option', { name }));
}

beforeEach(() => {
  changes.length = 0;
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
    expect(url()).toBe('customer=walk-in');
  });

  it('a shop picked goes in the URL, and another replaces it in one change', () => {
    renderFilter();
    choose(/Ahmad Zogmar/);
    expect(url()).toBe('customer=c-zogmar');
    choose(/Koshary/);
    expect(changes).toEqual([{ customer: ZOGMAR.id }, { customer: KOSHARY.id }]);
    expect(url()).toBe('customer=c-koshary');
  });

  it('the second visit shows the shop the URL names', () => {
    renderFilter(PLAIN.id);
    expect(customerPicker().textContent).toMatch(/Nile Motors/);
  });

  it('clearing the customer takes it off the URL', () => {
    renderFilter(ZOGMAR.id);
    // The picker's own clear (×), pressed as a pointer does.
    fireEvent.pointerDown(within(screen.getByTestId('sales-customer-filter')).getByRole('button', { name: 'Clear' }));
    expect(changes.at(-1)).toEqual({ customer: null });
    expect(url()).toBe('customer=');
  });
});
