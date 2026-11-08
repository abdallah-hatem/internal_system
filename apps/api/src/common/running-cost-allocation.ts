// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma, type CycleStatus } from '@prisma/client';
import { badRequest } from './api-error';
import { isRunningCostEntry } from './running-costs';
import { NOT_OPERATING_EXPENSE } from './ledger-categories';

/**
 * Running costs shared to the selling cycles (BUSINESS_LOGIC §8, owner
 * 2026-11-08: "investor has to pay for everything as well, fuel, packaging
 * etc... its all one process" and "there will be expenses not attached to a
 * cycle lets say rent").
 *
 * An expense recorded with no cycle is split equally over the cycles running
 * when it is recorded — paid for and not yet settled (`TAKES_RUNNING_COSTS`);
 * with none running, it waits and goes to the cycles running when the next
 * one's order is paid. On each cycle its part is a cost like any
 * charged to it: it lowers the cycle's profit, so every participant, investors
 * included, bears it by share. The parts are stored once (`running_cost_
 * allocations`) and never move: a cycle being settled or settled takes no new
 * ones, and a cost shared to one cannot be undone until that is reversed.
 *
 * The one definition every reader uses (rule 11): the settlement and its cost
 * breakdown, the cycle's profitability in Analytics, and what a partner may
 * take early (profit draws read the settlement's projection).
 */

const ZERO = new Prisma.Decimal(0);

type Db = Prisma.TransactionClient;

/** One assignment at a time: two writers must not share the same waiting cost twice. */
const ALLOCATION_LOCK = 7_000_000_011;

/**
 * The statuses a cycle takes new running costs in (owner 2026-11-08: "a cost
 * is shared the moment we pay for the goods from china or uae, not when we
 * start selling"): from its order being confirmed and paid (Preparing) through
 * shipping, arrival and selling — until its settlement is approved (Settlement,
 * Closed). Not while it is still being planned, funded or bought.
 */
export const TAKES_RUNNING_COSTS = [
  'PREPARING',
  'IN_TRANSIT',
  'ARRIVED_UAE',
  'IN_TRANSIT_TO_EGYPT',
  'ARRIVED_EGYPT',
  'VERIFICATION',
  'SELLING',
] as const satisfies readonly CycleStatus[];

export function takesRunningCosts(status: string): boolean {
  return (TAKES_RUNNING_COSTS as readonly string[]).includes(status);
}

/**
 * `amount` in `n` equal parts to the piastre, the odd piastres to the last
 * (as `splitEqually` gives the last partner the odd piastre). Re-sums to
 * `amount` exactly.
 */
export function equalParts(
  amount: Prisma.Decimal,
  n: number,
): Prisma.Decimal[] {
  if (n <= 0) return [];
  const each = amount.div(n).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  const parts = Array.from({ length: n }, () => each);
  parts[n - 1] = amount.sub(each.mul(n - 1));
  return parts;
}

/** The cycles that take a running cost now: running, and no settlement approved or paid. */
export async function cyclesTakingRunningCosts(
  db: Pick<Db, 'importCycle'>,
): Promise<{ id: string; code: string }[]> {
  return db.importCycle.findMany({
    where: {
      status: { in: [...TAKES_RUNNING_COSTS] },
      settlements: { none: { status: { in: ['APPROVED', 'PAID'] } } },
    },
    select: { id: true, code: true },
    orderBy: [{ startedOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
}

/**
 * Share every waiting running cost to the cycles running now. A running cost
 * waits when it has no part on any cycle, stands (not undone), and was never
 * taken from the partners' payouts the old way (before 2026-11-08). Nothing
 * when no cycle is running: they keep waiting.
 *
 * Called after a cost with no cycle is recorded, when a cycle moves into a
 * running status (its order paid, or selling again after its settlement is
 * reversed), and before a settlement is calculated — each inside its own
 * transaction.
 */
export async function assignWaitingRunningCosts(
  tx: Db,
): Promise<
  { costEntryId: string; cycleId: string; amountEgp: Prisma.Decimal }[]
> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ALLOCATION_LOCK})`;
  const cycles = await cyclesTakingRunningCosts(tx);
  if (cycles.length === 0) return [];

  const candidates = await tx.financialTransaction.findMany({
    where: {
      cycleId: null,
      reversalOfId: null,
      direction: 'OUTFLOW',
      category: { notIn: [...NOT_OPERATING_EXPENSE] },
      runningCostAllocations: { none: {} },
      runningCostCharges: { none: { releasedAt: null } },
    },
    select: {
      id: true,
      direction: true,
      category: true,
      amount: true,
      cycleId: true,
      reversalOfId: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (candidates.length === 0) return [];
  const undone = new Set(
    (
      await tx.financialTransaction.findMany({
        where: { reversalOfId: { in: candidates.map((c) => c.id) } },
        select: { reversalOfId: true },
      })
    ).map((r) => r.reversalOfId as string),
  );

  const written: {
    costEntryId: string;
    cycleId: string;
    amountEgp: Prisma.Decimal;
  }[] = [];
  for (const cost of candidates) {
    if (undone.has(cost.id) || !isRunningCostEntry(cost)) continue;
    const parts = equalParts(new Prisma.Decimal(cost.amount), cycles.length);
    for (const [i, cycle] of cycles.entries()) {
      // A cost of a piastre over two cycles: the empty part is no part.
      if (parts[i].lte(0)) continue;
      await tx.runningCostAllocation.create({
        data: { costEntryId: cost.id, cycleId: cycle.id, amountEgp: parts[i] },
      });
      written.push({
        costEntryId: cost.id,
        cycleId: cycle.id,
        amountEgp: parts[i],
      });
    }
  }
  return written;
}

/** Each cycle's shared running costs, by category, from the stored parts. */
export async function sharedRunningCosts(
  db: Pick<Db, 'runningCostAllocation'>,
  cycleIds: string[],
): Promise<
  Map<
    string,
    { totalEgp: Prisma.Decimal; byCategory: Map<string, Prisma.Decimal> }
  >
> {
  const out = new Map<
    string,
    { totalEgp: Prisma.Decimal; byCategory: Map<string, Prisma.Decimal> }
  >();
  if (cycleIds.length === 0) return out;
  const rows = await db.runningCostAllocation.findMany({
    where: { cycleId: { in: cycleIds } },
    select: {
      cycleId: true,
      amountEgp: true,
      costEntry: { select: { category: true } },
    },
  });
  for (const r of rows) {
    const entry = out.get(r.cycleId) ?? {
      totalEgp: ZERO,
      byCategory: new Map<string, Prisma.Decimal>(),
    };
    const amount = new Prisma.Decimal(r.amountEgp);
    entry.totalEgp = entry.totalEgp.add(amount);
    entry.byCategory.set(
      r.costEntry.category,
      (entry.byCategory.get(r.costEntry.category) ?? ZERO).add(amount),
    );
    out.set(r.cycleId, entry);
  }
  return out;
}

/**
 * Undoing a running cost takes its parts off the cycles it was shared to —
 * refused while any of them is being settled or settled (the split there is
 * agreed): reverse that settlement first. In the undo's own transaction.
 */
export async function releaseRunningCost(tx: Db, costEntryId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ALLOCATION_LOCK})`;
  const parts = await tx.runningCostAllocation.findMany({
    where: { costEntryId },
    select: {
      id: true,
      cycle: {
        select: {
          code: true,
          status: true,
          settlements: {
            where: { status: { in: ['APPROVED', 'PAID'] } },
            select: { id: true },
          },
        },
      },
    },
  });
  const settled = parts
    .filter(
      (p) =>
        p.cycle.settlements.length > 0 ||
        ['SETTLEMENT', 'CLOSED', 'CANCELLED'].includes(p.cycle.status),
    )
    .map((p) => p.cycle.code);
  if (settled.length > 0) {
    const cycles = [...new Set(settled)].join(', ');
    throw badRequest(
      'RUNNING_COST_SETTLED',
      `This running cost is part of ${cycles}'s settlement. Reverse that settlement first, then this entry.`,
      { cycles },
    );
  }
  if (parts.length > 0) {
    await tx.runningCostAllocation.deleteMany({ where: { costEntryId } });
  }
}
