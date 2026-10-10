/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- the fake database's rows are untyped records, as Prisma's argument objects are */
import type { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from '../modules/analytics/analytics.service';
import {
  countLowStock,
  findLowStock,
  isLowStock,
  type LowStockProduct,
  stockOnHand,
} from './low-stock';

/**
 * The one definition of "low stock" (BUSINESS_LOGIC §3, 2026-10-10): active,
 * a minimum set, stock on hand (remaining, every batch) below it.
 */

describe('isLowStock — the predicate', () => {
  const active = (minStock: LowStockProduct['minStock']): LowStockProduct => ({
    status: 'ACTIVE',
    minStock,
  });

  it('below the minimum is low', () => {
    expect(isLowStock(active(5), 4)).toBe(true);
  });

  it('exactly at the minimum is not low (<, not <=)', () => {
    expect(isLowStock(active('5.000'), 5)).toBe(false);
    expect(isLowStock(active(5), '5.000')).toBe(false);
  });

  it('no minimum is never low, even with nothing left', () => {
    expect(isLowStock(active(null), 0)).toBe(false);
    expect(isLowStock(active(undefined), 0)).toBe(false);
  });

  it('an inactive product is never low', () => {
    expect(isLowStock({ status: 'INACTIVE', minStock: 5 }, 0)).toBe(false);
    expect(isLowStock({ status: 'DISCONTINUED', minStock: 5 }, 0)).toBe(false);
  });

  it('a minimum of 0 is never reached from below; sold out under a minimum of 1 is low', () => {
    expect(isLowStock(active(0), 0)).toBe(false);
    expect(isLowStock(active(1), 0)).toBe(true);
  });

  it('decimals compare as numbers, not text ("10" vs "9")', () => {
    expect(isLowStock(active('10.000'), '9.5')).toBe(true);
    expect(isLowStock(active('9.000'), '10')).toBe(false);
  });

  it('no product, or a minimum that is not a number, is not low', () => {
    expect(isLowStock(null, 0)).toBe(false);
    expect(isLowStock(active('abc'), 0)).toBe(false);
  });

  it('stock on hand sums remaining over every batch', () => {
    expect(stockOnHand([])).toBe(0);
    expect(
      stockOnHand([
        { remainingQty: '2.500' },
        { remainingQty: 3 },
        { remainingQty: { toString: () => '1.5' } },
      ]),
    ).toBe(7);
  });
});

// ─── The query, and the dashboard count that uses it ──────────────────────

interface P {
  id: string;
  name: string;
  status: string;
  minStock: string | null;
  batches: { remainingQty: string; saleableQty: string }[];
}

/**
 * A database that answers the low-stock query the way Postgres would: it
 * applies the `where` it is sent. Every other model the dashboard asks about
 * is empty.
 */
function fakeDb(products: P[]) {
  const product = {
    findMany: ({ where = {} }: any) =>
      Promise.resolve(
        products
          .filter(
            (p) =>
              (where.status === undefined || p.status === where.status) &&
              (where.minStock?.not !== null || p.minStock !== null) &&
              (!where.id?.in || where.id.in.includes(p.id)),
          )
          .map((p) => ({
            id: p.id,
            name: p.name,
            status: p.status,
            minStock: p.minStock,
            inventoryBatches: p.batches.map((b) => ({
              remainingQty: b.remainingQty,
            })),
          })),
      ),
    count: () => Promise.resolve(products.length),
  };
  const empty = new Proxy(
    {},
    {
      get: (_t, method: string) => () =>
        Promise.resolve(
          method === 'count' ? 0 : method === 'aggregate' ? { _sum: {} } : [],
        ),
    },
  );
  return new Proxy({ product } as any, {
    get: (t, model: string) => t[model] ?? empty,
  }) as PrismaService;
}

const p = (
  name: string,
  status: string,
  minStock: string | null,
  remaining: number[],
  saleable = remaining,
): P => ({
  id: name,
  name,
  status,
  minStock,
  batches: remaining.map((r, i) => ({
    remainingQty: String(r),
    saleableQty: String(saleable[i]),
  })),
});

const shelf = [
  p('inactive, empty, min 5', 'INACTIVE', '5', [0]),
  p('no minimum, empty', 'ACTIVE', null, [0]),
  p('exactly at 10', 'ACTIVE', '10', [10]),
  p('below: 9 of 10', 'ACTIVE', '10', [9]),
  // 4 + 3 + 2 = 9 < 10: low only when every batch is summed together.
  p('three batches, 9 of 10', 'ACTIVE', '10', [4, 3, 2]),
  // 6 + 5 = 11: no single batch reaches 10, the sum does.
  p('two batches, 11 of 10', 'ACTIVE', '10', [6, 5]),
  p('never received, min 1', 'ACTIVE', '1', []),
];

describe('findLowStock / countLowStock — the query', () => {
  it('returns exactly the low ones, with the summed figure', async () => {
    const low = await findLowStock(fakeDb(shelf));
    expect(low.map((r) => r.productName).sort()).toEqual(
      [
        'below: 9 of 10',
        'never received, min 1',
        'three batches, 9 of 10',
      ].sort(),
    );
    expect(low.find((r) => r.productName === 'three batches, 9 of 10')).toEqual(
      {
        productId: 'three batches, 9 of 10',
        productName: 'three batches, 9 of 10',
        currentStock: 9,
        minStock: 10,
      },
    );
  });

  it('counts remaining, not saleable: on the shelf is on hand', async () => {
    // 12 on the shelf, 8 of them free to sell: not low against 10.
    const db = fakeDb([p('held', 'ACTIVE', '10', [12], [8])]);
    expect(await countLowStock(db)).toBe(0);
  });

  it('limited to some ids, looks at only those', async () => {
    const low = await findLowStock(fakeDb(shelf), [
      'below: 9 of 10',
      'exactly at 10',
    ]);
    expect(low.map((r) => r.productName)).toEqual(['below: 9 of 10']);
  });

  it('agrees with the predicate for every product on the shelf', async () => {
    const low = new Set(
      (await findLowStock(fakeDb(shelf))).map((r) => r.productId),
    );
    for (const prod of shelf) {
      expect([prod.name, low.has(prod.id)]).toEqual([
        prod.name,
        isLowStock(
          prod,
          stockOnHand(
            prod.batches.map((b) => ({ remainingQty: b.remainingQty })),
          ),
        ),
      ]);
    }
  });
});

describe('the dashboard Low stock count', () => {
  it('counts the same three the rule names — not the inactive, the unset, or the one at its minimum', async () => {
    const { data } = await new AnalyticsService(
      fakeDb(shelf),
    ).getDashboardKPIs();
    expect(data.lowStockAlerts).toBe(3);
  });

  it('an empty shelf with no minimums counts zero', async () => {
    const { data } = await new AnalyticsService(
      fakeDb([p('a', 'ACTIVE', null, [])]),
    ).getDashboardKPIs();
    expect(data.lowStockAlerts).toBe(0);
  });
});
