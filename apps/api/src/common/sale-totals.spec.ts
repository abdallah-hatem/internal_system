import {
  centsToDecimalString,
  saleLineTotals,
  saleOrderTotals,
} from './sale-totals';

describe('sale totals — the one formula', () => {
  it('rounds the gross to the cent, then takes the discount off', () => {
    expect(
      saleLineTotals({ quantity: 3, unitPrice: 33.33, discount: 0.99 }),
    ).toEqual({
      grossCents: 9999,
      discountCents: 99,
      lineTotalCents: 9900,
    });
  });

  it('does not drift in binary: 0.1 × 3 is 0.30, 1.255 units are 1.255', () => {
    expect(saleLineTotals({ quantity: 3, unitPrice: 0.1 }).lineTotalCents).toBe(
      30,
    );
    expect(
      saleLineTotals({ quantity: 1.255, unitPrice: 1000 }).grossCents,
    ).toBe(125500);
  });

  it('a discount larger than the line gives a negative line, for the caller to refuse', () => {
    expect(
      saleLineTotals({ quantity: 1, unitPrice: 100, discount: 9999 })
        .lineTotalCents,
    ).toBe(-989900);
  });

  it('accepts the strings Prisma Decimals serialise to', () => {
    expect(
      saleLineTotals({
        quantity: '2.000',
        unitPrice: '12.50',
        discount: '1.00',
      }),
    ).toEqual({
      grossCents: 2500,
      discountCents: 100,
      lineTotalCents: 2400,
    });
  });

  it('empty or junk fields count as zero, never NaN', () => {
    expect(
      saleLineTotals({ quantity: '', unitPrice: 'abc', discount: null })
        .lineTotalCents,
    ).toBe(0);
  });

  it('sums the lines', () => {
    expect(
      saleOrderTotals([
        { quantity: 3, unitPrice: 33.33, discount: 0.99 },
        { quantity: 1.255, unitPrice: 19.99, discount: 5 },
      ]).subtotalCents,
    ).toBe(11909);
  });

  it('writes cents as a NUMERIC(18,2) string', () => {
    expect(centsToDecimalString(11909)).toBe('119.09');
    expect(centsToDecimalString(5)).toBe('0.05');
    expect(centsToDecimalString(0)).toBe('0.00');
    expect(centsToDecimalString(-989900)).toBe('-9899.00');
  });
});
