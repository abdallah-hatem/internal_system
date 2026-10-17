/**
 * COPY of `apps/api/src/common/manual-ledger-categories.ts` — what a partner
 * may record by hand in the ledger (BUSINESS_LOGIC §9, L6). The server refuses
 * from its own copy; this one decides what the New Entry form and the ledger's
 * category filter offer, so they never offer a category the server refuses.
 * Next cannot import across apps, so `ledger-categories.test.ts` compares the
 * two and fails the moment they disagree. Change the API's file first, then
 * this.
 */
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

export const OTHER_INCOME_CATEGORIES = [
  'other_income',
  'interest',
  'income_other',
] as const;

export const MANUAL_ENTRY_KINDS = {
  EXPENSE: {
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

export const CYCLE_REQUIRED_CATEGORIES: readonly string[] = ['extra_freight'];

export const CLOSED_CYCLE_STATUSES: readonly string[] = ['CLOSED', 'CANCELLED'];

/** Every manual category, expenses first — the ledger filter's list. */
export const MANUAL_CATEGORIES: readonly string[] = [
  ...MANUAL_EXPENSE_CATEGORIES,
  ...OTHER_INCOME_CATEGORIES,
];

/** Which kind a category belongs to; null for anything not manual. */
export function manualKindOf(category: string | null | undefined): ManualEntryKind | null {
  if (!category) return null;
  if (MANUAL_ENTRY_KINDS.EXPENSE.categories.includes(category)) return 'EXPENSE';
  if (MANUAL_ENTRY_KINDS.OTHER_INCOME.categories.includes(category)) return 'OTHER_INCOME';
  return null;
}
