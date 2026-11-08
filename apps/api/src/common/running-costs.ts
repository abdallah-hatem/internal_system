// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money in EGP must not become a float
import { Prisma } from '@prisma/client';
import { businessDay } from './dates';
import {
  NOT_OPERATING_EXPENSE,
  operatingExpenseEgp,
} from './ledger-categories';

/**
 * Which ledger rows are running costs, and each one net of any undone (§8).
 *
 * A running cost is an operating expense recorded with no cycle — rent,
 * salaries, fuel, packaging. Since 2026-11-08 (owner: "investor has to pay
 * for everything as well") it is shared to the cycles selling when it is
 * recorded and comes off their profit, borne by every participant
 * (`running-cost-allocation.ts`).
 *
 * Before then (L7, 2026-10-11) it was the core partners' alone, each one's
 * share fixed on the cost's day (`running_cost_shares`) and taken from his
 * payouts (`running_cost_charges`, a RUNNING_COSTS settlement line). Nothing
 * writes those any more; this file still reads them so a settlement paid that
 * way explains itself, and a cost taken that way is never shared again.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);

/** A core partner. Order matters: oldest first, see `splitEqually`. */
export interface RunningCostPartner {
  userId: string;
  name: string | null;
  /** The Cairo day he became a partner (his partner record). */
  joinedOn?: string;
}

/** One running cost, net of any reversal of it, with its fixed shares. */
export interface RunningCost {
  id: string;
  /** The Cairo day it was spent. */
  day: string;
  category: string;
  amount: Prisma.Decimal;
  /** Who owes what of it: fixed once, never re-split (zero when reversed). */
  shares: Map<string, Prisma.Decimal>;
}

/** Part of a cost already taken from a payout that stands. */
export interface StandingCharge {
  costEntryId: string;
  partnerUserId: string;
  amount: Prisma.Decimal;
}

/** A share to store: cost, partner, amount. */
export type FixedShare = StandingCharge;

/**
 * Split an amount equally among partners, in piastres.
 *
 * Each share is rounded DOWN to the piastre and the residual goes to the LAST
 * partner in the list — the core partner who joined last (partners are passed
 * oldest first). Stated, and deterministic: never rounding deciding who pays
 * (working rules §10). Rounding down means the residual partner never pays
 * less than the others: 100 is 33.33 / 33.33 / 33.34.
 */
export function splitEqually(
  amount: Prisma.Decimal,
  partners: RunningCostPartner[],
): Map<string, Prisma.Decimal> {
  const shares = new Map<string, Prisma.Decimal>();
  if (partners.length === 0) return shares;
  const each = amount
    .div(partners.length)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  partners.forEach((p, i) => {
    shares.set(
      p.userId,
      i === partners.length - 1
        ? amount.sub(each.mul(partners.length - 1))
        : each,
    );
  });
  return shares;
}

/**
 * The partners who share a cost spent on `day`: those of `partners` (active,
 * oldest first) who had joined by that day. A partner who joins later owes
 * nothing of it.
 *
 * If none had joined by then — a cost from before the business's partners were
 * entered here, typed in from old books — it is shared by all of them: a cost
 * with nobody to owe it would wait forever. (Guess, §8, 2026-10-12.)
 */
export function sharersOn(
  day: string,
  partners: RunningCostPartner[],
): RunningCostPartner[] {
  const then = partners.filter((p) => !p.joinedOn || p.joinedOn <= day);
  return then.length > 0 ? then : partners;
}

/** Oldest first: by the day spent, then by id, so the order never wobbles. */
function oldestFirst<T extends { day: string; id: string }>(costs: T[]): T[] {
  return [...costs].sort((a, b) =>
    a.day === b.day ? a.id.localeCompare(b.id) : a.day.localeCompare(b.day),
  );
}

/** A ledger row as `isRunningCostEntry` reads it. */
export interface LedgerRowForRunningCosts {
  id: string;
  direction: string;
  category: string;
  amount: Prisma.Decimal.Value;
  cycleId: string | null;
  reversalOfId: string | null;
}

/**
 * Is this ledger row a running cost? An operating expense — through the one
 * definition the settlement and the dashboard read (`operatingExpenseEgp`) —
 * charged to no cycle, and not itself a reversal. A cost charged to a cycle is
 * that cycle's, inside its profit; it is never a running cost.
 */
export function isRunningCostEntry(row: LedgerRowForRunningCosts): boolean {
  return (
    row.cycleId === null &&
    row.reversalOfId === null &&
    row.direction === 'OUTFLOW' &&
    operatingExpenseEgp(row).gt(0)
  );
}

type CostRow = LedgerRowForRunningCosts & {
  occurredOn: Date | null;
  createdAt: Date;
};

const dayOf = (row: { occurredOn: Date | null; createdAt: Date }) =>
  row.occurredOn
    ? row.occurredOn.toISOString().slice(0, 10)
    : businessDay(row.createdAt);

/**
 * The running costs in a set of ledger rows, each net of its reversals: a
 * reversed cost is still listed, at zero, and owes nothing. Oldest first.
 *
 * `fixed`: the stored shares, by cost. A cost with none gets them now, over
 * `partners` as of its day (`sharersOn`) — and is listed in `unfixed`, so a
 * caller with write access can store them.
 */
export function runningCostsFromRows(
  rows: CostRow[],
  partners: RunningCostPartner[] = [],
  fixed: Map<string, Map<string, Prisma.Decimal>> = new Map(),
): { costs: RunningCost[]; unfixed: FixedShare[] } {
  const unfixed: FixedShare[] = [];
  const costs = rows.filter(isRunningCostEntry).map((c): RunningCost => {
    const net = rows
      .filter((r) => r.id === c.id || r.reversalOfId === c.id)
      .reduce((s, r) => s.add(operatingExpenseEgp(r)), ZERO);
    const day = dayOf(c);
    let shares = fixed.get(c.id);
    if (!shares || shares.size === 0) {
      shares = splitEqually(D(c.amount), sharersOn(day, partners));
      for (const [partnerUserId, amount] of shares) {
        unfixed.push({ costEntryId: c.id, partnerUserId, amount });
      }
    }
    const live = net.gt(0);
    return {
      id: c.id,
      day,
      category: c.category,
      amount: live ? net : ZERO,
      // A reversed cost owes nobody anything; its shares stay stored.
      shares: live
        ? shares
        : new Map([...shares.keys()].map((k) => [k, ZERO] as const)),
    };
  });
  return { costs: oldestFirst(costs), unfixed };
}

type Db = {
  partner: Pick<Prisma.TransactionClient['partner'], 'findMany'>;
  user: Pick<Prisma.TransactionClient['user'], 'findMany'>;
  financialTransaction: Pick<
    Prisma.TransactionClient['financialTransaction'],
    'findMany'
  >;
  runningCostCharge: Pick<
    Prisma.TransactionClient['runningCostCharge'],
    'findMany'
  >;
  runningCostShare: Pick<
    Prisma.TransactionClient['runningCostShare'],
    'findMany'
  >;
};

export interface RunningCostsState {
  /** The core partners who can be charged now: active, oldest first. */
  partners: RunningCostPartner[];
  /** Everyone holding a share, the active and those who left. */
  people: RunningCostPartner[];
  costs: RunningCost[];
  charges: StandingCharge[];
  /** Shares worked out now for costs that had none stored yet. */
  unfixed: FixedShare[];
}

/**
 * Read what the arithmetic needs: the active core partners (oldest first, so
 * the one who joined last takes the residual), every running cost net of its
 * reversals with its fixed shares, and every charge that stands (a released
 * one — its settlement reversed — does not). Reads only; see
 * `fixRunningCostShares` for the writer.
 */
export async function loadRunningCosts(db: Db): Promise<RunningCostsState> {
  const partnerRows = await db.partner.findMany({
    where: { active: true, user: { role: 'CORE_PARTNER', status: 'ACTIVE' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { userId: true, displayName: true, createdAt: true },
  });
  const partners: RunningCostPartner[] = partnerRows.map((p) => ({
    userId: p.userId,
    name: p.displayName,
    joinedOn: businessDay(p.createdAt),
  }));

  const costRows = await db.financialTransaction.findMany({
    where: {
      cycleId: null,
      reversalOfId: null,
      direction: 'OUTFLOW',
      category: { notIn: [...NOT_OPERATING_EXPENSE] },
    },
    select: ROW_SELECT,
  });
  const costIds = costRows.map((r) => r.id);
  const reversalRows = costIds.length
    ? await db.financialTransaction.findMany({
        where: { reversalOfId: { in: costIds } },
        select: ROW_SELECT,
      })
    : [];
  const shareRows = costIds.length
    ? await db.runningCostShare.findMany({
        where: { costEntryId: { in: costIds } },
        select: { costEntryId: true, partnerUserId: true, amount: true },
      })
    : [];
  const fixed = new Map<string, Map<string, Prisma.Decimal>>();
  for (const s of shareRows) {
    const m = fixed.get(s.costEntryId) ?? new Map<string, Prisma.Decimal>();
    m.set(s.partnerUserId, D(s.amount));
    fixed.set(s.costEntryId, m);
  }

  const chargeRows = await db.runningCostCharge.findMany({
    where: { releasedAt: null },
    select: { costEntryId: true, partnerUserId: true, amount: true },
  });

  const { costs, unfixed } = runningCostsFromRows(
    [...costRows, ...reversalRows],
    partners,
    fixed,
  );

  // Partners who left but still hold a share: named, so their part shows as theirs.
  const activeIds = new Set(partners.map((p) => p.userId));
  const leftIds = [...new Set(shareRows.map((s) => s.partnerUserId))].filter(
    (id) => !activeIds.has(id),
  );
  const leftRows = leftIds.length
    ? await db.user.findMany({
        where: { id: { in: leftIds } },
        select: { id: true, partner: { select: { displayName: true } } },
      })
    : [];

  return {
    partners,
    people: [
      ...partners,
      ...leftRows.map((u) => ({
        userId: u.id,
        name: u.partner?.displayName ?? null,
      })),
    ],
    costs,
    charges: chargeRows.map((c) => ({ ...c, amount: D(c.amount) })),
    unfixed,
  };
}

const ROW_SELECT = {
  id: true,
  direction: true,
  category: true,
  amount: true,
  cycleId: true,
  reversalOfId: true,
  occurredOn: true,
  createdAt: true,
} as const;

export function thisQuarter(day: string): { from: string; to: string } {
  const [y, m] = day.split('-').map(Number);
  const first = Math.floor((m - 1) / 3) * 3 + 1;
  // Day 0 of the month after the quarter is its last day (UTC, so no drift).
  const last = new Date(Date.UTC(y, first + 2, 0)).toISOString().slice(0, 10);
  return { from: `${y}-${String(first).padStart(2, '0')}-01`, to: last };
}

/** "2026-07-01 – 2026-09-30": the days a payout's running-cost line covers. */
export function periodOf(days: string[]): { from: string; to: string } | null {
  if (days.length === 0) return null;
  const sorted = [...days].sort();
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}
