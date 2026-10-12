// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import {
  buildPayoutBreakdown,
  cycleCostLines,
  sumCostLines,
  type CycleCostLine,
} from './payout-breakdown';

/**
 * L7 — a payout explains itself (BUSINESS_LOGIC §8, owner 2026-10-11).
 *
 * The settlement keeps one figure, "expenses", and the screen showed it as a
 * lump. These pin that the lump splits into named lines that add back up to
 * it exactly, and that each partner's lines add up to what he was paid.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const r = (
  direction: 'INFLOW' | 'OUTFLOW',
  category: string,
  amount: number,
  reversalOfId: string | null = null,
) => ({ direction, category, amount: D(amount), reversalOfId });

describe('cycleCostLines — the lump, line by line', () => {
  const input = {
    expenseRows: [
      r('OUTFLOW', 'extra_freight', 1200),
      r('OUTFLOW', 'customs_clearance', 800),
      r('OUTFLOW', 'extra_freight', 300),
      // An extra-freight entry undone: it nets out of its own line.
      r('INFLOW', 'extra_freight', 300, 'x'),
    ],
    recoveryRows: [r('INFLOW', 'supplier_refund', 500)],
    otherIncomeRows: [r('INFLOW', 'income_other', 100)],
    lossesEgp: D(2000),
    exchangeDifferenceEgp: D(-150),
  };

  it('one line per category and per kind; a gain is a negative cost', () => {
    const lines = cycleCostLines(input);
    expect(lines.map((l) => [l.kind, l.category, l.amountEgp])).toEqual([
      ['charge', 'extra_freight', '1200.00'],
      ['charge', 'customs_clearance', '800.00'],
      ['loss', null, '2000.00'],
      ['exchange', null, '-150.00'],
      ['recovery', 'supplier_refund', '-500.00'],
      ['otherIncome', 'income_other', '-100.00'],
    ]);
  });

  it('the lines add up to exactly the expenses the settlement subtracts', () => {
    // 1,200 + 800 + 2,000 − 150 − 500 − 100
    expect(sumCostLines(cycleCostLines(input)).toFixed(2)).toBe('3250.00');
  });

  it('a kind with nothing in it is left out, not shown as 0.00', () => {
    expect(
      cycleCostLines({
        expenseRows: [],
        recoveryRows: [],
        otherIncomeRows: [],
        lossesEgp: D(0),
        exchangeDifferenceEgp: D(0),
      }),
    ).toEqual([]);
  });
});

type Line = {
  participantId: string;
  component: string;
  amount: Prisma.Decimal.Value;
  participant: {
    id: string;
    participantType: string;
    partnerUserId: string | null;
  };
};
const line = (
  pid: string,
  type: 'CORE_PARTNER' | 'TEMP_INVESTOR',
  component: string,
  amount: number,
): Line => ({
  participantId: pid,
  component,
  amount,
  participant: {
    id: pid,
    participantType: type,
    partnerUserId: type === 'CORE_PARTNER' ? `u-${pid}` : null,
  },
});

// 90,000 revenue, 50,000 cost of goods, 4,000 of costs: 36,000 profit.
// Partner A put in 30,000 and the investor 20,000 (60% / 40%); the investor's
// 15% fee on his 14,400 is 2,160, passed to the one core partner.
const COSTS: CycleCostLine[] = [
  { kind: 'charge', category: 'extra_freight', amountEgp: '3000.00' },
  { kind: 'loss', category: null, amountEgp: '1000.00' },
];
const SETTLEMENT = {
  status: 'PAID',
  revenueEgp: D(90000),
  cogsEgp: D(50000),
  expensesEgp: D(4000),
  grossProfitEgp: D(36000),
  costBreakdown: { costs: COSTS },
};
const LINES: Line[] = [
  line('a', 'CORE_PARTNER', 'CAPITAL_RETURN', 30000),
  line('a', 'CORE_PARTNER', 'PROFIT_SHARE', 21600),
  line('a', 'CORE_PARTNER', 'INVESTOR_FEE_RECEIVED', 2160),
  line('a', 'CORE_PARTNER', 'RUNNING_COSTS', -10000),
  line('i', 'TEMP_INVESTOR', 'CAPITAL_RETURN', 20000),
  line('i', 'TEMP_INVESTOR', 'PROFIT_SHARE', 12240),
  line('i', 'TEMP_INVESTOR', 'INVESTOR_FEE', -2160),
];

function build(
  overrides: Partial<Parameters<typeof buildPayoutBreakdown>[0]> = {},
) {
  return buildPayoutBreakdown({
    settlement: SETTLEMENT,
    lines: LINES,
    runningCosts: new Map([
      ['a', { amountEgp: D(10000), from: '2026-07-01', to: '2026-09-30' }],
    ]),
    leftoversMovedEgp: D(0),
    ...overrides,
  });
}

describe('buildPayoutBreakdown — every figure from the settlement itself', () => {
  it('the cycle lines are the settlement’s own: revenue, cost of goods, each cost, profit', () => {
    const b = build();
    expect(b.revenueEgp).toBe('90000.00');
    expect(b.cogsEgp).toBe('50000.00');
    expect(b.costs).toEqual(COSTS);
    expect(b.cycleProfitEgp).toBe('36000.00');
    // revenue − cost of goods − every cost = the cycle's profit
    expect(
      D(b.revenueEgp).sub(b.cogsEgp).sub(sumCostLines(b.costs!)).toFixed(2),
    ).toBe(b.cycleProfitEgp);
  });

  it('a partner’s lines: his share of the profit, the fee he receives, capital back, running costs — summing to what he is paid', () => {
    const a = build().participants.find((p) => p.participantId === 'a')!;
    expect(a).toMatchObject({
      sharePct: '60.00',
      profitShareEgp: '21600.00',
      investorFeeEgp: '0.00',
      feeReceivedEgp: '2160.00',
      capitalBackEgp: '30000.00',
      runningCostsEgp: '-10000.00',
      runningCostsFrom: '2026-07-01',
      runningCostsTo: '2026-09-30',
      paidEgp: '43760.00',
    });
    const sum = D(a.profitShareEgp)
      .add(a.investorFeeEgp)
      .add(a.feeReceivedEgp)
      .add(a.capitalBackEgp)
      .add(a.runningCostsEgp);
    expect(sum.toFixed(2)).toBe(a.paidEgp);
  });

  it('the investor: his gross share, the fee taken from it, capital back — never running costs', () => {
    const i = build().participants.find((p) => p.participantId === 'i')!;
    expect(i).toMatchObject({
      sharePct: '40.00',
      profitShareEgp: '14400.00',
      investorFeeEgp: '-2160.00',
      feeReceivedEgp: '0.00',
      capitalBackEgp: '20000.00',
      runningCostsEgp: '0.00',
      paidEgp: '32240.00',
    });
  });

  it('what each is paid equals the settlement’s own payable lines — nothing recomputed', () => {
    const b = build();
    for (const p of b.participants) {
      const own = LINES.filter(
        (l) =>
          l.participantId === p.participantId && l.component !== 'INVESTOR_FEE',
      ).reduce((s, l) => s.add(l.amount), D(0));
      expect(p.paidEgp).toBe(own.toFixed(2));
    }
  });

  it('the partners’ shares add up to the cycle’s profit', () => {
    const total = build().participants.reduce(
      (s, p) => s.add(p.profitShareEgp),
      D(0),
    );
    expect(total.toFixed(2)).toBe('36000.00');
  });

  it('before it is paid, the running costs are what paying now would take — and the paid figure includes them', () => {
    const lines = LINES.filter((l) => l.component !== 'RUNNING_COSTS');
    const b = build({
      settlement: { ...SETTLEMENT, status: 'APPROVED' },
      lines,
    });
    const a = b.participants.find((p) => p.participantId === 'a')!;
    expect(a.runningCostsEgp).toBe('-10000.00');
    expect(a.runningCostsStatus).toBe('projected');
    expect(a.paidEgp).toBe('43760.00');
  });

  it('a settlement calculated before costs were kept line by line says so instead of inventing lines', () => {
    const b = build({ settlement: { ...SETTLEMENT, costBreakdown: null } });
    expect(b.costs).toBeNull();
    expect(b.expensesEgp).toBe('4000.00');
  });

  it('leftovers moved are shown, and are not a cost: the profit is unchanged by them', () => {
    const b = build({ leftoversMovedEgp: D(2200) });
    expect(b.leftoversMovedEgp).toBe('2200.00');
    expect(b.cycleProfitEgp).toBe('36000.00');
  });

  it('a loss: no share percentage is invented when the profit is zero', () => {
    const b = build({
      settlement: { ...SETTLEMENT, grossProfitEgp: D(0) },
      lines: [line('a', 'CORE_PARTNER', 'PROFIT_SHARE', 0)],
      runningCosts: new Map(),
    });
    expect(b.participants[0].sharePct).toBeNull();
  });
});
