// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money in EGP must not become a float
import { Prisma } from '@prisma/client';
import { businessDay } from './dates';
import {
  NOT_OPERATING_EXPENSE,
  operatingExpenseEgp,
} from './ledger-categories';

/**
 * General running costs come out of the core partners' payouts (§8, owner
 * 2026-10-11; built L7).
 *
 * A running cost is an operating expense recorded with no cycle — rent,
 * salaries, power. It is the core partners', equally; a temporary investor
 * never shares it. It does not touch any cycle's profit. When a settlement is
 * paid out, each core partner on it has his share of the costs still waiting
 * taken from his payout, oldest first, as far as the payout covers; the rest
 * waits for his next payout, from whichever cycle.
 *
 * **Each cost's shares are fixed once** (alignment review, 2026-10-12), over
 * the core partners active on the cost's own day, and never change: a partner
 * who leaves keeps owing his share (it waits, shown as his), and one who joins
 * after the day owes nothing of it. Re-splitting over whoever is active at
 * each payout — the first build — quietly moved a leaving partner's part onto
 * the others. The shares are stored (`running_cost_shares`) the first time a
 * cost is seen with write access: recording it, or a Mark paid.
 *
 * Everything else here is arithmetic over rows already read, so the settlement
 * screen's "if paid now", Mark paid itself and the Partners page cannot
 * disagree (rule 11).
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

export type PlannedCharge = StandingCharge;

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

function chargedBy(charges: StandingCharge[]) {
  const byCost = new Map<string, Prisma.Decimal>();
  const byCostPartner = new Map<string, Prisma.Decimal>();
  for (const c of charges) {
    byCost.set(
      c.costEntryId,
      (byCost.get(c.costEntryId) ?? ZERO).add(c.amount),
    );
    const key = `${c.costEntryId}|${c.partnerUserId}`;
    byCostPartner.set(key, (byCostPartner.get(key) ?? ZERO).add(c.amount));
  }
  return {
    cost: (id: string) => byCost.get(id) ?? ZERO,
    partner: (id: string, userId: string) =>
      byCostPartner.get(`${id}|${userId}`) ?? ZERO,
  };
}

/**
 * What one payout takes: for each core partner with a payout on it
 * (`capacities`: user id → what the settlement pays him), his fixed share of
 * every waiting cost, oldest first, until his payout is used up.
 *
 * - A partner not in `partners` (a temporary investor; a core partner no longer
 *   active) is never charged — his share waits.
 * - A payout of nothing or less (a loss) takes nothing.
 * - Never more than his own share, never more than the cost has left: across
 *   every payout a cost's charges add up to it at most — charged once in total.
 */
export function planRunningCostCharges(input: {
  costs: RunningCost[];
  partners: RunningCostPartner[];
  charges: StandingCharge[];
  capacities: Map<string, Prisma.Decimal>;
}): PlannedCharge[] {
  const costs = oldestFirst(input.costs).filter((c) => c.amount.gt(0));
  const planned: PlannedCharge[] = [];

  for (const partner of input.partners) {
    const capacity = input.capacities.get(partner.userId);
    if (!capacity) continue;
    let left = capacity;
    for (const cost of costs) {
      if (left.lte(0)) break;
      const charged = chargedBy([...input.charges, ...planned]);
      const share = cost.shares.get(partner.userId) ?? ZERO;
      const owed = Prisma.Decimal.min(
        share.sub(charged.partner(cost.id, partner.userId)),
        cost.amount.sub(charged.cost(cost.id)),
      );
      if (owed.lte(0)) continue;
      const take = Prisma.Decimal.min(owed, left);
      planned.push({
        costEntryId: cost.id,
        partnerUserId: partner.userId,
        amount: take,
      });
      left = left.sub(take);
    }
  }
  return planned;
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

export interface RunningCostsSummary {
  byCategory: { category: string; spentEgp: Prisma.Decimal }[];
  spentEgp: Prisma.Decimal;
  chargedEgp: Prisma.Decimal;
  waitingEgp: Prisma.Decimal;
  partners: {
    userId: string;
    name: string | null;
    shareEgp: Prisma.Decimal;
    chargedEgp: Prisma.Decimal;
    waitingEgp: Prisma.Decimal;
    /** Takes the odd piastre on a cost spent today (§10). */
    takesResidual: boolean;
    /** Still a core partner — one who left keeps owing his share. */
    active: boolean;
  }[];
}

/**
 * What was spent, what payouts have taken and what is still waiting — for a
 * set of costs (the Partners page passes a period's). Each partner's share is
 * his fixed share of those costs; a partner who has left is listed while he
 * owes any of them.
 */
export function summariseRunningCosts(input: {
  costs: RunningCost[];
  partners: RunningCostPartner[];
  charges: StandingCharge[];
  /** Everyone who may hold a share: the active partners and those who left. */
  people?: RunningCostPartner[];
}): RunningCostsSummary {
  const ids = new Set(input.costs.map((c) => c.id));
  const charges = input.charges.filter((c) => ids.has(c.costEntryId));
  const categories = new Map<string, Prisma.Decimal>();
  for (const c of input.costs) {
    categories.set(
      c.category,
      (categories.get(c.category) ?? ZERO).add(c.amount),
    );
  }
  const spent = input.costs.reduce((s, c) => s.add(c.amount), ZERO);
  const charged = charges.reduce((s, c) => s.add(c.amount), ZERO);

  const active = new Set(input.partners.map((p) => p.userId));
  const holders = new Set(
    input.costs.flatMap((c) =>
      [...c.shares.entries()].filter(([, v]) => v.gt(0)).map(([k]) => k),
    ),
  );
  const people = [
    ...input.partners,
    ...(input.people ?? []).filter(
      (p) => !active.has(p.userId) && holders.has(p.userId),
    ),
  ];
  const last = input.partners[input.partners.length - 1]?.userId;

  return {
    byCategory: [...categories.entries()]
      .map(([category, spentEgp]) => ({ category, spentEgp }))
      .sort(
        (a, b) =>
          b.spentEgp.cmp(a.spentEgp) || a.category.localeCompare(b.category),
      ),
    spentEgp: spent,
    chargedEgp: charged,
    waitingEgp: spent.sub(charged),
    partners: people.map((p) => {
      const share = input.costs.reduce(
        (s, c) => s.add(c.shares.get(p.userId) ?? ZERO),
        ZERO,
      );
      const his = charges
        .filter((c) => c.partnerUserId === p.userId)
        .reduce((s, c) => s.add(c.amount), ZERO);
      const waiting = share.sub(his);
      return {
        userId: p.userId,
        name: p.name,
        shareEgp: share,
        chargedEgp: his,
        waitingEgp: waiting.gt(0) ? waiting : ZERO,
        takesResidual: p.userId === last,
        active: active.has(p.userId),
      };
    }),
  };
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

/**
 * `loadRunningCosts`, storing the shares of any cost that had none — so they
 * are fixed from now on, whoever joins or leaves. Called where writing is
 * already happening: recording a cost, and Mark paid (inside its transaction,
 * with `tx`).
 */
export async function fixRunningCostShares(
  db: Db & {
    runningCostShare: Pick<
      Prisma.TransactionClient['runningCostShare'],
      'findMany' | 'createMany'
    >;
  },
): Promise<RunningCostsState> {
  const state = await loadRunningCosts(db);
  if (state.unfixed.length > 0) {
    await db.runningCostShare.createMany({
      data: state.unfixed.map((s) => ({ ...s, amount: s.amount })),
      skipDuplicates: true,
    });
  }
  return { ...state, unfixed: [] };
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

/** The calendar quarter a day falls in: 2026-10-12 → 2026-10-01 … 2026-12-31. */
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
