// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import {
  CAPITALISED_CATEGORIES,
  COST_RECOVERY_CATEGORIES,
  NOT_OPERATING_EXPENSE,
  netOperatingExpenseEgp,
  netOtherIncomeEgp,
  MANUAL_EXPENSE_CATEGORIES,
  OTHER_INCOME_CATEGORIES,
} from './ledger-categories';
import * as manual from './manual-ledger-categories';

/**
 * L6 — what a manual entry counts as, defined once (rule 11).
 *
 * Settlement, the cycle profitability and the dashboard each read the
 * ledger's rows through these. Each had its own copy of "what is an expense"
 * and they disagreed: settlement charged a cycle-linked expense to the cycle,
 * the cycle profitability ignored it, so the cycle page and the settlement
 * showed two different profits for the same cycle.
 */

const row = (
  direction: 'INFLOW' | 'OUTFLOW',
  category: string,
  amount: number,
  reversalOfId: string | null = null,
) => ({
  direction,
  category,
  amount: new Prisma.Decimal(amount),
  reversalOfId,
});

describe('the manual category list is one list', () => {
  it('ledger-categories re-exports the very same arrays, not a copy', () => {
    expect(MANUAL_EXPENSE_CATEGORIES).toBe(manual.MANUAL_EXPENSE_CATEGORIES);
    expect(OTHER_INCOME_CATEGORIES).toBe(manual.OTHER_INCOME_CATEGORIES);
    expect(manual.MANUAL_ENTRY_KINDS.EXPENSE.categories).toBe(
      manual.MANUAL_EXPENSE_CATEGORIES,
    );
    expect(manual.MANUAL_ENTRY_KINDS.OTHER_INCOME.categories).toBe(
      manual.OTHER_INCOME_CATEGORIES,
    );
  });

  it('no manual category is one a flow writes', () => {
    const system = [
      ...CAPITALISED_CATEGORIES,
      ...COST_RECOVERY_CATEGORIES,
      'revenue',
      'refund',
    ];
    for (const c of [
      ...MANUAL_EXPENSE_CATEGORIES,
      ...OTHER_INCOME_CATEGORIES,
    ]) {
      expect(system).not.toContain(c);
    }
  });

  it('a category belongs to exactly one kind', () => {
    const all = [...MANUAL_EXPENSE_CATEGORIES, ...OTHER_INCOME_CATEGORIES];
    expect(new Set(all).size).toBe(all.length);
  });

  it('manual expenses are operating expenses; other income is not an expense', () => {
    for (const c of MANUAL_EXPENSE_CATEGORIES) {
      expect(NOT_OPERATING_EXPENSE as readonly string[]).not.toContain(c);
    }
    for (const c of OTHER_INCOME_CATEGORIES) {
      expect(NOT_OPERATING_EXPENSE as readonly string[]).toContain(c);
    }
  });
});

describe('netOperatingExpenseEgp', () => {
  it('an expense counts; a reversed one stops counting', () => {
    expect(
      netOperatingExpenseEgp([row('OUTFLOW', 'rent', 1500)]).toFixed(2),
    ).toBe('1500.00');
    expect(
      netOperatingExpenseEgp([
        row('OUTFLOW', 'rent', 1500),
        row('INFLOW', 'rent', 1500, 'tx-rent'),
      ]).toFixed(2),
    ).toBe('0.00');
  });

  it('an old free-text expense still counts, as it did', () => {
    expect(
      netOperatingExpenseEgp([row('OUTFLOW', 'Office chairs', 800)]).toFixed(2),
    ).toBe('800.00');
  });

  it('money in that is not a reversal is not a negative expense', () => {
    expect(
      netOperatingExpenseEgp([row('INFLOW', 'misc', 300)]).toFixed(2),
    ).toBe('0.00');
  });

  it('capitalised, recovered and other-income rows are never an expense', () => {
    const rows = [
      ...[...NOT_OPERATING_EXPENSE].map((c) => row('OUTFLOW', c, 100)),
      ...[...NOT_OPERATING_EXPENSE].map((c) => row('INFLOW', c, 100, 'tx')),
    ];
    expect(netOperatingExpenseEgp(rows).toFixed(2)).toBe('0.00');
  });
});

describe('netOtherIncomeEgp', () => {
  it('income counts; undone income stops counting', () => {
    expect(netOtherIncomeEgp([row('INFLOW', 'interest', 250)]).toFixed(2)).toBe(
      '250.00',
    );
    expect(
      netOtherIncomeEgp([
        row('INFLOW', 'interest', 250),
        row('OUTFLOW', 'interest', 250, 'tx-int'),
      ]).toFixed(2),
    ).toBe('0.00');
  });

  it('a sale, a payment, a contribution or a refund is not other income', () => {
    expect(
      netOtherIncomeEgp([
        row('INFLOW', 'revenue', 1000),
        row('INFLOW', 'contribution', 1000),
        row('INFLOW', 'supplier_refund', 1000),
        row('INFLOW', 'lender_financing', 1000),
        row('INFLOW', 'misc', 1000),
      ]).toFixed(2),
    ).toBe('0.00');
  });
});
