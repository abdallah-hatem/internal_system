import type { Prisma } from '@prisma/client';

/**
 * What a customer owes.
 *
 * One definition, because four places ask: taking a payment refuses more than
 * this, a payment plan refuses to schedule more than this, the customer's page
 * shows it, and the assistant reads it out. Payments and payment plans each
 * carried their own copy of the status list, and a third copy in the assistant
 * would have been the one to drift (CLAUDE.md rule 11).
 *
 *     owed = Σ outstanding over the customer's CONFIRMED and PARTIALLY_PAID orders
 *
 * A draft owes nothing yet — it is not a sale — and a PAID or CANCELLED order
 * owes nothing any more.
 */
export const OWED_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID'] as const;

/** Anything that can run the query — the client or a transaction. */
type Db = Pick<Prisma.TransactionClient, 'saleOrder'>;

/**
 * The amount, to the cent, as a decimal string ("500.00").
 *
 * A string rather than a number so the sum Postgres made exactly is not passed
 * through a float on the way out; callers that compare wrap it in their own
 * Decimal or Number.
 */
export async function owedBy(db: Db, customerId: string): Promise<string> {
  const agg = await db.saleOrder.aggregate({
    where: { customerId, status: { in: [...OWED_STATUSES] } },
    _sum: { outstanding: true },
  });
  return agg._sum?.outstanding?.toFixed(2) ?? '0.00';
}

/**
 * What each of several customers owes, in one query — for a page of the list.
 *
 * The same rule as `owedBy`, grouped by customer instead of asked once per row.
 * Every id asked about gets an answer; one with nothing owed gets "0.00", not a
 * missing key, so a list cannot show a blank where a zero belongs.
 */
export async function owedByEach(
  db: Db,
  customerIds: string[],
): Promise<Map<string, string>> {
  const owed = new Map(customerIds.map((id) => [id, '0.00']));
  if (customerIds.length === 0) return owed;
  const groups = await db.saleOrder.groupBy({
    by: ['customerId'],
    where: {
      customerId: { in: customerIds },
      status: { in: [...OWED_STATUSES] },
    },
    _sum: { outstanding: true },
  });
  for (const g of groups) {
    owed.set(g.customerId, g._sum?.outstanding?.toFixed(2) ?? '0.00');
  }
  return owed;
}
