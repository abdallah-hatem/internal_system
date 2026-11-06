import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ReturnRefundMethod, returnRefund, type ReturnableOrder } from './return-refund-method';

/**
 * The return dialog's refund method (BUSINESS_LOGIC §5, owner 2026-11-06): a
 * credit note can only lower what the order still owes. ORD-2026-00016 was
 * paid in full, returned whole on the default credit note, and the 2,000
 * vanished. Quantities are typed into an input as the dialog's are, the
 * picker is opened and clicked as a person does, and each test reads the
 * hidden `refundMethod` the form submits and what is shown.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

/** ORD-2026-00016: four units for 2,000. */
const order = (over: Partial<ReturnableOrder> = {}): ReturnableOrder => ({
  outstanding: '0.00',
  currency: 'EGP',
  customer: { isWalkIn: false },
  items: [{ id: 'line-1', quantity: '4', lineTotal: '2000.00', priceCut: false, unitPriceNow: '500.00' }],
  ...over,
});

/** The dialog's quantity box and the picker under it, as the page wires them. */
function Dialog({ o }: { o: ReturnableOrder }) {
  const [qty, setQty] = useState<Record<string, string>>({});
  return (
    <form>
      <input
        aria-label="qty"
        type="number"
        value={qty['line-1'] ?? ''}
        onChange={(e) => setQty({ 'line-1': e.target.value })}
      />
      <ReturnRefundMethod order={o} qty={qty} />
    </form>
  );
}

function open(o: ReturnableOrder, locale: 'en' | 'ar' = 'en') {
  const { container } = render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <Dialog o={o} />
    </NextIntlClientProvider>,
  );
  return {
    type: (v: string) => fireEvent.change(screen.getByLabelText('qty'), { target: { value: v } }),
    method: () => (container.querySelector('input[name="refundMethod"]') as HTMLInputElement).value,
    hint: () => screen.queryByTestId('credit-over-owed'),
    pick: (label: string) => {
      fireEvent.click(screen.getByRole('combobox'));
      fireEvent.click(screen.getByRole('option', { name: new RegExp(label) }));
    },
  };
}

describe('return refund method — a credit note only lowers what is owed', () => {
  it('paid in full: the lines picked switch it to Cash, the credit note is disabled, and the reason is shown', () => {
    const d = open(order());
    d.type('4');
    expect(d.method()).toBe('CASH');
    expect(d.hint()?.textContent).toContain(en.sales.creditOverOwedPaid);
    fireEvent.click(screen.getByRole('combobox'));
    expect(
      screen.getByRole('option', { name: new RegExp(en.sales.creditNote) }).getAttribute('aria-disabled'),
    ).toBe('true');
    // Clicking it anyway changes nothing.
    fireEvent.click(screen.getByRole('option', { name: new RegExp(en.sales.creditNote) }));
    expect(d.method()).toBe('CASH');
  });

  it('unpaid: still a credit note by default, no hint', () => {
    const d = open(order({ outstanding: '2000.00' }));
    d.type('4');
    expect(d.method()).toBe('CREDIT_NOTE');
    expect(d.hint()).toBeNull();
  });

  it('partly paid, 500 owed: one unit (500) fits on credit; a second unit does not, and says what is owed', () => {
    const d = open(order({ outstanding: '500.00' }));
    d.type('1');
    expect(d.method()).toBe('CREDIT_NOTE');
    d.type('2');
    expect(d.method()).toBe('CASH');
    expect(d.hint()?.textContent).toContain('500.00 EGP');
    // Back to one: the credit note is allowed again and comes back.
    d.type('1');
    expect(d.method()).toBe('CREDIT_NOTE');
    expect(d.hint()).toBeNull();
  });

  it('a Cash the partner picked is kept when the quantity changes', () => {
    const d = open(order({ outstanding: '2000.00' }));
    d.type('1');
    d.pick(en.sales.cashRefund);
    expect(d.method()).toBe('CASH');
    d.type('2');
    expect(d.method()).toBe('CASH');
  });

  it('walk-in: Cash only, no credit note offered, no hint', () => {
    const d = open(order({ customer: { isWalkIn: true } }));
    d.type('1');
    expect(d.method()).toBe('CASH');
    expect(d.hint()).toBeNull();
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('option', { name: new RegExp(en.sales.creditNote) })).toBeNull();
  });

  it('in Arabic the reason is in Arabic', () => {
    const d = open(order(), 'ar');
    d.type('4');
    expect(d.hint()?.textContent).toContain(ar.sales.creditOverOwedPaid);
  });

  it('the refund is worked out as the API does: the line total over its quantity, or the cut price', () => {
    expect(returnRefund(order(), { 'line-1': '4' })).toBe(2000);
    // A line discount: 3 for 1,000 refunds 333.33 a unit, 666.67 for two.
    expect(
      returnRefund(order({ items: [{ id: 'line-1', quantity: '3', lineTotal: '1000.00' }] }), { 'line-1': '2' }),
    ).toBe(666.67);
    expect(
      returnRefund(
        order({ items: [{ id: 'line-1', quantity: '4', lineTotal: '2000.00', priceCut: true, unitPriceNow: '400.00' }] }),
        { 'line-1': '1' },
      ),
    ).toBe(400);
    expect(returnRefund(order(), {})).toBe(0);
  });
});
