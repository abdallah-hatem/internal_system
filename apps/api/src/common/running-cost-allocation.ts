// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma, type CycleStatus } from '@prisma/client';
import { badRequest } from './api-error';
import { businessDay } from './dates';
import { isRunningCostEntry } from './running-costs';
import { NOT_OPERATING_EXPENSE } from './ledger-categories';

/**
 * Running costs shared to the selling cycles (BUSINESS_LOGIC §8, owner
 * 2026-11-08: "investor has to pay for everything as well, fuel, packaging
 * etc... its all one process" and "there will be expenses not attached to a
 * cycle lets say rent").
 *
 * An expense recorded with no cycle is split equally over the cycles running
 * **on the day it is dated** (owner 2026-11-08: "by day its dated, we need to
 * know when statuses moved") — paid for and not yet settled
 * (`TAKES_RUNNING_COSTS`), read from each cycle's status history
 * (`cycle_status_changes`, kept by a database trigger). With none running that
 * day, it goes to the next cycle whose goods were paid for after it — or waits
 * for one. On each cycle its part is a cost like any
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

/** A cycle as the dated-day rule reads it: its history, and whether it is settled. */
export interface CycleHistory {
  id: string;
  createdAt: Date;
  /** Its status now: used alone when no history was recorded. */
  status: string;
  /** Being settled, settled, closed or cancelled: takes no new cost. */
  locked: boolean;
  /** Every status change, oldest first; the first may be its creation (from null). */
  changes: { fromStatus: string | null; toStatus: string; changedAt: Date }[];
}

/**
 * Each stretch of time the cycle spent in one status: [start, end), the last
 * open-ended. With no history recorded, its status now since it was created.
 */
function stretches(c: CycleHistory) {
  const changes = [...c.changes].sort(
    (a, b) => a.changedAt.getTime() - b.changedAt.getTime(),
  );
  if (changes.length === 0) {
    return [{ status: c.status, start: c.createdAt, end: null as Date | null }];
  }
  const out: { status: string; start: Date; end: Date | null }[] = [];
  // Before the first recorded change it was in that change's "from" status
  // since it was created.
  const first = changes[0];
  if (first.fromStatus && c.createdAt < first.changedAt) {
    out.push({
      status: first.fromStatus,
      start: c.createdAt,
      end: first.changedAt,
    });
  }
  changes.forEach((ch, i) => {
    out.push({
      status: ch.toStatus,
      start: ch.changedAt,
      end: i + 1 < changes.length ? changes[i + 1].changedAt : null,
    });
  });
  return out;
}

/** Was the cycle running at any moment of `day` (a Cairo day)? */
export function runningOn(c: CycleHistory, day: string): boolean {
  return stretches(c).some((s) => {
    if (!takesRunningCosts(s.status)) return false;
    if (s.end && s.end.getTime() <= s.start.getTime()) return false;
    const firstDay = businessDay(s.start);
    // The last instant inside the stretch, so one ending exactly at midnight
    // does not reach into the day after.
    const lastDay = s.end ? businessDay(new Date(s.end.getTime() - 1)) : null;
    return firstDay <= day && (lastDay === null || lastDay >= day);
  });
}

/** The moments (and Cairo days) the cycle moved into a running status — its goods paid for. */
export function runningEntries(c: CycleHistory): { day: string; at: Date }[] {
  const out: { day: string; at: Date }[] = [];
  let before: string | null = null;
  for (const s of stretches(c)) {
    // A status held for no time at all (two changes at one instant) is passed
    // through, not entered.
    if (s.end && s.end.getTime() <= s.start.getTime()) continue;
    if (takesRunningCosts(s.status) && !(before && takesRunningCosts(before))) {
      out.push({ day: businessDay(s.start), at: s.start });
    }
    before = s.status;
  }
  return out;
}

/**
 * The cycles a running cost dated `day` is shared to, in the order the odd
 * piastres go (the last takes them): the ones running at any moment that day
 * and not settled now; with none, the ones whose goods were next paid for
 * after that day (all of those that same day), not settled now; with none,
 * nobody yet — it waits. Pure: the database read is `loadCycleHistories`.
 */
export function cyclesForCost(day: string, cycles: CycleHistory[]): string[] {
  const open = cycles.filter((c) => !c.locked);
  const firstEntry = (c: CycleHistory) =>
    runningEntries(c)[0]?.at.getTime() ?? c.createdAt.getTime();
  const order = (a: CycleHistory, b: CycleHistory) =>
    firstEntry(a) - firstEntry(b) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id);

  const that = open.filter((c) => runningOn(c, day)).sort(order);
  if (that.length > 0) return that.map((c) => c.id);

  const next: { c: CycleHistory; day: string }[] = [];
  for (const c of open) {
    const entry = runningEntries(c).find((e) => e.day > day);
    if (entry) next.push({ c, day: entry.day });
  }
  if (next.length === 0) return [];
  const soonest = next.reduce((d, x) => (x.day < d ? x.day : d), next[0].day);
  return next
    .filter((x) => x.day === soonest)
    .map((x) => x.c)
    .sort(order)
    .map((c) => c.id);
}

/** Every cycle with its status history and whether it is settled. */
export async function loadCycleHistories(
  db: Pick<Db, 'importCycle'>,
): Promise<CycleHistory[]> {
  const rows = await db.importCycle.findMany({
    select: {
      id: true,
      status: true,
      createdAt: true,
      settlements: {
        where: { status: { in: ['APPROVED', 'PAID'] } },
        select: { id: true },
      },
      statusChanges: {
        select: { fromStatus: true, toStatus: true, changedAt: true },
        orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
      },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    locked:
      r.settlements.length > 0 ||
      ['SETTLEMENT', 'CLOSED', 'CANCELLED'].includes(r.status),
    changes: r.statusChanges ?? [],
  }));
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
  const cycles = await loadCycleHistories(tx);
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
      occurredOn: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (candidates.length === 0) {
    await reshareOpenCosts(tx, cycles);
    return [];
  }
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
    // The day it is dated (the Cairo day it was entered, for an old row
    // with none) decides which cycles bear it.
    const day = cost.occurredOn
      ? cost.occurredOn.toISOString().slice(0, 10)
      : businessDay(cost.createdAt);
    const to = cyclesForCost(day, cycles);
    if (to.length === 0) continue; // waits
    written.push(...(await writeParts(tx, cost.id, cost.amount, to)));
  }
  await reshareOpenCosts(tx, cycles);
  return written;
}

/** A cost's equal parts over `to`, written; a part of nothing is no part. */
async function writeParts(
  tx: Db,
  costEntryId: string,
  amount: Prisma.Decimal | string | number,
  to: string[],
) {
  const parts = equalParts(new Prisma.Decimal(amount), to.length);
  const out: {
    costEntryId: string;
    cycleId: string;
    amountEgp: Prisma.Decimal;
  }[] = [];
  for (const [i, cycleId] of to.entries()) {
    // A cost of a piastre over two cycles: the empty part is no part.
    if (parts[i].lte(0)) continue;
    await tx.runningCostAllocation.create({
      data: { costEntryId, cycleId, amountEgp: parts[i] },
    });
    out.push({ costEntryId, cycleId, amountEgp: parts[i] });
  }
  return out;
}

/** "cycleId amount" per part, in order: two splits are the same when these are. */
const splitKey = (parts: { cycleId: string; amountEgp: Prisma.Decimal }[]) =>
  parts.map((p) => `${p.cycleId} ${p.amountEgp.toFixed(2)}`).join('|');

/**
 * A cost already shared, none of whose cycles is being settled yet, is split
 * again when the cycles for its day are not the ones holding it — a cycle whose
 * goods were paid for later that same day ran that day too ("a cycle running
 * at any moment of that Cairo day counts", §8, 2026-11-08). Without this the
 * split depended on the hour the cost was typed in: rent entered at 10:00 went
 * wholly to the cycle selling then, entered at 16:00 it was halved with the one
 * paid for at 15:00. Once any cycle holding a part is being settled, settled,
 * closed or cancelled the cost never moves (its split is agreed there). A
 * draft settlement the move touches is refused at approval
 * (`SETTLEMENT_STALE_COSTS`) and calculated again.
 */
async function reshareOpenCosts(tx: Db, cycles: CycleHistory[]) {
  const lockedIds = new Set(cycles.filter((c) => c.locked).map((c) => c.id));
  const shared = await tx.financialTransaction.findMany({
    where: {
      cycleId: null,
      reversalOfId: null,
      direction: 'OUTFLOW',
      runningCostAllocations: { some: {} },
    },
    select: {
      id: true,
      amount: true,
      occurredOn: true,
      createdAt: true,
      runningCostAllocations: {
        select: { cycleId: true, amountEgp: true, createdAt: true, id: true },
      },
    },
  });
  for (const cost of shared) {
    const held = cost.runningCostAllocations;
    if (held.some((p) => lockedIds.has(p.cycleId))) continue;
    const day = cost.occurredOn
      ? cost.occurredOn.toISOString().slice(0, 10)
      : businessDay(cost.createdAt);
    const to = cyclesForCost(day, cycles);
    if (to.length === 0) continue; // nothing to move it to: it stays
    const want = equalParts(new Prisma.Decimal(cost.amount), to.length)
      .map((amountEgp, i) => ({ cycleId: to[i], amountEgp }))
      .filter((p) => p.amountEgp.gt(0));
    const have = to
      .map((cycleId) => held.find((p) => p.cycleId === cycleId))
      .filter((p) => p !== undefined)
      .map((p) => ({
        cycleId: p.cycleId,
        amountEgp: new Prisma.Decimal(p.amountEgp),
      }));
    if (held.length === want.length && splitKey(have) === splitKey(want)) {
      continue;
    }
    await tx.runningCostAllocation.deleteMany({
      where: { costEntryId: cost.id },
    });
    await writeParts(tx, cost.id, cost.amount, to);
  }
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
