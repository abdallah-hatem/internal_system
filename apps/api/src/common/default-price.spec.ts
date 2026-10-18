import {
  DEFAULT_MARKUP_PCT,
  defaultPriceFor,
  listPriceOn,
  listPricesFor,
  listPricesOf,
  type CostBatch,
  type PriceRow,
} from './default-price';

/**
 * A product's default price (BUSINESS_LOGIC §3, owner 2026-10-18): landed cost
 * + 20%, for B2B and B2C, wherever no price was set on that channel.
 */

const batch = (
  remainingQty: number | string,
  landedUnitCostEgp: number | string,
  createdAt = '2026-09-01T00:00:00Z',
  id = `b-${String(createdAt)}-${String(landedUnitCostEgp)}`,
): CostBatch => ({ remainingQty, landedUnitCostEgp, createdAt, id });

const set = (
  channel: 'B2B' | 'B2C',
  amount: number,
  effectiveTo: Date | null = null,
): PriceRow => ({ channel, amount, currency: 'EGP', effectiveTo });

describe('the markup', () => {
  it('is 20%, as the owner set it', () => {
    expect(DEFAULT_MARKUP_PCT).toBe(20);
  });
});

describe('defaultPriceFor — the landed cost it is worked from', () => {
  it('landed 100 → 120', () => {
    expect(defaultPriceFor([batch(10, 100)])?.toString()).toBe('120');
  });

  it('weights two batches by what is left of each, not by what was received', () => {
    // 30 left at 100 and 10 left at 140: (3000 + 1400) / 40 = 110 → 132.
    // An unweighted average of the costs would say 120 → 144.
    expect(defaultPriceFor([batch(30, 100), batch(10, 140)])?.toString()).toBe(
      '132',
    );
  });

  it('a sold-out batch does not count while another is on the shelf', () => {
    expect(defaultPriceFor([batch(0, 500), batch(5, 100)])?.toString()).toBe(
      '120',
    );
  });

  it('nothing on the shelf → the most recently received batch, whatever the order given', () => {
    const older = batch(0, 100, '2026-08-01T00:00:00Z');
    const newer = batch(0, 150, '2026-09-15T00:00:00Z');
    expect(defaultPriceFor([newer, older])?.toString()).toBe('180');
    expect(defaultPriceFor([older, newer])?.toString()).toBe('180');
  });

  it('never received → null, not 0', () => {
    expect(defaultPriceFor([])).toBeNull();
    expect(defaultPriceFor(undefined)).toBeNull();
  });

  it('rounds to the whole pound, half up: an exact .5 goes up', () => {
    // 11 at 50 and 1 at 55: 605 / 12 = 50.41666…, × 1.2 = 60.5 exactly → 61.
    // Rounding the average first (50.4167 × 1.2 = 60.50004) would hide that
    // this is the .5 case; worked whole, it is exactly .5.
    expect(defaultPriceFor([batch(11, 50), batch(1, 55)])?.toString()).toBe(
      '61',
    );
  });

  it('just under .5 goes down; just over goes up', () => {
    // 102.0833 × 1.2 = 122.49996 → 122; 102.0834 × 1.2 = 122.50008 → 123.
    expect(defaultPriceFor([batch(1, '102.0833')])?.toString()).toBe('122');
    expect(defaultPriceFor([batch(1, '102.0834')])?.toString()).toBe('123');
  });

  it('a zero-cost batch beside a costed one is averaged in, and nothing is NaN', () => {
    // 1 at 0 and 1 at 100: 50 → 60.
    const p = defaultPriceFor([batch(1, 0), batch(1, 100)]);
    expect(p?.toString()).toBe('60');
    expect(Number.isNaN(p)).toBe(false);
  });

  it('only zero-cost stock → null: a batch not yet costed is no basis for a price (rule 10)', () => {
    expect(defaultPriceFor([batch(4, 0)])).toBeNull();
    expect(defaultPriceFor([batch(0, 0)])).toBeNull();
  });

  it('decimal strings, as Prisma sends them, work as numbers do', () => {
    expect(defaultPriceFor([batch('2.500', '100.0000')])?.toString()).toBe(
      '120',
    );
  });
});

describe('listPriceOn — a set price wins', () => {
  const batches = [batch(10, 100)];

  it('no price set → the default, marked DEFAULT with its markup', () => {
    expect(listPriceOn([], batches, 'B2B')).toEqual({
      amount: '120.00',
      currency: 'EGP',
      source: 'DEFAULT',
      markupPct: 20,
    });
  });

  it('a set price is returned as SET, even when it is below the default', () => {
    expect(listPriceOn([set('B2B', 110)], batches, 'B2B')).toEqual({
      amount: '110.00',
      currency: 'EGP',
      source: 'SET',
    });
  });

  it('each channel on its own: B2B set, B2C default — and the other way round', () => {
    expect(listPricesOf([set('B2B', 150)], batches)).toEqual({
      B2B: { amount: '150.00', currency: 'EGP', source: 'SET' },
      B2C: {
        amount: '120.00',
        currency: 'EGP',
        source: 'DEFAULT',
        markupPct: 20,
      },
    });
    expect(listPricesOf([set('B2C', 175)], batches)).toEqual({
      B2B: {
        amount: '120.00',
        currency: 'EGP',
        source: 'DEFAULT',
        markupPct: 20,
      },
      B2C: { amount: '175.00', currency: 'EGP', source: 'SET' },
    });
  });

  it('a closed price is history, not a set price: the default applies', () => {
    const closed = set('B2B', 999, new Date('2026-06-01T00:00:00Z'));
    expect(listPriceOn([closed], batches, 'B2B')?.source).toBe('DEFAULT');
  });

  it('a set price of 0 is still a set price (a giveaway the owner chose)', () => {
    expect(listPriceOn([set('B2C', 0)], batches, 'B2C')).toMatchObject({
      amount: '0.00',
      source: 'SET',
    });
  });

  it('no price set and never received → null on both channels', () => {
    expect(listPricesOf([], [])).toEqual({ B2B: null, B2C: null });
  });
});

describe('listPricesFor — the batches are read once, per product', () => {
  it('one query for every product, each priced from its own batches', async () => {
    const findMany = jest.fn(() =>
      Promise.resolve([
        { productId: 'a', ...batch(10, 100) },
        { productId: 'b', ...batch(5, 200) },
      ]),
    );
    const db = { inventoryBatch: { findMany } } as unknown as Parameters<
      typeof listPricesFor
    >[0];
    const prices = await listPricesFor(db, [
      { id: 'a', prices: [] },
      { id: 'b', prices: [set('B2C', 300)] },
      { id: 'c', prices: [] },
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(prices.get('a')?.B2B?.amount).toBe('120.00');
    expect(prices.get('b')?.B2B?.amount).toBe('240.00');
    expect(prices.get('b')?.B2C).toMatchObject({
      amount: '300.00',
      source: 'SET',
    });
    expect(prices.get('c')).toEqual({ B2B: null, B2C: null });
  });

  it('no products → no query', async () => {
    const findMany = jest.fn();
    const db = { inventoryBatch: { findMany } } as unknown as Parameters<
      typeof listPricesFor
    >[0];
    expect((await listPricesFor(db, [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
