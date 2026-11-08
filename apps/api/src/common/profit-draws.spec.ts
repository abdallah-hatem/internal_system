// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access
import { Prisma } from '@prisma/client';
import {
  PROFIT_DRAW_CATEGORY,
  collectedProfit,
  owedAfterPayout,
} from './profit-draws';
import {
  NOT_CASH_CATEGORIES,
  operatingExpenseEgp,
  otherIncomeEgp,
  recoveredEgp,
} from './ledger-categories';
import { buildPayoutBreakdown } from './payout-breakdown';

/** Profit taken before settlement (BUSINESS_LOGIC §8, owner 2026-11-08): the pure rules. */
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

describe('owedAfterPayout — what a partner still owes after a payout', () => {
  it.each([
    // payable (draws already off), drawn → owed
    ['1100', '200', '0'], // covered
    ['0', '200', '0'], // exactly covered
    ['-0.01', '200', '0.01'], // a piastre short
    ['-150', '200', '150'], // short by part of it
    ['-200', '200', '200'], // short by all of it
    ['-350', '200', '200'], // a loss beyond the draw is not the draw's
    ['-50', '0', '0'], // no draw: an ordinary negative payout, not owed here
  ])('payable %s with %s drawn owes %s', (payable, drawn, owed) => {
    expect(owedAfterPayout(D(payable), D(drawn)).toFixed(2)).toBe(
      D(owed).toFixed(2),
    );
  });
});

describe('collectedProfit — profit so far less what customers still owe', () => {
  it.each([
    ['900', '0', '900.00'],
    ['900', '500', '400.00'],
    ['900', '900', '0.00'],
    ['900', '2000', '0.00'], // owed more than the profit: nothing collected
    ['-600', '0', '0.00'], // a loss: nothing to take
    ['0.005', '0', '0.01'], // rounded to the piastre, half up
  ])('profit %s, owed %s → %s', (profit, owed, out) => {
    expect(collectedProfit(D(profit), D(owed)).toFixed(2)).toBe(out);
  });
});

describe('the profit_draw ledger category', () => {
  const row = (direction: string, reversalOfId: string | null = null) => ({
    direction,
    category: PROFIT_DRAW_CATEGORY,
    amount: '250.50',
    reversalOfId,
  });
  it('is never an operating expense, income or a recovery — either way', () => {
    for (const r of [row('OUTFLOW'), row('INFLOW', 'x')]) {
      expect(operatingExpenseEgp(r).toFixed(2)).toBe('0.00');
      expect(otherIncomeEgp(r).toFixed(2)).toBe('0.00');
      expect(recoveredEgp(r).toFixed(2)).toBe('0.00');
    }
  });
  it('is cash: cash on hand reads it', () => {
    expect(NOT_CASH_CATEGORIES as readonly string[]).not.toContain(
      PROFIT_DRAW_CATEGORY,
    );
  });
});

describe('buildPayoutBreakdown with profit taken', () => {
  const settlement = (status: string) => ({
    status,
    revenueEgp: '2000',
    cogsEgp: '1100',
    expensesEgp: '0',
    grossProfitEgp: '900',
    costBreakdown: { costs: [] },
  });
  const core = { participantType: 'CORE_PARTNER' };
  const lines = (drawn: string, capital = '1000', profit = '300') => [
    {
      participantId: 'a',
      component: 'CAPITAL_RETURN',
      amount: capital,
      participant: core,
    },
    {
      participantId: 'a',
      component: 'PROFIT_SHARE',
      amount: profit,
      participant: core,
    },
    ...(drawn === '0'
      ? []
      : [
          {
            participantId: 'a',
            component: 'PROFIT_DRAWN',
            amount: `-${drawn}`,
            participant: core,
          },
        ]),
  ];
  const build = (status: string, l: ReturnType<typeof lines>) =>
    buildPayoutBreakdown({
      settlement: settlement(status),
      lines: l,
      runningCosts: new Map(),
      leftoversMovedEgp: D(0),
    }).participants[0];

  it('takes the draw off what he is paid, and shows it as its own line', () => {
    expect(build('PAID', lines('200'))).toMatchObject({
      profitShareEgp: '300.00',
      capitalBackEgp: '1000.00',
      profitDrawnEgp: '-200.00',
      owedEgp: '0.00',
      paidEgp: '1100.00',
    });
  });

  it('a payout the draws exceed is paid as nothing, the rest owed', () => {
    expect(build('APPROVED', lines('450', '0', '0'))).toMatchObject({
      profitDrawnEgp: '-450.00',
      owedEgp: '450.00',
      paidEgp: '0.00',
    });
    expect(build('DRAFT', lines('400', '0', '300'))).toMatchObject({
      owedEgp: '100.00',
      paidEgp: '0.00',
    });
  });

  it('without draws nothing changes', () => {
    expect(build('PAID', lines('0'))).toMatchObject({
      profitDrawnEgp: '0.00',
      owedEgp: '0.00',
      paidEgp: '1300.00',
    });
  });
});
