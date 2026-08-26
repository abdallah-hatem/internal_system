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
 * Money recovered from a supplier.
 *
 * It does not re-price batches already costed — units sold keep the cost they
 * were sold at — so it lands as a reduction of expenses, which is to say a
 * gain. An allowlist rather than "every inflow", so a new inflow category
 * cannot silently start reducing costs.
 */
export const COST_RECOVERY_CATEGORIES = ['supplier_refund'] as const;
