import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { BatchMovementList, type BatchMovement } from './batch-movements';

/**
 * A batch's movements say who each went to and at what price (owner
 * 2026-11-06: "in movement I want to see the customer name and the price").
 * The API resolves both; this only says them.
 */

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const base = { occurredAt: '2026-11-01T10:00:00Z', referenceId: null };
const MOVEMENTS: BatchMovement[] = [
  {
    ...base, id: 'm-receive', movementType: 'RECEIVE', qtyDelta: '10', referenceType: 'PURCHASE_ORDER_ITEM',
    reference: { number: 'PO-2026-0003', purchaseOrderId: 'po-3' },
    customerName: null, walkIn: false, branchName: null, unitPrice: '412.50', priceKind: 'cost', currency: 'EGP',
  },
  {
    ...base, id: 'm-sale', movementType: 'SALE', qtyDelta: '-3', referenceType: 'SALE_ORDER',
    reference: { number: 'ORD-2026-0101', saleOrderId: 'so-1' },
    customerName: 'Koshary Motors', walkIn: false, branchName: 'Shubra', unitPrice: '966.67', priceKind: 'sale', currency: 'EGP',
  },
  {
    ...base, id: 'm-return', movementType: 'RETURN', qtyDelta: '1', referenceType: 'SALE_RETURN',
    reference: { number: 'RET-2026-0009', saleOrderId: 'so-1' },
    customerName: 'Koshary Motors', walkIn: false, branchName: 'Shubra', unitPrice: '20.50', priceKind: 'refund', currency: 'USD',
  },
  {
    ...base, id: 'm-samples', movementType: 'SAMPLE_OUT', qtyDelta: '-2', referenceType: 'SAMPLES_ORDER',
    reference: { number: 'ORD-2026-0103', saleOrderId: 'so-3' },
    customerName: 'Ali Shop', walkIn: false, branchName: null, unitPrice: null, priceKind: null, currency: null,
  },
  {
    ...base, id: 'm-walkin', movementType: 'SALE', qtyDelta: '-1', referenceType: 'SALE_ORDER',
    reference: { number: 'ORD-2026-0102', saleOrderId: 'so-2' },
    customerName: null, walkIn: true, branchName: null, unitPrice: '750.00', priceKind: 'sale', currency: 'EGP',
  },
  {
    ...base, id: 'm-adjust', movementType: 'ADJUSTMENT', qtyDelta: '-1', referenceType: null, reference: null,
    customerName: null, walkIn: false, branchName: null, unitPrice: null, priceKind: null, currency: null,
  },
];

afterEach(cleanup);

function renderList(layout: 'table' | 'cards', locale: 'en' | 'ar' = 'en', movements = MOVEMENTS, loading = false) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <BatchMovementList movements={movements} loading={loading} layout={layout} />
    </NextIntlClientProvider>,
  );
}

const rowOf = (id: string) => {
  const rows = screen.getAllByTestId('batch-movement');
  return rows[MOVEMENTS.findIndex((m) => m.id === id)];
};

describe.each(['table', 'cards'] as const)('movements as %s', (layout) => {
  it('a sale names the customer and branch, and the price charged', () => {
    renderList(layout);
    const row = rowOf('m-sale');
    expect(within(row).getByTestId('movement-customer').textContent).toContain('Koshary Motors');
    expect(within(row).getByTestId('movement-branch').textContent).toBe('Shubra');
    const price = within(row).getByTestId('movement-price');
    expect(price.getAttribute('data-kind')).toBe('sale');
    expect(price.textContent).toBe('966.67 EGP');
    expect(within(row).queryByTestId('movement-cost-label')).toBeNull();
  });

  it('a return names the order’s customer and the refund, in the order’s currency', () => {
    renderList(layout);
    const row = rowOf('m-return');
    expect(within(row).getByTestId('movement-customer').textContent).toContain('Koshary Motors');
    expect(within(row).getByTestId('movement-price').textContent).toBe('20.50 USD');
  });

  it('a receipt’s figure is marked as cost, never read as a selling price', () => {
    renderList(layout);
    const row = rowOf('m-receive');
    const price = within(row).getByTestId('movement-price');
    expect(price.getAttribute('data-kind')).toBe('cost');
    expect(within(price).getByTestId('movement-cost-label').textContent).toBe(en.inventory.movementCost);
    expect(price.textContent).toBe('412.50 EGP cost');
    // No customer on a receipt.
    expect(within(row).queryByTestId('movement-customer')).toBeNull();
  });

  it('samples and other movements have no price: "—"', () => {
    renderList(layout);
    expect(within(rowOf('m-samples')).getByTestId('movement-customer').textContent).toContain('Ali Shop');
    expect(within(rowOf('m-samples')).getByTestId('movement-price').textContent).toBe('—');
    expect(within(rowOf('m-adjust')).getByTestId('movement-price').textContent).toBe('—');
    expect(within(rowOf('m-adjust')).queryByTestId('movement-customer')).toBeNull();
  });

  it('a walk-in sale says Walk-in', () => {
    renderList(layout);
    expect(within(rowOf('m-walkin')).getByTestId('movement-customer').textContent).toBe(en.inventory.movementWalkIn);
  });

  it('in Arabic: the labels translate, the amounts stay isolated left-to-right', () => {
    renderList(layout, 'ar');
    const walkIn = within(rowOf('m-walkin')).getByTestId('movement-customer');
    expect(walkIn.textContent).toBe(ar.inventory.movementWalkIn);
    const cost = within(rowOf('m-receive')).getByTestId('movement-price');
    expect(within(cost).getByTestId('movement-cost-label').textContent).toBe(ar.inventory.movementCost);
    const money = cost.querySelector('[data-slot="money"]')!;
    expect(money.getAttribute('dir')).toBe('ltr');
    expect(money.textContent).toBe('412.50 EGP');
  });

  it('loading shows skeleton rows, not the list', () => {
    renderList(layout, 'en', [], true);
    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(2);
    expect(screen.queryByTestId('batch-movement')).toBeNull();
  });
});

describe('the table', () => {
  it('has a Customer and a Price column, in both languages', () => {
    renderList('table');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual([
      en.inventory.movementColumn, en.inventory.movementCustomer, en.inventory.movementPrice,
      en.inventory.movementRecord, en.inventory.movementDate,
    ]);
    cleanup();
    renderList('table', 'ar');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      ar.inventory.movementColumn, ar.inventory.movementCustomer, ar.inventory.movementPrice,
      ar.inventory.movementRecord, ar.inventory.movementDate,
    ]);
  });

  it('goes through the shared table, the price column never wrapping', () => {
    renderList('table');
    const table = screen.getByTestId('batch-movements');
    expect(table.getAttribute('data-slot')).toBe('data-table');
    const price = within(rowOf('m-sale')).getByTestId('movement-price');
    expect(price.className).toContain('whitespace-nowrap');
  });

  it('the skeleton has a cell for every column', () => {
    renderList('table', 'en', [], true);
    const [row] = screen.getAllByTestId('skeleton-row');
    expect(row.querySelectorAll('td')).toHaveLength(5);
  });
});

it('every new label is in both languages', () => {
  for (const key of ['movementColumn', 'movementCustomer', 'movementPrice', 'movementRecord', 'movementDate', 'movementWalkIn', 'movementCost', 'movementCostHint', 'movementPriceHint'] as const) {
    expect(en.inventory[key]).toBeTruthy();
    expect(ar.inventory[key]).toBeTruthy();
    expect(ar.inventory[key]).not.toBe(en.inventory[key]);
  }
});
