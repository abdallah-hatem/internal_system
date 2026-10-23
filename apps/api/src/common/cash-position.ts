// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; cash in EGP must not become a float
import { Prisma } from '@prisma/client';
import { NOT_CASH_CATEGORIES, NOT_CASH_TYPES } from './ledger-categories';

/**
 * Money actually in hand: everything in, less everything out — leaving out the
 * ledger rows that record no money moving: `NOT_CASH_CATEGORIES` (a transfer
 * of leftover stock between cycles, §8 L5; a partner's share of running costs
 * taken from his payout, §8 L7), `NOT_CASH_TYPES` (a return's sale undone —
 * only the cash actually handed back is cash out, L7), and every entry that was
 * undone together with its undo (2026-10-17).
 *
 * One reading, so the dashboard's cash in, cash out and cash on hand cannot
 * disagree about which rows are cash (rule 11). Both directions in one pass:
 * a category added on one side and forgotten on the other is how the figure
 * drifted before.
 */
export async function cashPosition(
  db: {
    financialTransaction: Pick<
      Prisma.TransactionClient['financialTransaction'],
      'groupBy' | 'findMany'
    >;
  },
  /**
   * Only the rows of a period — Analytics' profit and loss passes its days
   * (`ledgerDayWhere`), so its Cash paid out is this same reading cut to the
   * period (owner 2026-10-23). Left out, all time: the dashboard's figures.
   * An undone pair is left out whichever period each half falls in.
   */
  within: Prisma.FinancialTransactionWhereInput = {},
) {
  // An entry that was undone, and the undo itself, are not money that moved:
  // the pair records a mistake and its correction. Counting them put a
  // corrected lender payment into cash in AND cash out — 90,161.56 each way
  // in production (owner, 2026-10-17) — while cash on hand, where they cancel,
  // looked right. Every undo mirrors its entry's full amount (ledger,
  // purchases, lenders, transfers, running costs), so leaving both out
  // changes cash in and out and never cash on hand.
  const undone = (
    await db.financialTransaction.findMany({
      where: { reversalOfId: { not: null } },
      select: { reversalOfId: true },
    })
  ).map((r) => r.reversalOfId as string);

  const flows = await db.financialTransaction.groupBy({
    by: ['direction'],
    where: {
      ...within,
      category: { notIn: [...NOT_CASH_CATEGORIES] },
      type: { notIn: [...NOT_CASH_TYPES] },
      reversalOfId: null,
      ...(undone.length > 0 ? { id: { notIn: undone } } : {}),
    },
    _sum: { amount: true },
  });
  const flowOf = (d: string) =>
    new Prisma.Decimal(flows.find((f) => f.direction === d)?._sum?.amount ?? 0);
  const cashIn = flowOf('INFLOW');
  const cashOut = flowOf('OUTFLOW');
  return { cashIn, cashOut, cashOnHand: cashIn.sub(cashOut) };
}
