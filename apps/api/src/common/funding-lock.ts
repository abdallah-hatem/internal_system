import type { Prisma } from '@prisma/client';
import { badRequest } from './api-error';

/**
 * When a cycle's funding stops changing (BUSINESS_LOGIC §8, owner 2026-10-18).
 *
 * Funding is what a cycle's profit is split on: each participant's
 * contribution, a custom split, and what friends paid (§18 — since 2026-10-19
 * a loan the partners repay, their contributions being their shares of it; his
 * payment still decides what is owed and the exchange difference). Once a
 * settlement is approved the split
 * is agreed, and once it is paid the money has gone out on it — changing the
 * funding afterwards made the paid split disagree with the cycle, with no
 * refusal anywhere. So from approval on it is locked, until the settlement is
 * reversed (which returns the cycle to Selling).
 *
 * One definition for every path that changes the basis: a contribution or a
 * custom split edited ("Split equally" goes through the same edit), a
 * participant added, a friend's payment recorded or removed. The cycle page
 * reads the same reason to show why its controls are locked.
 */

/** Why funding is locked, or null when it may still change. */
export type FundingLock =
  'SETTLEMENT_APPROVED' | 'SETTLEMENT_PAID' | 'CYCLE_CLOSED';

export function fundingLockOf(
  cycleStatus: string,
  settlements: { status: string }[] = [],
): FundingLock | null {
  if (settlements.some((s) => s.status === 'PAID')) return 'SETTLEMENT_PAID';
  if (settlements.some((s) => s.status === 'APPROVED'))
    return 'SETTLEMENT_APPROVED';
  if (cycleStatus === 'CLOSED') return 'CYCLE_CLOSED';
  return null;
}

type Db = Pick<Prisma.TransactionClient, 'importCycle' | 'settlement'>;

/** Refuse a change to a cycle's funding once its settlement is approved. */
export async function assertFundingOpen(db: Db, cycleId: string) {
  const cycle = await db.importCycle.findUnique({
    where: { id: cycleId },
    select: { code: true, status: true },
  });
  if (!cycle) return;
  const settlements = await db.settlement.findMany({
    where: { cycleId, status: { in: ['APPROVED', 'PAID'] } },
    select: { status: true },
  });
  const lock = fundingLockOf(cycle.status, settlements);
  if (!lock) return;
  throw badRequest(
    'FUNDING_LOCKED_AFTER_SETTLEMENT',
    lock === 'CYCLE_CLOSED'
      ? `Cycle ${cycle.code} is closed; its funding can no longer change.`
      : `Cycle ${cycle.code}'s settlement is ${lock === 'SETTLEMENT_PAID' ? 'paid' : 'approved'}; its funding can no longer change. Reverse the settlement first.`,
    { cycle: cycle.code, reason: lock },
  );
}

/**
 * Whether the funding changed after `since` — a participant added or edited,
 * a friend's payment recorded or removed. A draft settlement calculated
 * before such a change splits on figures that are no longer the cycle's, so
 * approving it is refused until it is calculated again.
 */
export async function fundingChangedSince(
  db: Pick<Prisma.TransactionClient, 'cycleParticipant' | 'lenderFinancing'>,
  cycleId: string,
  since: Date,
): Promise<boolean> {
  const participant = await db.cycleParticipant.findFirst({
    where: {
      cycleId,
      OR: [{ createdAt: { gt: since } }, { updatedAt: { gt: since } }],
    },
    select: { id: true },
  });
  if (participant) return true;
  const financing = await db.lenderFinancing.findFirst({
    where: {
      cycleId,
      OR: [{ createdAt: { gt: since } }, { removedAt: { gt: since } }],
    },
    select: { id: true },
  });
  return Boolean(financing);
}
