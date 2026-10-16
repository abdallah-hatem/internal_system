// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money in EGP must not become a float
import { Prisma } from '@prisma/client';
import {
  NOT_OPERATING_EXPENSE,
  netOperatingExpenseEgp,
} from './ledger-categories';

/**
 * The expenses charged to a cycle in the ledger, in pounds, net of any
 * reversed (§9, L6): a card or bank fee for its order, customs, a late
 * freight bill — any manual EXPENSE whose `cycleId` is this cycle.
 *
 * Read through `operatingExpenseEgp`, the one reading of "an expense" the
 * settlement, the cycle page and the dashboard use (rule 11), so the cycle's
 * cost (§18, 2026-10-16: what a friend's payment may cover and what the
 * partners fund) counts exactly the ledger expenses its settlement charges.
 */
export async function cycleExpensesEgp(
  db: {
    financialTransaction: Pick<
      Prisma.TransactionClient['financialTransaction'],
      'findMany'
    >;
  },
  cycleId: string,
): Promise<Prisma.Decimal> {
  const rows = await db.financialTransaction.findMany({
    where: { cycleId, category: { notIn: [...NOT_OPERATING_EXPENSE] } },
    select: {
      amount: true,
      direction: true,
      category: true,
      reversalOfId: true,
    },
  });
  return netOperatingExpenseEgp(rows);
}
