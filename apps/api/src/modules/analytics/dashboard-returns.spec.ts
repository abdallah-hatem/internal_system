// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import { AnalyticsService } from './analytics.service';

/**
 * A sale return is counted once on the dashboard (§5, §9).
 *
 * A return already comes off Revenue: the dashboard subtracts the return's
 * `refundEgp` from the realised orders. The return also writes two ledger
 * rows — `revenue` going out (the sale undone) and, for a cash refund,
 * `refund` going out (the money handed back). Neither category was in
 * NOT_OPERATING_EXPENSE, so both landed in Expenses too: a 300 cash refund
 * took 900 off net profit.
 */

const D = (v: number) => new Prisma.Decimal(v);

type Row = {
  direction: 'INFLOW' | 'OUTFLOW';
  category: string;
  amount: Prisma.Decimal;
  reversalOfId: string | null;
};
type Where = {
  direction?: string;
  category?: { in?: string[]; notIn?: string[] };
  reversalOfId?: { not: null };
};

function db(rows: Row[], sold: number, refunded: number) {
  const sum = (where: Where) =>
    rows
      .filter(
        (r) =>
          (where.direction === undefined || r.direction === where.direction) &&
          (!where.category?.in || where.category.in.includes(r.category)) &&
          (!where.category?.notIn ||
            !where.category.notIn.includes(r.category)) &&
          (where.reversalOfId?.not !== null || r.reversalOfId !== null),
      )
      .reduce((s, r) => s.add(r.amount), D(0));
  const empty = {
    aggregate: () => Promise.resolve({ _sum: {} }),
    findMany: () => Promise.resolve([]),
    count: () => Promise.resolve(0),
    groupBy: () => Promise.resolve([]),
  };
  const models: Record<string, unknown> = {
    saleOrder: {
      ...empty,
      aggregate: () => Promise.resolve({ _sum: { total: D(sold) } }),
    },
    saleReturn: {
      ...empty,
      aggregate: () =>
        Promise.resolve({
          _sum: { refundEgp: D(refunded), cogsReversedEgp: D(0) },
        }),
    },
    financialTransaction: {
      ...empty,
      aggregate: ({ where }: { where: Where }) =>
        Promise.resolve({ _sum: { amount: sum(where) } }),
    },
  };
  return new Proxy(models, { get: (t, k: string) => t[k] ?? empty });
}

const row = (
  direction: Row['direction'],
  category: string,
  amount: number,
): Row => ({
  direction,
  category,
  amount: D(amount),
  reversalOfId: null,
});

const kpis = async (rows: Row[], sold: number, refunded: number) =>
  (
    await new AnalyticsService(
      db(rows, sold, refunded) as never,
    ).getDashboardKPIs()
  ).data;

describe('a sale return on the dashboard', () => {
  it('a 1,000 sale, paid, 300 returned for cash: revenue 700, no expense, profit 700', async () => {
    const r = await kpis(
      [
        row('INFLOW', 'revenue', 1000), // the customer's payment
        row('OUTFLOW', 'revenue', 300), // SALE_RETURN: the sale undone
        row('OUTFLOW', 'refund', 300), // REFUND_PAID: the cash handed back
      ],
      1000,
      300,
    );
    expect(r).toMatchObject({
      totalRevenue: 700,
      totalExpenses: 0,
      netProfit: 700,
    });
  });

  it('returned for credit (no cash refund): still no expense', async () => {
    const r = await kpis([row('OUTFLOW', 'revenue', 300)], 1000, 300);
    expect(r).toMatchObject({
      totalRevenue: 700,
      totalExpenses: 0,
      netProfit: 700,
    });
  });

  it('a real expense beside a return still counts, once', async () => {
    const r = await kpis(
      [
        row('OUTFLOW', 'revenue', 300),
        row('OUTFLOW', 'refund', 300),
        row('OUTFLOW', 'rent', 200),
      ],
      1000,
      300,
    );
    expect(r).toMatchObject({ totalExpenses: 200, netProfit: 500 });
  });
});
