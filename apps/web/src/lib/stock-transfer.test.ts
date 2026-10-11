import { describe, expect, it } from 'vitest';
import * as api from '../../../api/src/common/stock-transfers';
import { canMoveFrom, moveCost, TRANSFER_SOURCE_STATUSES, TRANSFER_TARGET_REFUSED, transferTargets } from './stock-transfer';

/**
 * L5 — the web offers "Move leftovers" and lists target cycles from copies of
 * the server's status lists. They are compared here so the button can never be
 * offered where the server refuses, nor hidden where it would accept.
 */
describe('the copies agree with the server', () => {
  it('source statuses', () => {
    expect([...TRANSFER_SOURCE_STATUSES]).toEqual([...api.TRANSFER_SOURCE_STATUSES]);
  });
  it('refused target statuses', () => {
    expect([...TRANSFER_TARGET_REFUSED]).toEqual([...api.TRANSFER_TARGET_REFUSED]);
  });
});

describe('where Move leftovers is offered, and to which cycles', () => {
  it.each([
    ['SELLING', true],
    ['SETTLEMENT', true],
    ['VERIFICATION', false],
    ['CLOSED', false],
    [undefined, false],
  ])('a cycle %s: %s', (status, expected) => {
    expect(canMoveFrom(status)).toBe(expected);
  });

  it('targets leave out the cycle itself and every settling, closed or cancelled one', () => {
    const cycles = ['SELLING', 'PLANNING', 'SETTLEMENT', 'CLOSED', 'CANCELLED', 'ARRIVED_EGYPT'].map((status, i) => ({ id: `c${i}`, status }));
    expect(transferTargets(cycles, 'c0').map((c) => c.status)).toEqual(['PLANNING', 'ARRIVED_EGYPT']);
  });
});

describe('the cost shown before moving', () => {
  const product = {
    batches: [
      { id: 'old', available: '10.000', unitCostEgp: '110.0000', arrivedOn: null },
      { id: 'new', available: '15.000', unitCostEgp: '120.5000', arrivedOn: null },
    ],
  };
  it('takes the oldest batch first, each at its own cost — what the server will write', () => {
    expect(moveCost(product, 12)).toBe(1341);
    const lines = api.planTransferLines(
      product.batches.map((b, i) => ({
        id: b.id,
        productId: 'p',
        productName: 'Brake pad',
        saleableQty: b.available,
        heldQty: 0,
        landedUnitCostEgp: b.unitCostEgp,
        createdAt: new Date(Date.UTC(2026, 8, i + 1)),
      })),
      [{ productId: 'p', qty: 12 }],
    );
    expect(Number(api.transferTotalEgp(lines).toFixed(2))).toBe(moveCost(product, 12));
  });
  it('nothing for nothing', () => {
    expect(moveCost(product, 0)).toBe(0);
  });
});
