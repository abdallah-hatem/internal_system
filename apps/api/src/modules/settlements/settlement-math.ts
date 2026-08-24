
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
    throw badRequest('CYCLE_NO_PARTICIPANTS', 'Cycle has no participants to settle');
  }

  const shares = resolveShares(participants);

  // --- Gross profit per participant, residual to the last line -------------
  let allocated = ZERO;
  const gross = participants.map((p, idx) => {
    if (idx === participants.length - 1) {
      return totalProfit.sub(allocated);
    }
    const amount = money(totalProfit.mul(shares[idx]));
    allocated = allocated.add(amount);
    return amount;
  });

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

/** Fractional share (0-1) per participant, from an agreed split or capital. */
function resolveShares(participants: ParticipantInput[]): Prisma.Decimal[] {
  const withCustom = participants.filter((p) => p.customProfitPct !== null);

  if (withCustom.length > 0) {
    if (withCustom.length !== participants.length) {
      throw badRequest(
        'PARTIAL_CUSTOM_SPLIT',
        'A custom profit split must be set for every participant in the cycle, or for none of them',
      );
    }
    const total = withCustom.reduce(
      (s, p) => s.add(p.customProfitPct!),
      ZERO,
    );
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

  if (totalContribution.lte(0)) {
    // Nothing was contributed, so there is no basis to split on.
    return participants.map(() => ZERO);
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
