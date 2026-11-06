// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import { cashFromSalesEgp } from './cash-from-sales';

/**
 * Cash from sales (owner 2026-11-06): customer payments not reversed, less
 * cash refunded for returns. Rows are built the way the services write them:
 * a payment row plus its PAYMENT_RECEIVED ledger row, a return's SALE_RETURN
 * row, and REFUND_PAID only for a cash refund.
 */

type Payment = { amount: number; status: 'RECORDED' | 'REVERSED' };
type Row = {
  id: string;
  type: string;
  category: string;
  direction: 'INFLOW' | 'OUTFLOW';
  amount: number;
  reversalOfId?: string | null;
};
type TxWhere = {
  type?: string;
  direction?: string;
  id?: { notIn?: string[] };
};

function fakeDb(payments: Payment[], rows: Row[]) {
  const sum = (xs: number[]) =>
    xs.reduce((s, x) => s.add(x), new Prisma.Decimal(0));
  return {
    payment: {
      aggregate: ({ where }: { where: { status?: string } }) =>
        Promise.resolve({
          _sum: {
            amount: sum(
              payments
                .filter((p) => !where.status || p.status === where.status)
                .map((p) => p.amount),
            ),
          },
        }),
    },
    financialTransaction: {
      findMany: () =>
        Promise.resolve(
          rows
            .filter((r) => r.reversalOfId)
            .map((r) => ({ id: r.id, reversalOfId: r.reversalOfId })),
        ),
      aggregate: ({ where }: { where: TxWhere }) =>
        Promise.resolve({
          _sum: {
            amount: sum(
              rows
                .filter(
                  (r) =>
                    (!where.type || r.type === where.type) &&
                    (!where.direction || r.direction === where.direction) &&
                    !where.id?.notIn?.includes(r.id),
                )
                .map((r) => r.amount),
            ),
          },
        }),
    },
  };
}

const cash = async (payments: Payment[], rows: Row[] = []) =>
  (await cashFromSalesEgp(fakeDb(payments, rows) as never)).toFixed(2);

const received = (id: string, amount: number): Row => ({
  id,
  type: 'PAYMENT_RECEIVED',
  category: 'revenue',
  direction: 'INFLOW',
  amount,
});
const saleReturn = (id: string, amount: number): Row => ({
  id,
  type: 'SALE_RETURN',
  category: 'revenue',
  direction: 'OUTFLOW',
  amount,
});
const refundPaid = (id: string, amount: number): Row => ({
  id,
  type: 'REFUND_PAID',
  category: 'refund',
  direction: 'OUTFLOW',
  amount,
});

describe('cash from sales', () => {
  it('nothing recorded yet → 0, not an error', async () => {
    expect(await cash([])).toBe('0.00');
  });

  it('the payments customers made, summed', async () => {
    expect(
      await cash(
        [
          { amount: 128000, status: 'RECORDED' },
          { amount: 400, status: 'RECORDED' },
        ],
        [received('r1', 128000), received('r2', 400)],
      ),
    ).toBe('128400.00');
  });

  it('a reversed payment is not cash from sales, though its ledger row still stands', async () => {
    // Reversing marks the payment REVERSED and writes no undo row (§9), so a
    // reading off the ledger would still count the 500.
    expect(
      await cash(
        [
          { amount: 1000, status: 'RECORDED' },
          { amount: 500, status: 'REVERSED' },
        ],
        [received('r1', 1000), received('r2', 500)],
      ),
    ).toBe('1000.00');
  });

  it('a cash refund is taken off once — not the return row as well', async () => {
    expect(
      await cash(
        [{ amount: 128400, status: 'RECORDED' }],
        [
          received('r1', 128400),
          saleReturn('s1', 2000),
          refundPaid('f1', 2000),
        ],
      ),
    ).toBe('126400.00');
  });

  it('a credit-note return takes nothing off: the money stays collected, only the debt went down', async () => {
    expect(
      await cash(
        [{ amount: 1000, status: 'RECORDED' }],
        [received('r1', 1000), saleReturn('s1', 300)],
      ),
    ).toBe('1000.00');
  });

  it('a refund that was undone, with its undo, is no refund at all', async () => {
    const undo: Row = {
      ...refundPaid('f2', 300),
      direction: 'INFLOW',
      reversalOfId: 'f1',
    };
    expect(
      await cash(
        [{ amount: 1000, status: 'RECORDED' }],
        [refundPaid('f1', 300), undo],
      ),
    ).toBe('1000.00');
  });

  it('more refunded than collected reads below zero, never clamped to 0', async () => {
    // A clamp on money is where an amount silently disappears (LEARNINGS).
    expect(
      await cash(
        [
          { amount: 200, status: 'RECORDED' },
          { amount: 500, status: 'REVERSED' },
        ],
        [refundPaid('f1', 500)],
      ),
    ).toBe('-300.00');
  });

  it('other money in — a partner funding, a lender paying a supplier — is not cash from sales', async () => {
    expect(
      await cash(
        [{ amount: 1000, status: 'RECORDED' }],
        [
          received('r1', 1000),
          {
            id: 'c1',
            type: 'CONTRIBUTION',
            category: 'contribution',
            direction: 'INFLOW',
            amount: 50000,
          },
          {
            id: 'l1',
            type: 'LENDER_FINANCING',
            category: 'lender_financing',
            direction: 'INFLOW',
            amount: 90000,
          },
        ],
      ),
    ).toBe('1000.00');
  });
});
