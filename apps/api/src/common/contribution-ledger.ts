// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money in EGP must not become a float
import { Prisma } from '@prisma/client';

/**
 * Post the money a participant put in, or took back out.
 *
 * The ledger recorded the cycle spending its capital but never recorded that
 * capital arriving: the purchase went out as an OUTFLOW and the partners'
 * money that funded it appeared nowhere. Netting the table gave −62,325 on a
 * cycle that had been settled in full and owed nobody anything — the business
 * looked to have spent money it never received, understated by exactly what
 * the partners had contributed.
 *
 * A contribution is a standing figure that can be edited, but money moving is
 * an event. So this posts the DIFFERENCE rather than the new total: raise a
 * contribution and the increase comes in, lower it and the excess goes back.
 * The entries then always sum to the current figure without any of them being
 * rewritten, which is what keeps the ledger an audit trail rather than a
 * mirror of a mutable column.
 *
 * One definition (CLAUDE.md §11) for every path that changes a contribution:
 * the cycle page's edit and Split equally (`CyclesService`), and a
 * contribution drawn from a partner's running account (§8, 2026-10-25,
 * `PartnerAccountsService`) — the account itself is not cash; this row is the
 * moment his money enters the cycle, exactly as an entered contribution.
 */
export async function recordContributionChange(
  tx: Prisma.TransactionClient,
  args: {
    cycleId: string;
    cycleCode: string;
    participantId: string;
    before: Prisma.Decimal | number;
    after: Prisma.Decimal | number;
    isInvestor: boolean;
    actorId: string;
  },
) {
  const before = new Prisma.Decimal(args.before ?? 0);
  const after = new Prisma.Decimal(args.after ?? 0);
  const delta = after.sub(before);
  if (delta.isZero()) return;

  const who = args.isInvestor ? 'investor' : 'partner';
  await tx.financialTransaction.create({
    data: {
      type: 'CAPITAL_CONTRIBUTION',
      category: 'contribution',
      // A reduction is capital handed back, so the money leaves.
      direction: delta.gt(0) ? 'INFLOW' : 'OUTFLOW',
      amount: delta.abs().toDecimalPlaces(2),
      currency: 'EGP',
      cycleId: args.cycleId,
      relatedType: 'CYCLE_PARTICIPANT',
      relatedId: args.participantId,
      reason: delta.gt(0)
        ? `Capital put into ${args.cycleCode} by ${who}`
        : `Capital returned from ${args.cycleCode} to ${who}`,
      createdBy: args.actorId,
    },
  });
}
