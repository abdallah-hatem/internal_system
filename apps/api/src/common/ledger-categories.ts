// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money in EGP must not become a float
import { Prisma } from '@prisma/client';
import {
  OTHER_INCOME_CATEGORIES,
  isOtherIncomeCategory,
} from './manual-ledger-categories';

// The manual-entry list lives in its own Prisma-free file so the web's copy
// can be tested against it; it is part of this one set of rules (L6).
export * from './manual-ledger-categories';

/**
 * Ledger categories that are not operating expenses.
 *
 * This list existed twice — once in the settlements service and once in
 * analytics — and the two drifted the moment a category was added. Recording
 * partner contributions introduced `contribution`, it went into the settlement
 * copy and not the analytics one, and handing capital back was charged to the
 * dashboard's net profit as if it were an expense. Same rule, two answers.
 *
 * One definition now, imported by both. A new category is a single edit or it
 * is a bug in whichever copy was forgotten.
 *
 * Why each is here:
 *
 * - `purchase` and `shipping` are already capitalised into batch landed cost,
 *   so counting them again charges the cycle twice.
 * - `settlement` is the distribution of profit already earned. Treating a
 *   payout as an expense re-charges the cycle for its own profit: a settled
 *   cycle recalculated afterwards turned an 11,620 profit into a 100,871 loss.
 * - `contribution` is capital moving between the partners and the business, in
 *   either direction. Money coming in is not income and money handed back is
 *   not a cost — the partners would otherwise pay for their own capital being
 *   returned.
 * - `lender_financing` and `lender_repayment` (§18) are a friend's loan: his
 *   money paying our supplier comes in, our pounds paying him back go out.
 *   Borrowing is not income and repaying is not an expense. What the loan
 *   really cost — the rate moving between the order and each repayment — is
 *   the exchange difference, which is not a ledger row and is read from the
 *   repayments (`common/lender-debt.ts`) by settlement, cycle profit and the
 *   dashboard alike.
 */
export const CAPITALISED_CATEGORIES = [
  'purchase',
  'shipping',
  'settlement',
  'contribution',
  'lender_financing',
  'lender_repayment',
] as const;

/** A friend's loan, in and out (§18). Also inside CAPITALISED_CATEGORIES. */
export const LENDER_CATEGORIES = [
  'lender_financing',
  'lender_repayment',
] as const;

/** Is this row a friend's loan moving — not a cost of the cycle's goods? */
export function isLenderCategory(category: string): boolean {
  return (LENDER_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Money recovered: from a supplier against an order (`supplier_refund`), or
 * from the shipping company or supplier for goods lost on the way
 * (`loss_refund`, §6 2026-10-10).
 *
 * It does not re-price batches already costed — units sold keep the cost they
 * were sold at — so it lands as a reduction of expenses, which is to say a
 * gain. An allowlist rather than "every inflow", so a new inflow category
 * cannot silently start reducing costs.
 *
 * Read by settlement, by analytics' cycle profitability and by the
 * dashboard's net profit. The cycle profitability used to test for
 * `'supplier_refund'` by name, and the dashboard did not count recoveries at
 * all — the same drift as `CAPITALISED_CATEGORIES` had (rule 11).
 */
export const COST_RECOVERY_CATEGORIES = [
  'supplier_refund',
  'loss_refund',
] as const;

/** Is this a recovery category — money recovered, or handed back again? */
export function isCostRecoveryCategory(category: string): boolean {
  return (COST_RECOVERY_CATEGORIES as readonly string[]).includes(category);
}

/**
 * What a ledger row adds to money recovered, signed: a refund's INFLOW adds,
 * its reversal's OUTFLOW (B5b: the refund undone, the money handed back)
 * takes the same away; any other row is zero.
 *
 * Recovery is always read through this, never as "the inflows": counting
 * only the inflows kept an undone refund in the cycle profitability, while
 * settlement — which happened to see the reversal as an expense — dropped
 * it. Same rule, two answers (rule 11). A recovery category is never an
 * operating expense either: the settlement and the dashboard exclude it from
 * expenses and net it here instead.
 */
export function recoveredEgp(t: {
  direction: string;
  category: string;
  amount: Prisma.Decimal.Value;
}): Prisma.Decimal {
  if (!isCostRecoveryCategory(t.category)) return new Prisma.Decimal(0);
  const amount = new Prisma.Decimal(t.amount);
  return t.direction === 'INFLOW' ? amount : amount.neg();
}

/** Every recovery on these rows, net of reversals. */
export function netRecoveredEgp(
  rows: { direction: string; category: string; amount: Prisma.Decimal.Value }[],
): Prisma.Decimal {
  return rows.reduce((s, t) => s.add(recoveredEgp(t)), new Prisma.Decimal(0));
}

/**
 * Categories that are not operating expenses: capitalised, recoveries (whose
 * reversals are netted against them through `recoveredEgp`), and other income
 * (netted through `otherIncomeEgp` — undoing income is not an expense).
 */
export const NOT_OPERATING_EXPENSE = [
  ...CAPITALISED_CATEGORIES,
  ...COST_RECOVERY_CATEGORIES,
  ...OTHER_INCOME_CATEGORIES,
] as const;

type LedgerRow = {
  direction: string;
  category: string;
  amount: Prisma.Decimal.Value;
  reversalOfId?: string | null;
};

/**
 * What a ledger row adds to operating expenses, signed (§9, L6).
 *
 * Money out in any category that is not capitalised, recovered or income adds
 * — a manual expense from the list, or an old free-text one as it always did.
 * A reversal of one (money back in, pointing at it) takes the same away: until
 * L6 a reversed expense stayed counted, because every reader summed only the
 * outflows. Money in that is not a reversal is never a negative expense.
 *
 * Settlement, the cycle profitability and the dashboard all read expenses
 * through this — the cycle profitability did not count them at all, so a
 * cycle's page and its settlement showed two profits (rule 11).
 */
export function operatingExpenseEgp(t: LedgerRow): Prisma.Decimal {
  if ((NOT_OPERATING_EXPENSE as readonly string[]).includes(t.category)) {
    return new Prisma.Decimal(0);
  }
  const amount = new Prisma.Decimal(t.amount);
  if (t.direction === 'OUTFLOW') return amount;
  return t.reversalOfId ? amount.neg() : new Prisma.Decimal(0);
}

export function netOperatingExpenseEgp(rows: LedgerRow[]): Prisma.Decimal {
  return rows.reduce(
    (s, t) => s.add(operatingExpenseEgp(t)),
    new Prisma.Decimal(0),
  );
}

/**
 * What a ledger row adds to other income, signed (§9, L6): money in under an
 * other-income category adds, its reversal (money out) takes it away. It
 * raises net profit and is not Revenue — shown on its own, like recoveries.
 */
export function otherIncomeEgp(t: LedgerRow): Prisma.Decimal {
  if (!isOtherIncomeCategory(t.category)) return new Prisma.Decimal(0);
  const amount = new Prisma.Decimal(t.amount);
  return t.direction === 'INFLOW' ? amount : amount.neg();
}

export function netOtherIncomeEgp(rows: LedgerRow[]): Prisma.Decimal {
  return rows.reduce((s, t) => s.add(otherIncomeEgp(t)), new Prisma.Decimal(0));
}
