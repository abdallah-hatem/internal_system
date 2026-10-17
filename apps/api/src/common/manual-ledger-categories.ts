/**
 * What a partner may record by hand in the ledger (BUSINESS_LOGIC §9, L6).
 *
 * The "New Entry" form used to take a free-text category, a type picker that
 * offered system types like Purchase, and an Inflow/Outflow radio, and the API
 * saved whatever it was sent. Typing `purchase`, `contribution` or
 * `settlement` with either direction silently moved cash, profit or a
 * settlement — every one of those categories means something to the
 * settlement and the dashboard, and none of them is a hand-written entry.
 *
 * A manual entry is now one of two kinds, and the kind decides the direction:
 *
 * - **An expense** — money we spent that no flow records: rent, salaries…
 *   It counts in operating expenses through `NOT_OPERATING_EXPENSE` not
 *   listing it, and against a cycle's profit when charged to one.
 * - **Other income** — money in that is not a sale, a customer payment, a
 *   contribution or a refund. It raises net profit but is not Revenue.
 *
 * This is the ONE list. The API validates against it and the web form offers
 * it — `apps/web/src/lib/ledger-categories.ts` is a copy only because Next
 * cannot import across apps, and its test fails the moment the two differ.
 *
 * Kept free of Prisma so that test can import it; `ledger-categories.ts`
 * re-exports it next to the other category rules.
 */

/** Expenses a partner records by hand. Each needs a label in both locales. */
export const MANUAL_EXPENSE_CATEGORIES = [
  'rent',
  'salaries',
  'utilities',
  'transport_delivery',
  'fuel',
  'packaging',
  'marketing',
  'bank_fees',
  'customs_clearance',
  'extra_freight',
  'other_expense',
] as const;

/**
 * Money in that is none of the things a flow records. `income_other` is the
 * owner's "Other" on the income side; it has its own key so a category alone
 * says which kind a row is.
 */
export const OTHER_INCOME_CATEGORIES = [
  'other_income',
  'interest',
  'income_other',
] as const;

export type ManualExpenseCategory = (typeof MANUAL_EXPENSE_CATEGORIES)[number];
export type OtherIncomeCategory = (typeof OTHER_INCOME_CATEGORIES)[number];
export type ManualCategory = ManualExpenseCategory | OtherIncomeCategory;

/** The two kinds of manual entry, and what each one fixes. */
export const MANUAL_ENTRY_KINDS = {
  EXPENSE: {
    /** Stored as the row's `type`. */
    type: 'EXPENSE',
    direction: 'OUTFLOW',
    categories: MANUAL_EXPENSE_CATEGORIES as readonly string[],
  },
  OTHER_INCOME: {
    type: 'OTHER_INCOME',
    direction: 'INFLOW',
    categories: OTHER_INCOME_CATEGORIES as readonly string[],
  },
} as const;

export type ManualEntryKind = keyof typeof MANUAL_ENTRY_KINDS;
export const MANUAL_ENTRY_KIND_CODES = Object.keys(
  MANUAL_ENTRY_KINDS,
) as ManualEntryKind[];

/**
 * Categories that only make sense against a cycle. A late freight charge is a
 * cost of that cycle's goods (§2: once a leg's cost is fixed, a late or
 * corrected charge is a cycle expense recorded in the ledger), so it cannot be
 * recorded without saying which cycle.
 */
export const CYCLE_REQUIRED_CATEGORIES: readonly string[] = ['extra_freight'];

/** A cycle nothing more can be charged to. */
export const CLOSED_CYCLE_STATUSES: readonly string[] = ['CLOSED', 'CANCELLED'];

/** Which kind a category belongs to; null for anything not manual. */
export function manualKindOf(category: string): ManualEntryKind | null {
  for (const kind of MANUAL_ENTRY_KIND_CODES) {
    if (MANUAL_ENTRY_KINDS[kind].categories.includes(category)) return kind;
  }
  return null;
}

export function isOtherIncomeCategory(category: string): boolean {
  return (OTHER_INCOME_CATEGORIES as readonly string[]).includes(category);
}
