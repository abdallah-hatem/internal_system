// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; cash in EGP must not become a float
import { Prisma } from '@prisma/client';
import { standingEntriesWhere, undoneEntryIds } from './undone-entries';

/**
 * The ledger type of cash handed back to a customer for a return
 * (`returns.service.ts`, refund method CASH). A credit-note return writes no
 * such row: no cash left the business, the shop's balance went down instead.
 */
export const CASH_REFUND_TYPE = 'REFUND_PAID';

/**
 * Cash from sales (owner 2026-11-06): the money actually collected from
 * customers, less the cash refunded to them — all time. The dashboard's first
 * Right now tile; it replaced Cash on hand there, which mixes the partners'
 * funding, lender money and supplier payments with sales.
 *
 *   payments not reversed (`payments.status = 'RECORDED'`, the same reading
 *   as the dashboard's Collected)
 *   − cash refunds (`REFUND_PAID` ledger rows), leaving out an entry undone
 *     together with its undo (`common/undone-entries.ts`, as cash on hand does).
 *
 * Payments are read from the payments themselves, not their ledger rows:
 * reversing a payment marks it REVERSED and writes no undo row, so the ledger
 * alone would still count it. A credit-note return is not subtracted — the
 * money the shop paid stays collected; only its debt went down.
 *
 * One definition (CLAUDE.md §11), read by `/analytics/dashboard`.
 */
export async function cashFromSalesEgp(db: {
  payment: Pick<Prisma.TransactionClient['payment'], 'aggregate'>;
  financialTransaction: Pick<
    Prisma.TransactionClient['financialTransaction'],
    'aggregate' | 'findMany'
  >;
}): Promise<Prisma.Decimal> {
  const paid = await db.payment.aggregate({
    where: { status: 'RECORDED' },
    _sum: { amount: true },
  });
  const undone = await undoneEntryIds(db);
  const refunded = await db.financialTransaction.aggregate({
    where: {
      type: CASH_REFUND_TYPE,
      direction: 'OUTFLOW',
      ...standingEntriesWhere(undone),
    },
    _sum: { amount: true },
  });
  return new Prisma.Decimal(paid._sum?.amount ?? 0).sub(
    new Prisma.Decimal(refunded._sum?.amount ?? 0),
  );
}
