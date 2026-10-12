// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money in EGP must not become a float
import { Prisma } from '@prisma/client';
import {
  operatingExpenseEgp,
  otherIncomeEgp,
  recoveredEgp,
} from './ledger-categories';

/**
 * A payout explains itself (§8, owner 2026-10-11; built L7).
 *
 * The settlement screen showed one "Expenses" figure, and a partner reading
 * his payout could not see what went into it. Here the same figures the
 * settlement subtracts are kept line by line, and each participant's payout is
 * laid out from the settlement's own lines: nothing is recomputed beside it, so
 * the explanation cannot disagree with what was paid (rule 11).
 */

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);
const ZERO = D(0);
const fixed = (v: Prisma.Decimal) => v.toFixed(2);

/**
 * One line of a cycle's costs, as it takes from the cycle's profit: a cost is
 * positive, a gain (a refund, other income, the dirham falling) negative.
 *
 * - `charge`: a ledger entry charged to the cycle, by category (extra freight,
 *   customs, any other cycle-charged category), net of reversals.
 * - `loss`: goods lost on the way (§2).
 * - `exchange`: repaying friends at a moved rate (§18).
 * - `recovery`: money a supplier or shipper gave back (§6).
 * - `otherIncome`: other income credited to the cycle (§9).
 */
export interface CycleCostLine {
  kind: 'charge' | 'loss' | 'exchange' | 'recovery' | 'otherIncome';
  category: string | null;
  amountEgp: string;
}

type Row = {
  direction: string;
  category: string;
  amount: Prisma.Decimal.Value;
  reversalOfId?: string | null;
};

function byCategory(
  rows: Row[],
  kind: CycleCostLine['kind'],
  signed: (r: Row) => Prisma.Decimal,
): CycleCostLine[] {
  const totals = new Map<string, Prisma.Decimal>();
  for (const r of rows) {
    totals.set(r.category, (totals.get(r.category) ?? ZERO).add(signed(r)));
  }
  return [...totals.entries()]
    .filter(([, v]) => !v.isZero())
    .map(([category, v]) => ({ kind, category, amountEgp: fixed(v) }));
}

/**
 * The settlement's expenses, line by line, from the very rows and figures the
 * projection subtracts — through the same signed readings (rule 11). The
 * lines add up to the expenses exactly (`sumCostLines`).
 */
export function cycleCostLines(input: {
  expenseRows: Row[];
  recoveryRows: Row[];
  otherIncomeRows: Row[];
  lossesEgp: Prisma.Decimal;
  exchangeDifferenceEgp: Prisma.Decimal;
}): CycleCostLine[] {
  const lines: CycleCostLine[] = [
    ...byCategory(input.expenseRows, 'charge', operatingExpenseEgp),
  ];
  if (!input.lossesEgp.isZero()) {
    lines.push({
      kind: 'loss',
      category: null,
      amountEgp: fixed(input.lossesEgp),
    });
  }
  if (!input.exchangeDifferenceEgp.isZero()) {
    lines.push({
      kind: 'exchange',
      category: null,
      amountEgp: fixed(input.exchangeDifferenceEgp),
    });
  }
  lines.push(
    ...byCategory(input.recoveryRows, 'recovery', (r) => recoveredEgp(r).neg()),
    ...byCategory(input.otherIncomeRows, 'otherIncome', (r) =>
      otherIncomeEgp(r).neg(),
    ),
  );
  return lines;
}

export function sumCostLines(lines: CycleCostLine[]): Prisma.Decimal {
  return lines.reduce((s, l) => s.add(l.amountEgp), ZERO);
}

/** What the settlement stores beside its figures (`Settlement.costBreakdown`). */
export interface StoredCostBreakdown {
  costs: CycleCostLine[];
}

export function isStoredCostBreakdown(v: unknown): v is StoredCostBreakdown {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { costs?: unknown }).costs)
  );
}

export interface ParticipantPayout {
  participantId: string;
  type: string;
  /** His share of the cycle's profit, in percent; null when there is no profit to share. */
  sharePct: string | null;
  /** His share of the cycle's profit, before any fee. */
  profitShareEgp: string;
  /** The fee taken from an investor's share (negative), zero otherwise. */
  investorFeeEgp: string;
  /** Investors' fees passed to this core partner. */
  feeReceivedEgp: string;
  capitalBackEgp: string;
  /** His share of the running costs taken from this payout (negative). */
  runningCostsEgp: string;
  runningCostsFrom: string | null;
  runningCostsTo: string | null;
  /**
   * `charged` (paid out and taken), `projected` (what paying now would take),
   * `released` (taken, then put back when the settlement was reversed), or
   * `none`.
   */
  runningCostsStatus: 'charged' | 'projected' | 'released' | 'none';
  /** What he is (or was, or would be) paid: the sum of the lines above. */
  paidEgp: string;
}

export interface PayoutBreakdown {
  revenueEgp: string;
  cogsEgp: string;
  /** Null for a settlement calculated before costs were kept line by line. */
  costs: CycleCostLine[] | null;
  expensesEgp: string;
  cycleProfitEgp: string;
  /** Leftovers moved to another cycle at cost (§8, L5): shown, not a cost. */
  leftoversMovedEgp: string;
  participants: ParticipantPayout[];
}

type SettlementLineIn = {
  participantId: string;
  component: string;
  amount: Prisma.Decimal.Value;
  participant: { participantType: string };
};

/**
 * Lay a settlement out line by line.
 *
 * `runningCosts`: per participant, what this settlement's running-cost charges
 * come to and the days they cover — the charges it took (paid), or what paying
 * now would take (draft, approved).
 */
export function buildPayoutBreakdown(input: {
  settlement: {
    status: string;
    revenueEgp: Prisma.Decimal.Value | null;
    cogsEgp: Prisma.Decimal.Value | null;
    expensesEgp: Prisma.Decimal.Value | null;
    grossProfitEgp: Prisma.Decimal.Value | null;
    costBreakdown: unknown;
  };
  lines: SettlementLineIn[];
  runningCosts: Map<
    string,
    { amountEgp: Prisma.Decimal; from: string | null; to: string | null }
  >;
  leftoversMovedEgp: Prisma.Decimal;
}): PayoutBreakdown {
  const s = input.settlement;
  const profit = D(s.grossProfitEgp);
  const open = s.status === 'DRAFT' || s.status === 'APPROVED';

  const byParticipant = new Map<string, SettlementLineIn[]>();
  for (const l of input.lines) {
    byParticipant.set(l.participantId, [
      ...(byParticipant.get(l.participantId) ?? []),
      l,
    ]);
  }

  const participants = [...byParticipant.entries()].map(
    ([participantId, group]): ParticipantPayout => {
      const pick = (c: string) =>
        group
          .filter((l) => l.component === c)
          .reduce((sum, l) => sum.add(D(l.amount)), ZERO);
      const net = pick('PROFIT_SHARE');
      // The INVESTOR_FEE line is the fee, negative, already inside PROFIT_SHARE.
      const fee = pick('INVESTOR_FEE');
      const gross = net.sub(fee);
      const received = pick('INVESTOR_FEE_RECEIVED');
      const capital = pick('CAPITAL_RETURN');
      const stored = pick('RUNNING_COSTS');
      const rc = input.runningCosts.get(participantId);

      let running = stored;
      let status: ParticipantPayout['runningCostsStatus'] = 'none';
      if (open) {
        running = rc ? rc.amountEgp.neg() : ZERO;
        if (!running.isZero()) status = 'projected';
      } else if (!stored.isZero()) {
        status = s.status === 'REVERSED' ? 'released' : 'charged';
      }

      return {
        participantId,
        type: group[0].participant.participantType,
        sharePct: profit.isZero()
          ? null
          : gross.div(profit).mul(100).toFixed(2),
        profitShareEgp: fixed(gross),
        investorFeeEgp: fixed(fee),
        feeReceivedEgp: fixed(received),
        capitalBackEgp: fixed(capital),
        runningCostsEgp: fixed(running),
        runningCostsFrom: status === 'none' ? null : (rc?.from ?? null),
        runningCostsTo: status === 'none' ? null : (rc?.to ?? null),
        runningCostsStatus: status,
        paidEgp: fixed(gross.add(fee).add(received).add(capital).add(running)),
      };
    },
  );

  return {
    revenueEgp: fixed(D(s.revenueEgp)),
    cogsEgp: fixed(D(s.cogsEgp)),
    costs: isStoredCostBreakdown(s.costBreakdown)
      ? s.costBreakdown.costs
      : null,
    expensesEgp: fixed(D(s.expensesEgp)),
    cycleProfitEgp: fixed(profit),
    leftoversMovedEgp: fixed(input.leftoversMovedEgp),
    participants,
  };
}
