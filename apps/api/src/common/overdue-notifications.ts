/**
 * Who is told about which overdue instalment (BUSINESS_LOGIC §7, DECIDED
 * 2026-10-11).
 *
 * Overdue used to be noticed only when somebody opened the payment-plans
 * endpoint, and only that person was told — and nothing in the office app
 * opens it, so in practice nobody was. A daily job now asks, and every active
 * core partner hears about each instalment that has fallen behind.
 *
 * **Once per instalment, per partner, ever.** The job runs every day and an
 * instalment stays overdue until it is paid; a notification each morning for
 * the same 1,000 EGP is how people learn to ignore the bell. A later
 * instalment of the same plan falling behind is news and is told. A partner
 * added after an instalment fell behind has not heard about it, and is told on
 * the next run.
 *
 * What was already sent is read from the notifications themselves (their
 * payload carries `instalmentId`), so there is no second record of it to drift.
 *
 * Pure: no Nest, no Prisma.
 */

export interface OverdueInstalment {
  instalmentId: string;
  planId: string;
  customerId: string;
  customer: string;
  reference: string;
  /** YYYY-MM-DD. */
  dueOn: string;
  /** What is still owed on this instalment, "1000.00". */
  outstandingEgp: string;
}

export interface SentOverdue {
  userId: string;
  instalmentId: string;
}

export interface OverdueToSend<
  T extends { instalmentId: string } = OverdueInstalment,
> {
  instalment: T;
  userIds: string[];
}

/**
 * Generic over what an instalment carries, so a lender's plan (§18) is told by
 * the same rule as a shop's — only `instalmentId` is read.
 */
export function overdueNotificationsToSend<
  T extends { instalmentId: string } = OverdueInstalment,
>(
  overdue: readonly T[],
  partnerIds: readonly string[],
  alreadySent: readonly SentOverdue[],
): OverdueToSend<T>[] {
  const sent = new Set(alreadySent.map((s) => `${s.userId}:${s.instalmentId}`));
  const partners = [...new Set(partnerIds)];
  const seen = new Set<string>();
  const out: OverdueToSend<T>[] = [];

  for (const instalment of overdue) {
    if (seen.has(instalment.instalmentId)) continue;
    seen.add(instalment.instalmentId);
    const userIds = partners.filter(
      (userId) => !sent.has(`${userId}:${instalment.instalmentId}`),
    );
    if (userIds.length > 0) out.push({ instalment, userIds });
  }
  return out;
}
