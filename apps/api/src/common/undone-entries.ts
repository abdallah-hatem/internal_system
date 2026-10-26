import type { Prisma } from '@prisma/client';

/**
 * An entry that was undone, and the row that undoes it, record a mistake and
 * its correction — not money that moved, not an expense, not income
 * (§9; cash 2026-10-17, every period's figures owner 2026-10-26).
 *
 * Every undo mirrors its entry's full amount, category and cycle (ledger,
 * purchases, lenders, transfers, running costs), so over all time the pair
 * nets to zero and leaving both out changes nothing. Cut to a period it is
 * the only honest reading: a bank fee dated 15 July and undone on 26 October
 * otherwise put −3,338.82 into October's Expenses and left July's +3,338.82
 * standing, two periods each wrong by the whole fee (production, 2026-10-26).
 *
 * One rule (CLAUDE.md §11), read by cash in / cash out / cash on hand
 * (`cashPosition`) and by every ledger line of profit — Expenses, Other
 * income, Recovered — for the dashboard's all-time and This month figures and
 * Analytics' profit and loss (`AnalyticsService.profitParts`).
 */
export async function undoneEntryIds(db: {
  financialTransaction: Pick<
    Prisma.TransactionClient['financialTransaction'],
    'findMany'
  >;
}): Promise<string[]> {
  const undos = await db.financialTransaction.findMany({
    where: { reversalOfId: { not: null } },
    select: { id: true, reversalOfId: true },
  });
  return undos.flatMap((r) => [r.id, r.reversalOfId as string]);
}

/**
 * The ledger rows that stand: neither undone nor an undo. `ids` is
 * `undoneEntryIds`'s answer, read once per computation. Only an `id` filter
 * (the undos are in `ids` themselves), so it spreads into any other where
 * without overriding its own keys.
 */
export function standingEntriesWhere(
  ids: readonly string[],
): Prisma.FinancialTransactionWhereInput {
  return ids.length > 0 ? { id: { notIn: [...ids] } } : {};
}
