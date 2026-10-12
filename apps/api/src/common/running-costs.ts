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
 * salaries, power. It is the active core partners', equally; a temporary
 * investor never shares it. It does not touch any cycle's profit. When a
 * settlement is paid out, each core partner on it has his share of the costs
 * still waiting taken from his payout, oldest first, as far as the payout
 * covers; the rest waits for his next payout, from whichever cycle.
 *
 * Everything here is arithmetic over rows already read, so the settlement
 * screen's "if paid now", Mark paid itself and the Partners page cannot
 * disagree (rule 11). The reading of the rows is `loadRunningCosts`.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);

/** A core partner who shares the running costs. Order matters: see below. */
export interface RunningCostPartner {
  userId: string;
  name: string | null;
}

/** One running cost, net of any reversal of it. */
export interface RunningCost {
  id: string;
  /** The Cairo day it was spent. */
  day: string;
  category: string;
  amount: Prisma.Decimal;
}

/** Part of a cost already taken from a payout that stands. */
export interface StandingCharge {
  costEntryId: string;
  partnerUserId: string;
  amount: Prisma.Decimal;
}

export type PlannedCharge = StandingCharge;

/**
 * Split an amount equally among partners, in piastres.
 *
 * Each share is rounded DOWN to the piastre and the residual goes to the LAST
 * partner in the list — the core partner who joined last (`loadRunningCosts`
 * orders them oldest first). Stated, and deterministic: never rounding
 * deciding who pays (working rules §10). Rounding down means the residual
 * partner never pays less than the others: 100 is 33.33 / 33.33 / 33.34.
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

/** Oldest first: by the day spent, then by id, so the order never wobbles. */
function oldestFirst(costs: RunningCost[]): RunningCost[] {
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
 * (`capacities`: user id → what the settlement pays him), his share of every
 * waiting cost, oldest first, until his payout is used up.
 *
 * - A partner not in `partners` (a temporary investor; a core partner no longer
 *   active) is never charged.
 * - A payout of nothing or less (a loss) takes nothing.
 * - Never more than the cost has left to charge, so across every payout a
 *   cost's charges add up to it exactly — charged once in total.
 */
export function planRunningCostCharges(input: {
  costs: RunningCost[];
  partners: RunningCostPartner[];
  charges: StandingCharge[];
  capacities: Map<string, Prisma.Decimal>;
}): PlannedCharge[] {
  const sharing = new Set(input.partners.map((p) => p.userId));
  const costs = oldestFirst(input.costs).filter((c) => c.amount.gt(0));
  const planned: PlannedCharge[] = [];

  for (const partner of input.partners) {
    const capacity = input.capacities.get(partner.userId);
    if (!capacity || !sharing.has(partner.userId)) continue;
    let left = capacity;
    for (const cost of costs) {
      if (left.lte(0)) break;
      const charged = chargedBy([...input.charges, ...planned]);
      const share =
        splitEqually(cost.amount, input.partners).get(partner.userId) ?? ZERO;
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

/**
 * The running costs in a set of ledger rows, each net of its reversals: a
 * reversed cost is still listed, at zero, and owes nothing. Oldest first.
 */
export function runningCostsFromRows(
  rows: (LedgerRowForRunningCosts & {
    occurredOn: Date | null;
    createdAt: Date;
  })[],
): RunningCost[] {
  const costs = rows.filter(isRunningCostEntry);
  return oldestFirst(
    costs.map((c) => {
      const net = rows
        .filter((r) => r.id === c.id || r.reversalOfId === c.id)
        .reduce((s, r) => s.add(operatingExpenseEgp(r)), ZERO);
      return {
        id: c.id,
        day: c.occurredOn
          ? c.occurredOn.toISOString().slice(0, 10)
          : businessDay(c.createdAt),
        category: c.category,
        amount: net.gt(0) ? net : ZERO,
      };
    }),
  );
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
    /** Takes the odd piastre when a cost does not split evenly (§10). */
    takesResidual: boolean;
  }[];
}

/**
 * What was spent, what payouts have taken and what is still waiting — for a
 * set of costs (the Partners page passes a period's).
 */
export function summariseRunningCosts(input: {
  costs: RunningCost[];
  partners: RunningCostPartner[];
  charges: StandingCharge[];
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
    partners: input.partners.map((p, i) => {
      const share = input.costs.reduce(
        (s, c) =>
          s.add(splitEqually(c.amount, input.partners).get(p.userId) ?? ZERO),
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
        takesResidual: i === input.partners.length - 1,
      };
    }),
  };
}

type Db = {
  partner: Pick<Prisma.TransactionClient['partner'], 'findMany'>;
  financialTransaction: Pick<
    Prisma.TransactionClient['financialTransaction'],
    'findMany'
  >;
  runningCostCharge: Pick<
    Prisma.TransactionClient['runningCostCharge'],
    'findMany'
  >;
};

/**
 * Read what the arithmetic needs: the active core partners (oldest first, so
 * the one who joined last takes the residual), every running cost net of its
 * reversals, and every charge that stands (a released one — its settlement
 * reversed — does not).
 */
export async function loadRunningCosts(db: Db): Promise<{
  partners: RunningCostPartner[];
  costs: RunningCost[];
  charges: StandingCharge[];
}> {
  const partnerRows = await db.partner.findMany({
    where: { active: true, user: { role: 'CORE_PARTNER', status: 'ACTIVE' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { userId: true, displayName: true },
  });

  const costRows = await db.financialTransaction.findMany({
    where: {
      cycleId: null,
      reversalOfId: null,
      direction: 'OUTFLOW',
      category: { notIn: [...NOT_OPERATING_EXPENSE] },
    },
    select: ROW_SELECT,
  });
  const reversalRows = costRows.length
    ? await db.financialTransaction.findMany({
        where: { reversalOfId: { in: costRows.map((r) => r.id) } },
        select: ROW_SELECT,
      })
    : [];

  const chargeRows = await db.runningCostCharge.findMany({
    where: { releasedAt: null },
    select: { costEntryId: true, partnerUserId: true, amount: true },
  });

  return {
    partners: partnerRows.map((p) => ({
      userId: p.userId,
      name: p.displayName,
    })),
    costs: runningCostsFromRows([...costRows, ...reversalRows]),
    charges: chargeRows.map((c) => ({ ...c, amount: D(c.amount) })),
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
