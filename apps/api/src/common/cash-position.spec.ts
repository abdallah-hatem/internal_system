// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import { cashPosition } from './cash-position';

/**
 * Cash on hand counts only money that actually moved (L7, 2026-10-12; raised
 * as "Still open" by L6).
 *
 * A return writes two rows: the sale undone (`SALE_RETURN`, `revenue` going
 * out) and, for a cash refund, the cash handed back (`REFUND_PAID`, `refund`
 * going out). Only the second is cash. Counting both took a 300 cash refund
 * off cash on hand as 600, and a credit-note return — no cash at all — as 300.
 */

type Row = {
  type: string;
  category: string;
  direction: 'INFLOW' | 'OUTFLOW';
  amount: number;
};

type Where = {
  category?: { notIn?: string[] };
  type?: { notIn?: string[] };
};

/** Enough of Prisma's groupBy for `cashPosition`'s one read. */
function fakeDb(rows: Row[]) {
  return {
    financialTransaction: {
      groupBy: ({ where }: { where: Where }) => {
        const kept = rows.filter(
          (r) =>
            !where.category?.notIn?.includes(r.category) &&
            !where.type?.notIn?.includes(r.type),
        );
        return Promise.resolve(
          (['INFLOW', 'OUTFLOW'] as const).map((direction) => ({
            direction,
            _sum: {
              amount: kept
                .filter((r) => r.direction === direction)
                .reduce((s, r) => s.add(r.amount), new Prisma.Decimal(0)),
            },
          })),
        );
      },
    },
  };
}

const PAID_IN: Row = {
  type: 'PAYMENT',
  category: 'revenue',
  direction: 'INFLOW',
  amount: 1000,
};

async function onHand(rows: Row[]) {
  const cash = await cashPosition(fakeDb(rows) as never);
  return {
    in: cash.cashIn.toFixed(2),
    out: cash.cashOut.toFixed(2),
    onHand: cash.cashOnHand.toFixed(2),
  };
}

describe('cash on hand and a sale return', () => {
  it('a 300 cash refund lowers cash by 300, not 600', async () => {
    expect(
      await onHand([
        PAID_IN,
        {
          type: 'SALE_RETURN',
          category: 'revenue',
          direction: 'OUTFLOW',
          amount: 300,
        },
        {
          type: 'REFUND_PAID',
          category: 'refund',
          direction: 'OUTFLOW',
          amount: 300,
        },
      ]),
    ).toEqual({ in: '1000.00', out: '300.00', onHand: '700.00' });
  });

  it('a credit-note return moves no cash at all', async () => {
    expect(
      await onHand([
        PAID_IN,
        {
          type: 'SALE_RETURN',
          category: 'revenue',
          direction: 'OUTFLOW',
          amount: 300,
        },
      ]),
    ).toEqual({ in: '1000.00', out: '0.00', onHand: '1000.00' });
  });

  it('a customer’s payment, also `revenue`, is still cash in — the rule is by type, not category', async () => {
    expect((await onHand([PAID_IN])).in).toBe('1000.00');
  });

  it('a running-cost share taken from a payout is not cash; the payout row carries what was handed over', async () => {
    expect(
      await onHand([
        PAID_IN,
        {
          type: 'SETTLEMENT_PAYOUT',
          category: 'settlement',
          direction: 'OUTFLOW',
          amount: 600,
        },
        {
          type: 'RUNNING_COST_CHARGE',
          category: 'running_cost_share',
          direction: 'INFLOW',
          amount: 200,
        },
      ]),
    ).toEqual({ in: '1000.00', out: '600.00', onHand: '400.00' });
  });
});
