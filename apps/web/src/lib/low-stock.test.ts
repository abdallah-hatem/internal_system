import { describe, expect, it } from 'vitest';
import * as web from './low-stock';
// The server's own file — the definition this copy must agree with.
import * as server from '../../../api/src/common/low-stock';

/**
 * One rule, kept in two files (Next cannot import across apps).
 *
 * The dashboard's Low stock tile is counted by the API; the inventory list it
 * opens (`?stock=low`) filters and highlights with this copy. If the two ever
 * answer differently, the tile says 3 and the list shows 2. This runs both
 * over the same table and fails the moment one is changed without the other.
 */

type Case = [string, web.LowStockProduct | null | undefined, web.Quantity];

const cases: Case[] = [
  ['below the minimum', { status: 'ACTIVE', minStock: 5 }, 4],
  ['exactly at the minimum', { status: 'ACTIVE', minStock: 5 }, 5],
  ['at the minimum, decimals as text', { status: 'ACTIVE', minStock: '5.000' }, '5.000'],
  ['above the minimum', { status: 'ACTIVE', minStock: 5 }, 6],
  ['sold out under a minimum of 1', { status: 'ACTIVE', minStock: 1 }, 0],
  ['minimum 0, nothing left', { status: 'ACTIVE', minStock: 0 }, 0],
  ['no minimum, nothing left', { status: 'ACTIVE', minStock: null }, 0],
  ['minimum undefined', { status: 'ACTIVE' }, 0],
  ['inactive, nothing left', { status: 'INACTIVE', minStock: 5 }, 0],
  ['discontinued', { status: 'DISCONTINUED', minStock: 5 }, 0],
  ['status missing counts as active', { minStock: 5 }, 0],
  ['status null counts as active', { status: null, minStock: 5 }, 0],
  ['text compares as a number ("10" > "9")', { status: 'ACTIVE', minStock: '10' }, '9.5'],
  ['fractional just under', { status: 'ACTIVE', minStock: '2.5' }, '2.499'],
  ['a minimum that is not a number', { status: 'ACTIVE', minStock: 'abc' }, 0],
  ['no product', null, 0],
  ['product undefined', undefined, 0],
];

const batchSets = [
  [],
  [{ remainingQty: 4 }, { remainingQty: '3' }, { remainingQty: '2.500' }],
  [{ remainingQty: '0.001' }],
];

describe('low stock: the web copy equals the server', () => {
  it.each(cases)('%s', (_name, product, onHand) => {
    expect(web.isLowStock(product, onHand)).toBe(server.isLowStock(product, onHand));
  });

  it('the table is not one-sided: some are low, some are not', () => {
    const answers = cases.map(([, p, q]) => server.isLowStock(p, q));
    expect(answers.filter(Boolean).length).toBe(6);
    expect(answers.filter((a) => !a).length).toBe(cases.length - 6);
  });

  it('stock on hand sums every batch the same way', () => {
    for (const batches of batchSets) {
      expect(web.stockOnHand(batches)).toBe(server.stockOnHand(batches));
    }
    expect(web.stockOnHand(batchSets[1])).toBe(9.5);
  });
});

describe('isBelowMinStock — an inventory row by the same rule', () => {
  const row = (totalStock: web.Quantity, product: web.LowStockProduct | null) => ({
    totalStock,
    batches: [{ product: null }, { product }],
  });

  it.each(cases.filter(([, p]) => p))('%s', (_name, product, onHand) => {
    expect(web.isBelowMinStock(row(onHand, product ?? null))).toBe(
      server.isLowStock(product, onHand),
    );
  });

  it('a row with no batches, or none carrying a product, is not low', () => {
    expect(web.isBelowMinStock({ totalStock: 0 })).toBe(false);
    expect(web.isBelowMinStock({ totalStock: 0, batches: [] })).toBe(false);
    expect(web.isBelowMinStock({ totalStock: 0, batches: [{ product: null }] })).toBe(false);
  });
});
