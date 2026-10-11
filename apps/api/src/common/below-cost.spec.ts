import { type CostLayer, priceAgainstCost, unitFigure } from './below-cost';

/**
 * Selling below cost (BUSINESS_LOGIC §4, DECIDED 2026-10-11 by the owner): a
 * warning, never a refusal. "Cost" is what the sale would draw under FIFO —
 * the oldest received batches first, the weighted cost of exactly the units a
 * line takes — compared with the line after its discount, both in cents and
 * rounded the way the confirmed sale's COGS is.
 */

const layers = (entries: Record<string, CostLayer[]>) =>
  new Map(Object.entries(entries));

describe('priceAgainstCost — one line, one batch', () => {
  it('the helmets: 90 at 1,000 against 2,616.6667 landed is a loss of 145,500.00', () => {
    const r = priceAgainstCost(
      [{ productId: 'helmet', quantity: 90, unitPrice: 1000 }],
      layers({ helmet: [{ qty: 120, unitCostEgp: '2616.6667' }] }),
    );
    expect(r.lines[0]).toMatchObject({
      costed: true,
      belowCost: true,
      costCents: 23_550_000, // 90 × 2,616.6667 = 235,500.003 → 235,500.00
      netCents: 9_000_000,
      lossCents: 14_550_000,
    });
    expect(unitFigure(r.lines[0].costCents, 90)).toBe('2616.67');
    expect(r.totalLossCents).toBe(14_550_000);
  });

  it('above cost is not a warning', () => {
    const r = priceAgainstCost(
      [{ productId: 'pad', quantity: 10, unitPrice: 150 }],
      layers({ pad: [{ qty: 40, unitCostEgp: 120 }] }),
    );
    expect(r.lines[0]).toMatchObject({
      costed: true,
      belowCost: false,
      lossCents: 0,
    });
    expect(r.totalLossCents).toBe(0);
  });
});

describe('priceAgainstCost — a line spanning two batches (TC-INV-30: 2 at 900, then 1 at 1,100)', () => {
  const shelf = () =>
    layers({
      p: [
        { qty: 2, unitCostEgp: 900 },
        { qty: 5, unitCostEgp: 1100 },
      ],
    });

  it('3 at 950: the three units cost 2,900 together, so the line loses 50', () => {
    const r = priceAgainstCost(
      [{ productId: 'p', quantity: 3, unitPrice: 950 }],
      shelf(),
    );
    expect(r.lines[0]).toMatchObject({
      costCents: 290_000,
      netCents: 285_000,
      lossCents: 5_000,
      belowCost: true,
    });
    expect(unitFigure(r.lines[0].costCents, 3)).toBe('966.67');
  });

  it('3 at 1,000 is above the weighted cost, though below the newer batch — no warning', () => {
    const r = priceAgainstCost(
      [{ productId: 'p', quantity: 3, unitPrice: 1000 }],
      shelf(),
    );
    expect(r.lines[0]).toMatchObject({ costCents: 290_000, belowCost: false });
  });

  it('a second line of the same product draws after the first: 2 at 1,000 then 1 at 1,000 → only the second is below cost', () => {
    const r = priceAgainstCost(
      [
        { productId: 'p', quantity: 2, unitPrice: 1000 },
        { productId: 'p', quantity: 1, unitPrice: 1000 },
      ],
      shelf(),
    );
    expect(r.lines.map((l) => [l.costCents, l.belowCost])).toEqual([
      [180_000, false],
      [110_000, true],
    ]);
    expect(r.totalLossCents).toBe(10_000);
  });
});

describe('priceAgainstCost — the discount counts', () => {
  it('10 at 130 is above a 120 cost; a 150 line discount takes it to 1,150 against 1,200', () => {
    const shelf = layers({ pad: [{ qty: 40, unitCostEgp: 120 }] });
    const without = priceAgainstCost(
      [{ productId: 'pad', quantity: 10, unitPrice: 130 }],
      shelf,
    );
    expect(without.lines[0].belowCost).toBe(false);

    const discounted = priceAgainstCost(
      [{ productId: 'pad', quantity: 10, unitPrice: 130, discount: 150 }],
      shelf,
    );
    expect(discounted.lines[0]).toMatchObject({
      netCents: 115_000,
      costCents: 120_000,
      lossCents: 5_000,
      belowCost: true,
    });
    expect(unitFigure(discounted.lines[0].netCents, 10)).toBe('115.00');
  });
});

describe('priceAgainstCost — exactly at cost, and rounding at the edge', () => {
  it('exactly at cost is not below it', () => {
    const r = priceAgainstCost(
      [{ productId: 'pad', quantity: 10, unitPrice: 120 }],
      layers({ pad: [{ qty: 40, unitCostEgp: '120.0000' }] }),
    );
    expect(r.lines[0]).toMatchObject({
      costCents: 120_000,
      netCents: 120_000,
      belowCost: false,
      lossCents: 0,
    });
  });

  it('the weighted cost shown as 966.67: selling 3 at 966.67 (2,900.01) is not a warning; at 966.66 (2,899.98) it is, by 0.02', () => {
    const shelf = layers({
      p: [
        { qty: 2, unitCostEgp: 900 },
        { qty: 5, unitCostEgp: 1100 },
      ],
    });
    const at = priceAgainstCost(
      [{ productId: 'p', quantity: 3, unitPrice: 966.67 }],
      shelf,
    );
    expect(at.lines[0].belowCost).toBe(false);
    const under = priceAgainstCost(
      [{ productId: 'p', quantity: 3, unitPrice: 966.66 }],
      shelf,
    );
    expect(under.lines[0]).toMatchObject({ belowCost: true, lossCents: 2 });
  });

  it('a four-place cost under half a cent rounds the way COGS is stored: 100.0049 sold at 100.00 is no loss (a per-unit comparison would warn here)', () => {
    const r = priceAgainstCost(
      [{ productId: 'x', quantity: 1, unitPrice: 100 }],
      layers({ x: [{ qty: 5, unitCostEgp: '100.0049' }] }),
    );
    expect(r.lines[0]).toMatchObject({ costCents: 10_000, belowCost: false });
  });

  it('selling at the cost as it is shown (2,616.67) is not a warning: 90 × 2,616.67 = 235,500.30 against 235,500.00', () => {
    // 2,616.67 × 90 = 235,500.30 against a cost of 235,500.00 — 30 piastres up.
    const r = priceAgainstCost(
      [{ productId: 'helmet', quantity: 90, unitPrice: 2616.67 }],
      layers({ helmet: [{ qty: 120, unitCostEgp: '2616.6667' }] }),
    );
    expect(r.lines[0]).toMatchObject({ belowCost: false, lossCents: 0 });
  });

  it('cost is summed per batch, each rounded to the cent, as confirming records each allocation', () => {
    // 1 × 0.005 → 0.01 and 1 × 0.005 → 0.01 = 0.02, where one rounding of the
    // sum (0.010) would say 0.01. The sale's COGS is the per-allocation sum.
    const r = priceAgainstCost(
      [{ productId: 'x', quantity: 2, unitPrice: 0.01 }],
      layers({
        x: [
          { qty: 1, unitCostEgp: '0.0050' },
          { qty: 1, unitCostEgp: '0.0050' },
        ],
      }),
    );
    expect(r.lines[0]).toMatchObject({
      costCents: 2,
      netCents: 2,
      belowCost: false,
    });
  });

  it('a large line does not lose precision (100,000 × 2,616.6667)', () => {
    const r = priceAgainstCost(
      [{ productId: 'h', quantity: 100_000, unitPrice: 2616.66 }],
      layers({ h: [{ qty: 100_000, unitCostEgp: '2616.6667' }] }),
    );
    expect(r.lines[0].costCents).toBe(26_166_667_000);
    expect(r.lines[0].lossCents).toBe(26_166_667_000 - 26_166_600_000);
  });
});

describe('priceAgainstCost — nothing to compare against is no warning', () => {
  it('no stock at all: not costed, no warning', () => {
    const r = priceAgainstCost(
      [{ productId: 'chain', quantity: 1, unitPrice: 1 }],
      layers({}),
    );
    expect(r.lines[0]).toMatchObject({
      costed: false,
      belowCost: false,
      lossCents: 0,
      reason: 'NO_STOCK',
    });
    expect(r.totalLossCents).toBe(0);
  });

  it('more than is on the shelf: not costed — confirming refuses it anyway', () => {
    const r = priceAgainstCost(
      [{ productId: 'pad', quantity: 41, unitPrice: 1 }],
      layers({ pad: [{ qty: 40, unitCostEgp: 120 }] }),
    );
    expect(r.lines[0]).toMatchObject({
      costed: false,
      belowCost: false,
      reason: 'NO_STOCK',
    });
  });

  it('a line still being typed (no product, zero or negative quantity, no price) is not costed and draws nothing', () => {
    const shelf = layers({ pad: [{ qty: 1, unitCostEgp: 120 }] });
    const r = priceAgainstCost(
      [
        { productId: '', quantity: 1, unitPrice: 1 },
        { productId: 'pad', quantity: 0, unitPrice: 1 },
        { productId: 'pad', quantity: -3, unitPrice: 1 },
        { productId: 'pad', quantity: 'abc', unitPrice: 1 },
        // The one real line still gets the single unit.
        { productId: 'pad', quantity: 1, unitPrice: 100 },
      ],
      shelf,
    );
    expect(
      r.lines
        .slice(0, 4)
        .every((l) => !l.costed && !l.belowCost && l.reason === 'INCOMPLETE'),
    ).toBe(true);
    expect(r.lines[4]).toMatchObject({
      costed: true,
      belowCost: true,
      lossCents: 2_000,
    });
  });

  it('a free line (price 0) on stock that cost something is below cost — a gift is still a loss', () => {
    const r = priceAgainstCost(
      [{ productId: 'pad', quantity: 2, unitPrice: 0 }],
      layers({ pad: [{ qty: 5, unitCostEgp: 120 }] }),
    );
    expect(r.lines[0]).toMatchObject({ belowCost: true, lossCents: 24_000 });
  });

  it('stock that cost nothing (a batch at 0) is never below cost', () => {
    const r = priceAgainstCost(
      [{ productId: 'pad', quantity: 2, unitPrice: 0 }],
      layers({ pad: [{ qty: 5, unitCostEgp: 0 }] }),
    );
    expect(r.lines[0].belowCost).toBe(false);
  });

  it('the shelf it is given is not changed (a second check sees the same stock)', () => {
    const shelf = layers({ pad: [{ qty: 2, unitCostEgp: 120 }] });
    priceAgainstCost([{ productId: 'pad', quantity: 2, unitPrice: 1 }], shelf);
    const again = priceAgainstCost(
      [{ productId: 'pad', quantity: 2, unitPrice: 1 }],
      shelf,
    );
    expect(again.lines[0].costed).toBe(true);
  });
});

describe('unitFigure', () => {
  it('cents over a quantity, to two places, half away from zero', () => {
    expect(unitFigure(290_000, 3)).toBe('966.67');
    expect(unitFigure(1, 2)).toBe('0.01');
    expect(unitFigure(0, 5)).toBe('0.00');
    expect(unitFigure(100, 0.5)).toBe('2.00');
  });
});
