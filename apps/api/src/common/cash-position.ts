// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; cash in EGP must not become a float
import { Prisma } from '@prisma/client';
import { NOT_CASH_CATEGORIES } from './ledger-categories';

/**
 * Money actually in hand: everything in, less everything out — leaving out the
 * ledger rows that record no money moving (`NOT_CASH_CATEGORIES`: a transfer
 * of leftover stock between cycles, §8 L5).
 *
 * One reading, so the dashboard's cash in, cash out and cash on hand cannot
 * disagree about which rows are cash (rule 11). Both directions in one pass:
 * a category added on one side and forgotten on the other is how the figure
 * drifted before.
 */
export async function cashPosition(db: {
  financialTransaction: Pick<
    Prisma.TransactionClient['financialTransaction'],
    'groupBy'
  >;
}) {
  const flows = await db.financialTransaction.groupBy({
    by: ['direction'],
    where: { category: { notIn: [...NOT_CASH_CATEGORIES] } },
    _sum: { amount: true },
  });
  const flowOf = (d: string) =>
    new Prisma.Decimal(flows.find((f) => f.direction === d)?._sum?.amount ?? 0);
  const cashIn = flowOf('INFLOW');
  const cashOut = flowOf('OUTFLOW');
  return { cashIn, cashOut, cashOnHand: cashIn.sub(cashOut) };
}
