// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money in EGP must not become a float
import { Prisma } from '@prisma/client';
import { badRequest } from './api-error';
import { formatMoney } from './money';

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
  if (delta.lt(0)) await assertNotBelowTakenBack(tx, args.participantId, after);

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

/**
 * A contribution cannot drop below the capital its holder already took back
 * early and still stands (§8, 2026-11-08): he would have taken back more than
 * he put in, and his capital back at settlement would go below nothing.
 * Undo what he took back first.
 */
async function assertNotBelowTakenBack(
  tx: Prisma.TransactionClient,
  participantId: string,
  after: Prisma.Decimal,
) {
  const p = await tx.cycleParticipant.findUnique({
    where: { id: participantId },
    select: { cycleId: true, partnerUserId: true, investorUserId: true },
  });
  const userId = p?.partnerUserId ?? p?.investorUserId;
  if (!p || !userId) return;
  const { _sum } = await tx.profitDraw.aggregate({
    where: {
      kind: 'CAPITAL',
      cycleId: p.cycleId,
      partnerUserId: userId,
      reversedAt: null,
      settledById: null,
    },
    _sum: { amountEgp: true },
  });
  const taken = new Prisma.Decimal(_sum.amountEgp ?? 0);
  if (after.lt(taken)) {
    throw badRequest(
      'CONTRIBUTION_BELOW_CAPITAL_TAKEN_BACK',
      `${formatMoney(taken)} EGP of this capital was already taken back early, so the contribution cannot go below it. Undo what was taken back first.`,
      { taken: formatMoney(taken) },
    );
  }
}
