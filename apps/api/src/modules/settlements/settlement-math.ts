import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { badRequest } from '../../common/api-error';
const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);

/** Money is carried at 2dp; shares at 4dp. */
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export type ParticipantType = 'CORE_PARTNER' | 'TEMP_INVESTOR';

export interface ParticipantInput {
  id: string;
  type: ParticipantType;
  contribution: Prisma.Decimal;
  /** Agreed profit percentage (0-100) overriding the contribution split. */
  customProfitPct: Prisma.Decimal | null;
  /** Percentage of this investor's own profit taken as a fee (0-100). */
  investorFeePct: Prisma.Decimal | null;
}

export interface SettlementLineResult {
  participantId: string;
  type: ParticipantType;
  /** Percentage of cycle profit allocated to this participant. */
  sharePct: Prisma.Decimal;
  grossProfit: Prisma.Decimal;
  /** Fee taken off this participant's profit (temporary investors only). */
  investorFee: Prisma.Decimal;
  netProfit: Prisma.Decimal;
  capitalReturn: Prisma.Decimal;
  /** Share of investor fees passed to this core partner. */
  feeReceived: Prisma.Decimal;
  payout: Prisma.Decimal;
}

export interface DistributionResult {
  lines: SettlementLineResult[];
  totals: {
    capitalReturned: Prisma.Decimal;
    grossProfit: Prisma.Decimal;
    feesRedistributed: Prisma.Decimal;
    netProfit: Prisma.Decimal;
    payout: Prisma.Decimal;
  };
}

/**
 * Split a cycle's profit across its participants.
 *
 * Profit follows actual contribution unless the partners agreed an explicit
 * split for the cycle. A temporary investor's fee is a percentage of that
 * investor's own allocated profit -- never of their capital -- and it moves to
 * the core partners. Capital return stays a separate component so a settlement
 * shows what is a refund and what is earnings.
 *
 * Rounding: shares are computed at full precision and each line is rounded to
 * 2dp, with the last line absorbing the residual so the parts always re-sum to
 * the total being distributed.
 */
export function distributeCycleProfit(
  participants: ParticipantInput[],
  totalProfit: Prisma.Decimal,
): DistributionResult {
  if (participants.length === 0) {
    throw badRequest(
      'CYCLE_NO_PARTICIPANTS',
      'Cycle has no participants to settle',
    );
  }

  const shares = resolveShares(participants);

  // --- Gross profit per participant, residual to the last line -------------
  // The last line with a share, so the piastres rounding leaves over never
  // land on someone the split gives nothing — a participant who put in
  // nothing takes nothing.
  let residualIdx = participants.length - 1;
  while (residualIdx > 0 && shares[residualIdx].lte(0)) residualIdx--;
  const amounts = participants.map((p, idx) =>
    idx === residualIdx ? ZERO : money(totalProfit.mul(shares[idx])),
  );
  const allocated = amounts.reduce((s, a) => s.add(a), ZERO);
  const gross = amounts.map((amount, idx) =>
    idx === residualIdx ? totalProfit.sub(allocated) : amount,
  );

  // --- Investor fees: a share of the investor's profit, only on a gain -----
  const fees = participants.map((p, idx) => {
    if (p.type !== 'TEMP_INVESTOR' || !p.investorFeePct) return ZERO;
    if (gross[idx].lte(0)) return ZERO; // no fee is charged against a loss
    return money(gross[idx].mul(p.investorFeePct).div(HUNDRED));
  });

  const feePool = fees.reduce((s, f) => s.add(f), ZERO);

  // --- Fees go to the core partners, split equally -------------------------
  // BRD 19 records equal split as the working assumption; the per-line amounts
  // are stored so a different split can be recorded without changing this code.
  const coreIdx = participants
    .map((p, i) => (p.type === 'CORE_PARTNER' ? i : -1))
    .filter((i) => i >= 0);

  const feeReceived = participants.map(() => ZERO);
  if (feePool.gt(0) && coreIdx.length > 0) {
    let handed = ZERO;
    coreIdx.forEach((pi, n) => {
      const amount =
        n === coreIdx.length - 1
          ? feePool.sub(handed)
          : money(feePool.div(coreIdx.length));
      feeReceived[pi] = amount;
      handed = handed.add(amount);
    });
  }

  const lines: SettlementLineResult[] = participants.map((p, idx) => {
    const netProfit = gross[idx].sub(fees[idx]);
    const capitalReturn = money(p.contribution);
    return {
      participantId: p.id,
      type: p.type,
      sharePct: shares[idx].mul(HUNDRED).toDecimalPlaces(4),
      grossProfit: gross[idx],
      investorFee: fees[idx],
      netProfit,
      capitalReturn,
      feeReceived: feeReceived[idx],
      payout: capitalReturn.add(netProfit).add(feeReceived[idx]),
    };
  });

  const sum = (pick: (l: SettlementLineResult) => Prisma.Decimal) =>
    lines.reduce((s, l) => s.add(pick(l)), ZERO);

  return {
    lines,
    totals: {
      capitalReturned: sum((l) => l.capitalReturn),
      grossProfit: sum((l) => l.grossProfit),
      feesRedistributed: feePool,
      netProfit: sum((l) => l.netProfit).add(sum((l) => l.feeReceived)),
      payout: sum((l) => l.payout),
    },
  };
}

/**
 * How `amount` of the cycle's profit lands on each participant: the same
 * split `distributeCycleProfit` makes of the whole profit — by contribution,
 * or the agreed percentages — each line's share before any investor's fee,
 * to the piastre, re-summing to `amount`. The Funding card's exchange line
 * reads each partner's part of the exchange difference here (owner
 * 2026-10-26), because settlement takes it off the profit before splitting
 * it, so this is what it costs each of them.
 *
 * Null when settling would refuse to split at all (`CYCLE_NOT_FUNDED`, a
 * partial or off-100 custom split) — no basis, so no split is shown
 * (CLAUDE.md §10).
 */
export function profitShareOf(
  participants: ParticipantInput[],
  amount: Prisma.Decimal,
): Prisma.Decimal[] | null {
  if (participants.length === 0) return null;
  try {
    return distributeCycleProfit(participants, amount).lines.map(
      (l) => l.grossProfit,
    );
  } catch (e) {
    if (e instanceof BadRequestException) return null;
    throw e;
  }
}

/**
 * What a cycle's profit would be split on (§8), or `NONE` when settlement
 * would refuse it as `CYCLE_NOT_FUNDED`. The one reading for the split itself
 * and for the cycle page's "Funding not entered yet" note (owner 2026-10-18),
 * so the note shows exactly when settling would be refused (CLAUDE.md §11).
 *
 * - `CUSTOM_SPLIT`: an agreed percentage on any participant (a partial one is
 *   refused separately, as `PARTIAL_CUSTOM_SPLIT`).
 * - `CONTRIBUTIONS`: someone put money in — directly, or as their share of
 *   repaying a friend who paid the supplier (§18, owner 2026-10-19).
 *
 * There was a third, `LENDERS` (2026-10-11 to 2026-10-19): no contributions
 * and a friend paid the whole cost, split equally. The owner replaced it on
 * 2026-10-19 — the partners repay the friend, in whatever shares they agree,
 * and those shares are their contributions — so a cycle a friend paid for
 * with nothing recorded from the partners refuses like any other.
 */
export type ProfitBasis = 'CUSTOM_SPLIT' | 'CONTRIBUTIONS' | 'NONE';

export function profitBasisOf(
  participants: Pick<
    ParticipantInput,
    'type' | 'contribution' | 'customProfitPct'
  >[],
): ProfitBasis {
  if (participants.some((p) => p.customProfitPct !== null))
    return 'CUSTOM_SPLIT';
  const total = participants.reduce((s, p) => s.add(p.contribution), ZERO);
  if (total.gt(0)) return 'CONTRIBUTIONS';
  return 'NONE';
}

/**
 * The profit split as the cycle page reads it (the Funding card, owner
 * 2026-10-26): its basis and each participant's percentage, in the
 * participants' order. A display of `resolveShares`' answer, not a second
 * rule: a custom split shows the agreed percentages as stored (with the
 * refusal settling would give, if any); a split by contribution shows each
 * one's share of the contributions to two places by largest remainder
 * (`percentagesOf`), so the line reads 100 and every row is within a
 * hundredth of its true share (33.33 / 33.33 / 33.34). `NONE` has no
 * percentages: nothing says how it splits.
 */
export function profitSplitView(
  participants: Pick<
    ParticipantInput,
    'type' | 'contribution' | 'customProfitPct'
  >[],
): {
  basis: ProfitBasis;
  /** Every contribution the same (an equal split by construction). */
  equal: boolean;
  problem: 'PARTIAL_CUSTOM_SPLIT' | 'SPLIT_NOT_100' | null;
  pcts: (string | null)[];
} {
  const basis = profitBasisOf(participants);
  if (basis === 'CUSTOM_SPLIT') {
    const set = participants.filter((p) => p.customProfitPct !== null);
    const total = set.reduce((s, p) => s.add(p.customProfitPct!), ZERO);
    return {
      basis,
      equal: false,
      problem:
        set.length !== participants.length
          ? 'PARTIAL_CUSTOM_SPLIT'
          : !total.equals(HUNDRED)
            ? 'SPLIT_NOT_100'
            : null,
      pcts: participants.map((p) =>
        p.customProfitPct === null ? null : p.customProfitPct.toFixed(2),
      ),
    };
  }
  if (basis === 'NONE') {
    return {
      basis,
      equal: false,
      problem: null,
      pcts: participants.map(() => null),
    };
  }
  const rounded = percentagesOf(participants.map((p) => p.contribution));
  return {
    basis,
    equal: participants.every((p) =>
      p.contribution.equals(participants[0].contribution),
    ),
    problem: null,
    pcts: rounded.map((v) => v.toFixed(2)),
  };
}

/**
 * Each value's percentage of their total to two places, summing to exactly
 * 100.00, by largest remainder (owner 2026-10-27: "Each partner's share of
 * the cycle? something looks off"). Every row starts at its share rounded
 * down; the hundredths still missing go one each to the rows that lost the
 * most to rounding down, ties to the later row (as `equalShares` gives the
 * last partner the odd piastre: thirds read 33.33 / 33.33 / 33.34). So a row is never more than
 * a hundredth from its true share, and none absorbs everyone else's rounding:
 * truncating and letting the last row take the rest read Mohammed Setta's
 * 9.9419% on CYC-2026-0001 as 9.96. Display only — the money lines are
 * `distributeCycleProfit`'s.
 *
 * Refuses a total of zero or less: no basis, no percentages (CLAUDE.md §10).
 */
export function percentagesOf(
  values: Prisma.Decimal.Value[],
): Prisma.Decimal[] {
  const vs = values.map((v) => new Prisma.Decimal(v));
  const total = vs.reduce((s, v) => s.add(v), ZERO);
  if (total.lte(0) || vs.some((v) => v.lt(0))) {
    throw new Error('Percentages need a positive total and no negative part');
  }
  // In hundredths of a percent: 10,000 make the whole.
  const exact = vs.map((v) => v.div(total).mul(10_000));
  const floors = exact.map((e) => e.floor());
  let missing = 10_000 - floors.reduce((s, f) => s + f.toNumber(), 0);
  const order = exact
    .map((e, i) => ({ i, rest: e.sub(floors[i]) }))
    .sort((a, b) => b.rest.comparedTo(a.rest) || b.i - a.i);
  for (const { i } of order) {
    if (missing <= 0) break;
    floors[i] = floors[i].add(1);
    missing -= 1;
  }
  return floors.map((f) => f.div(100));
}

/** Fractional share (0-1) per participant, from an agreed split or capital. */
function resolveShares(participants: ParticipantInput[]): Prisma.Decimal[] {
  const basis = profitBasisOf(participants);
  const withCustom = participants.filter((p) => p.customProfitPct !== null);

  if (basis === 'CUSTOM_SPLIT') {
    if (withCustom.length !== participants.length) {
      throw badRequest(
        'PARTIAL_CUSTOM_SPLIT',
        'A custom profit split must be set for every participant in the cycle, or for none of them',
      );
    }
    const total = withCustom.reduce((s, p) => s.add(p.customProfitPct!), ZERO);
    if (!total.equals(HUNDRED)) {
      throw badRequest(
        'SPLIT_NOT_100',
        `Custom profit percentages must add up to 100 (currently ${total.toFixed(2)})`,
        { total: total.toFixed(2) },
      );
    }
    return participants.map((p) => p.customProfitPct!.div(HUNDRED));
  }

  const totalContribution = participants.reduce(
    (s, p) => s.add(p.contribution),
    ZERO,
  );

  if (basis === 'NONE') {
    /**
     * Nobody funded the cycle, so there is no basis to split on — and
     * returning all-zero shares was worse than refusing.
     *
     * Every share came out zero, so every line rounded to zero except the
     * last, which takes the residual: the whole profit landed on whichever
     * participant happened to be created last, and the other two got nothing.
     * Silently. On 90,000 of profit across three equal partners the answer was
     * 0 / 0 / 90,000.
     *
     * A cycle reaches settlement with zero contributions by the ordinary
     * route: they are seeded at zero because the capital is not known yet, and
     * whoever set the cycle up never came back to fill them in.
     *
     * A cycle a friend paid for refuses too (owner 2026-10-19): the partners
     * repay him, and who repays what is their contribution — until it is
     * entered, nothing says how they share the profit.
     */
    throw badRequest(
      'CYCLE_NOT_FUNDED',
      'No contributions are recorded for this cycle, so there is no basis to split its profit. Record what each participant put in first.',
    );
  }

  return participants.map((p) => p.contribution.div(totalContribution));
}

export interface AllocationInput {
  /** Units drawn from this cycle's batches. */
  qty: Prisma.Decimal;
  /** Effective selling price per unit, net of line discount. */
  unitPrice: Prisma.Decimal;
  /** Cost of those units, as recorded at the time of sale. */
  cogs: Prisma.Decimal;
}

export interface CyclePnl {
  revenue: Prisma.Decimal;
  cogs: Prisma.Decimal;
  expenses: Prisma.Decimal;
  grossProfit: Prisma.Decimal;
  unsoldValue: Prisma.Decimal;
  unitsSold: Prisma.Decimal;
  unitsRemaining: Prisma.Decimal;
  fullySold: boolean;
}

/**
 * Profit and loss for one import cycle.
 *
 * Revenue and COGS come only from units actually drawn out of this cycle's
 * batches, so a sale that spans several cycles contributes to each of them in
 * the proportion it consumed. Stock still on the shelf is an asset, not a loss:
 * it is reported separately and never reduces profit.
 *
 * `expenses` covers cycle costs that were not capitalised into landed cost --
 * goods and shipping already sit inside COGS via the batch cost, so counting
 * them again here would double-charge the cycle.
 */
export function summarizeCyclePnl(input: {
  allocations: AllocationInput[];
  expenses: Prisma.Decimal;
  unsoldValue: Prisma.Decimal;
  unitsRemaining: Prisma.Decimal;
}): CyclePnl {
  const revenue = money(
    input.allocations.reduce((s, a) => s.add(a.qty.mul(a.unitPrice)), ZERO),
  );
  const cogs = money(input.allocations.reduce((s, a) => s.add(a.cogs), ZERO));
  const unitsSold = input.allocations.reduce((s, a) => s.add(a.qty), ZERO);
  const expenses = money(input.expenses);

  return {
    revenue,
    cogs,
    expenses,
    grossProfit: money(revenue.sub(cogs).sub(expenses)),
    unsoldValue: money(input.unsoldValue),
    unitsSold,
    unitsRemaining: input.unitsRemaining,
    fullySold: input.unitsRemaining.lte(0),
  };
}
