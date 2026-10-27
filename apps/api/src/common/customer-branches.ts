import type { Prisma } from '@prisma/client';

import { badRequest, notFound } from './api-error';
import { OWED_STATUSES } from './customer-balance';
import { isUuid } from './uuid';

/**
 * A customer's branches (BUSINESS_LOGIC §7, "A customer with branches",
 * owner 2026-10-25).
 *
 * One owner pays for several branches. Each branch has its own orders, balance
 * and statement; the owner's balance is all of them together. A branch is not a
 * customer: payments, credit, contracts, the storefront login and the invoice
 * header stay on the customer. What a branch adds is which orders are whose,
 * and where to deliver.
 */

/** The key the owed-by-branch map uses for orders on no branch. */
export const NO_BRANCH = 'none';

type Db = Pick<Prisma.TransactionClient, 'customerBranch'>;

/**
 * The branch a sale order goes on — the one rule, for the office, the
 * assistant's `record_sale`, the office chat and samples alike (owner,
 * 2026-10-25: "not required because default to the default").
 *
 * - A branch named: it must be this customer's, and not archived.
 * - None named: the customer's default branch. With no default (no branches,
 *   or none chosen yet) the order is on the owner: null. GUESS, open with the
 *   owner — see BUSINESS_LOGIC §7.
 */
export async function resolveSaleBranch(
  db: Db,
  customerId: string,
  branchId: string | null | undefined,
): Promise<string | null> {
  if (branchId === undefined || branchId === null || branchId === '') {
    const fallback = await db.customerBranch.findFirst({
      where: { customerId, isDefault: true, archivedAt: null },
      select: { id: true },
    });
    return fallback?.id ?? null;
  }
  return (await assertSaleBranch(db, customerId, branchId)).id;
}

/**
 * A named branch, checked: it exists, it is this customer's, it is open.
 * Returned so the caller can name it in its own refusals.
 */
export async function assertSaleBranch(
  db: Db,
  customerId: string,
  branchId: unknown,
) {
  if (!isUuid(branchId)) throw notFound('customerBranch');
  const branch = await db.customerBranch.findUnique({
    where: { id: branchId },
    select: { id: true, customerId: true, name: true, archivedAt: true },
  });
  if (!branch) throw notFound('customerBranch');
  // Another customer's branch would put the order — and later this owner's
  // payments — on someone else's books (CLAUDE.md §1, "the wrong owner").
  if (branch.customerId !== customerId) {
    throw badRequest(
      'BRANCH_NOT_THIS_CUSTOMER',
      `The branch ${branch.name} belongs to another customer.`,
      { branch: branch.name },
    );
  }
  if (branch.archivedAt) {
    throw badRequest(
      'BRANCH_ARCHIVED',
      `The branch ${branch.name} is archived and takes no new orders or payments.`,
      { branch: branch.name },
    );
  }
  return branch;
}

/**
 * What each branch of one customer owes, by the same rule as `owedBy`
 * (customer-balance.ts) — grouped instead of summed. Orders on no branch are
 * under `NO_BRANCH`. Every branch asked about gets an answer, "0.00" when it
 * owes nothing; the values always add up to `owedBy` for the customer, because
 * they are the same orders split one way.
 */
export async function owedByBranch(
  db: Pick<Prisma.TransactionClient, 'saleOrder'>,
  customerId: string,
  branchIds: string[] = [],
): Promise<Map<string, string>> {
  const owed = new Map<string, string>([
    [NO_BRANCH, '0.00'],
    ...branchIds.map((id) => [id, '0.00'] as [string, string]),
  ]);
  const groups = await db.saleOrder.groupBy({
    by: ['branchId'],
    where: { customerId, status: { in: [...OWED_STATUSES] } },
    _sum: { outstanding: true },
  });
  for (const g of groups) {
    owed.set(
      g.branchId ?? NO_BRANCH,
      g._sum?.outstanding?.toFixed(2) ?? '0.00',
    );
  }
  return owed;
}

/** What one branch owes — the payment to one branch is capped by it. */
export async function owedByOneBranch(
  db: Pick<Prisma.TransactionClient, 'saleOrder'>,
  customerId: string,
  branchId: string,
): Promise<string> {
  const agg = await db.saleOrder.aggregate({
    where: { customerId, branchId, status: { in: [...OWED_STATUSES] } },
    _sum: { outstanding: true },
  });
  return agg._sum?.outstanding?.toFixed(2) ?? '0.00';
}
