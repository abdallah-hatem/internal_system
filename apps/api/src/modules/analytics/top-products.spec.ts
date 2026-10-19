// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

/**
 * Top products by revenue or by units (owner 2026-10-18: "how is 21 sold on
 * top of 28?", then "a chart for the top 5 sold products, as in qty"). The
 * same products, two rankings; returns come off both; ties never depend on the
 * database's order.
 */

const D = (v: number) => new Prisma.Decimal(v);

/** A product with its realised sale lines: [qty, lineTotal][] and returned units. */
function product(name: string, lines: [number, number][], returned = 0) {
  return {
    id: name,
    name,
    nameAr: null,
    sku: `SKU-${name}`,
    saleItems: lines.map(([qty, total], i) => ({
      quantity: D(qty),
      lineTotal: D(total),
      allocations: [{ cogsEgp: D(qty * 10) }],
      returnItems:
        i === 0 && returned > 0
          ? [
              {
                qty: D(returned),
                unitPrice: D(total / qty),
                cogsReversedEgp: D(returned * 10),
              },
            ]
          : [],
    })),
  };
}

// The owner's own shape: fewer Y30 earned more than more Y20 FM.
const PRODUCTS = [
  product('Y30 Headset', [[21, 25200]]),
  product('Y20 FM', [[28, 25000]]),
  product('Q58 Max', [[17, 20400]]),
  product('Y20 MAX', [[16, 17600]]),
  product('Y12 PRO', []),
];

const service = (products = PRODUCTS) =>
  new AnalyticsService({
    product: { findMany: () => Promise.resolve(products) },
  } as never);

const names = (r: { data: { name: string }[] }) => r.data.map((p) => p.name);

describe('top products, two rankings', () => {
  it('by revenue (the default): Y30 first, as the dashboard showed', async () => {
    expect(names(await service().getTopProducts(5))).toEqual([
      'Y30 Headset',
      'Y20 FM',
      'Q58 Max',
      'Y20 MAX',
      'Y12 PRO',
    ]);
  });

  it('by units: 28 before 21', async () => {
    expect(names(await service().getTopProducts(5, 'units'))).toEqual([
      'Y20 FM',
      'Y30 Headset',
      'Q58 Max',
      'Y20 MAX',
      'Y12 PRO',
    ]);
  });

  it('the limit takes the top of the ranking asked for, not of revenue', async () => {
    expect(names(await service().getTopProducts(1, 'units'))).toEqual([
      'Y20 FM',
    ]);
    expect(names(await service().getTopProducts(1))).toEqual(['Y30 Headset']);
  });

  it('returns come off the units: 30 sold, 10 back, ranks as 20', async () => {
    const r = await service([
      product('Returned', [[30, 3000]], 10),
      product('Kept', [[25, 2500]]),
    ]).getTopProducts(5, 'units');
    expect(r.data.map((p) => [p.name, p.totalQuantitySold])).toEqual([
      ['Kept', 25],
      ['Returned', 20],
    ]);
  });

  it('a tie in units falls to revenue, then the name — never the database order', async () => {
    const tied = [
      product('B', [[10, 1000]]),
      product('A', [[10, 1000]]),
      product('C', [[10, 2000]]),
    ];
    expect(names(await service(tied).getTopProducts(5, 'units'))).toEqual([
      'C',
      'A',
      'B',
    ]);
    expect(
      names(await service([...tied].reverse()).getTopProducts(5, 'units')),
    ).toEqual(['C', 'A', 'B']);
  });
});

describe('GET /analytics/top-products?by=', () => {
  const calls: unknown[][] = [];
  const controller = new AnalyticsController({
    getTopProducts: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ data: [] });
    },
  } as never);
  beforeEach(() => (calls.length = 0));

  it('passes units and revenue through; nothing means revenue', async () => {
    await controller.getTopProducts('5', 'units');
    await controller.getTopProducts('5', 'revenue');
    await controller.getTopProducts('5');
    expect(calls).toEqual([
      [5, 'units'],
      [5, 'revenue'],
      [5, 'revenue'],
    ]);
  });

  it('anything else is a coded refusal, never a silent default', () => {
    for (const by of ['qty', 'UNITS', '']) {
      let code: unknown;
      try {
        void controller.getTopProducts('5', by);
      } catch (e) {
        code = (e as { getResponse: () => { code: string } }).getResponse()
          .code;
      }
      expect(code).toBe('VALIDATION_FAILED');
    }
    expect(calls).toEqual([]);
  });

  it('a limit that is not a positive number is the default 10; a huge one is capped at 100', async () => {
    await controller.getTopProducts('abc');
    await controller.getTopProducts('-3');
    await controller.getTopProducts('100000');
    expect(calls.map((c) => c[0])).toEqual([10, 10, 100]);
  });
});
