// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money in EGP must not become a float
import { Prisma } from '@prisma/client';

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
 */
export const CAPITALISED_CATEGORIES = [
  'purchase',
  'shipping',
  'settlement',
  'contribution',
] as const;

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
 * Categories that are not operating expenses: capitalised, and recoveries
 * (whose reversals are netted against them through `recoveredEgp`).
 */
export const NOT_OPERATING_EXPENSE = [
  ...CAPITALISED_CATEGORIES,
  ...COST_RECOVERY_CATEGORIES,
] as const;
