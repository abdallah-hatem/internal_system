import type { Prisma } from '@prisma/client';
import { stockValueEgp } from './stock-value';

describe('stockValueEgp — remaining units × landed cost, to the piastre', () => {
  it('sums every batch at its own landed cost', () => {
    expect(
      stockValueEgp([
        { remainingQty: 20, landedUnitCostEgp: '1523.50' },
        { remainingQty: 40, landedUnitCostEgp: '1800.50' },
      ]),
    ).toBe(102490);
  });

  it('an empty batch adds nothing; no batches is zero', () => {
    expect(stockValueEgp([{ remainingQty: 0, landedUnitCostEgp: 999 }])).toBe(
      0,
    );
    expect(stockValueEgp([])).toBe(0);
  });

  it('is exact where floats are not: three batches of 1 at 0.1 is 0.30', () => {
    const b = { remainingQty: 1, landedUnitCostEgp: '0.1' };
    expect(stockValueEgp([b, b, b])).toBe(0.3);
  });

  it('rounds half up to the piastre, once, on the total', () => {
    // 3 × 0.335 = 1.005 → 1.01; rounding each line first would give 3 × 0.34 = 1.02.
    expect(
      stockValueEgp([{ remainingQty: 3, landedUnitCostEgp: '0.335' }]),
    ).toBe(1.01);
  });

  it('takes Prisma Decimals as stored (read through their own toFixed)', () => {
    const dec = (v: string) =>
      ({
        toFixed: (p: number) => Number(v).toFixed(p),
      }) as unknown as Prisma.Decimal;
    expect(
      stockValueEgp([
        { remainingQty: dec('2.500'), landedUnitCostEgp: dec('10.00') },
      ]),
    ).toBe(25);
  });
});
