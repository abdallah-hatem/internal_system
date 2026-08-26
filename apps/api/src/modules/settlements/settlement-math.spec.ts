import { Prisma } from '@prisma/client';
import {
  distributeCycleProfit,
  summarizeCyclePnl,
  ParticipantInput,
} from './settlement-math';

const D = (v: string | number) => new Prisma.Decimal(v);

const partner = (
  id: string,
  contribution: string | number,
  extra: Partial<ParticipantInput> = {},
): ParticipantInput => ({
  id,
  type: 'CORE_PARTNER',
  contribution: D(contribution),
  customProfitPct: null,
  investorFeePct: null,
  ...extra,
});

const investor = (
  id: string,
  contribution: string | number,
  feePct: string | number | null,
): ParticipantInput => ({
  id,
  type: 'TEMP_INVESTOR',
  contribution: D(contribution),
  customProfitPct: null,
  investorFeePct: feePct === null ? null : D(feePct),
});

const byId = (r: ReturnType<typeof distributeCycleProfit>, id: string) =>
  r.lines.find((l) => l.participantId === id)!;

describe('distributeCycleProfit', () => {
  describe('proportional distribution (BRD 8)', () => {
    // A 80k, B 100k, C 120k -> 26.67%, 33.33%, 40%
    const participants = [
      partner('A', 80_000),
      partner('B', 100_000),
      partner('C', 120_000),
    ];

    it('splits profit in proportion to actual contribution', () => {
      const r = distributeCycleProfit(participants, D(30_000));

      expect(byId(r, 'A').sharePct.toFixed(2)).toBe('26.67');
      expect(byId(r, 'B').sharePct.toFixed(2)).toBe('33.33');
      expect(byId(r, 'C').sharePct.toFixed(2)).toBe('40.00');

      expect(byId(r, 'A').grossProfit.toFixed(2)).toBe('8000.00');
      expect(byId(r, 'B').grossProfit.toFixed(2)).toBe('10000.00');
      expect(byId(r, 'C').grossProfit.toFixed(2)).toBe('12000.00');
    });

    it('returns capital separately from profit', () => {
      const r = distributeCycleProfit(participants, D(30_000));

      expect(byId(r, 'A').capitalReturn.toFixed(2)).toBe('80000.00');
      expect(byId(r, 'A').netProfit.toFixed(2)).toBe('8000.00');
      expect(byId(r, 'A').payout.toFixed(2)).toBe('88000.00');
    });

    it('distributes every unit of profit even when it does not divide evenly', () => {
      const r = distributeCycleProfit(participants, D('10000.01'));
      const summed = r.lines.reduce(
        (s, l) => s.add(l.grossProfit),
        new Prisma.Decimal(0),
      );
      expect(summed.toFixed(2)).toBe('10000.01');
    });
  });

  describe('temporary investor fee (BRD 8)', () => {
    // 50k gross profit x 15% = 7.5k fee; investor keeps 42.5k
    it('takes the fee from the investor profit, not their capital', () => {
      const r = distributeCycleProfit(
        [partner('A', 100_000), investor('INV', 100_000, 15)],
        D(100_000),
      );

      const inv = byId(r, 'INV');
      expect(inv.grossProfit.toFixed(2)).toBe('50000.00');
      expect(inv.investorFee.toFixed(2)).toBe('7500.00');
      expect(inv.netProfit.toFixed(2)).toBe('42500.00');
      expect(inv.capitalReturn.toFixed(2)).toBe('100000.00');
    });

    it('passes the fee to the core partners', () => {
      const r = distributeCycleProfit(
        [partner('A', 50_000), partner('B', 50_000), investor('INV', 100_000, 15)],
        D(100_000),
      );

      expect(byId(r, 'INV').investorFee.toFixed(2)).toBe('7500.00');
      // Equal split between the two core partners (BRD 19 assumption).
      expect(byId(r, 'A').feeReceived.toFixed(2)).toBe('3750.00');
      expect(byId(r, 'B').feeReceived.toFixed(2)).toBe('3750.00');
      expect(byId(r, 'INV').feeReceived.toFixed(2)).toBe('0.00');
    });

    it('charges no fee when the cycle lost money', () => {
      const r = distributeCycleProfit(
        [partner('A', 100_000), investor('INV', 100_000, 15)],
        D(-20_000),
      );

      const inv = byId(r, 'INV');
      expect(inv.grossProfit.toFixed(2)).toBe('-10000.00');
      expect(inv.investorFee.toFixed(2)).toBe('0.00');
      expect(inv.netProfit.toFixed(2)).toBe('-10000.00');
    });

    it('leaves the investor whole when no fee percentage is agreed', () => {
      const r = distributeCycleProfit(
        [partner('A', 100_000), investor('INV', 100_000, null)],
        D(100_000),
      );
      expect(byId(r, 'INV').investorFee.toFixed(2)).toBe('0.00');
      expect(byId(r, 'INV').netProfit.toFixed(2)).toBe('50000.00');
      expect(byId(r, 'A').feeReceived.toFixed(2)).toBe('0.00');
    });
  });

  describe('custom distribution (BRD 18)', () => {
    it('uses agreed percentages instead of contribution', () => {
      const r = distributeCycleProfit(
        [
          partner('A', 10_000, { customProfitPct: D(50) }),
          partner('B', 90_000, { customProfitPct: D(50) }),
        ],
        D(20_000),
      );

      expect(byId(r, 'A').grossProfit.toFixed(2)).toBe('10000.00');
      expect(byId(r, 'B').grossProfit.toFixed(2)).toBe('10000.00');
    });

    it('rejects custom percentages that do not add up to 100', () => {
      expect(() =>
        distributeCycleProfit(
          [
            partner('A', 10_000, { customProfitPct: D(50) }),
            partner('B', 90_000, { customProfitPct: D(30) }),
          ],
          D(20_000),
        ),
      ).toThrow(/must add up to 100/i);
    });

    it('rejects a partially specified custom split', () => {
      expect(() =>
        distributeCycleProfit(
          [partner('A', 10_000, { customProfitPct: D(50) }), partner('B', 90_000)],
          D(20_000),
        ),
      ).toThrow(/every participant/i);
    });
  });

  describe('totals', () => {
    it('reconciles: capital + net profit + fees received equals total payout', () => {
      const r = distributeCycleProfit(
        [partner('A', 50_000), partner('B', 50_000), investor('INV', 100_000, 20)],
        D(60_000),
      );

      const payouts = r.lines.reduce(
        (s, l) => s.add(l.payout),
        new Prisma.Decimal(0),
      );
      const expected = D(200_000).add(D(60_000)); // capital + profit
      expect(payouts.toFixed(2)).toBe(expected.toFixed(2));
      expect(r.totals.feesRedistributed.toFixed(2)).toBe('6000.00');
    });

    it('refuses to split a cycle nobody funded', () => {
      // This used to return all-zero shares, which sounds harmless and is not.
      // Every line then rounds to zero except the last, which takes the
      // residual — so the whole profit landed on whichever participant was
      // created last and the others got nothing, silently.
      //
      // The test that stood here passed a profit of ZERO, so all lines were
      // zero whatever the shares were, and it never saw any of that. It only
      // ever proved the code did not divide by zero.
      expect(() =>
        distributeCycleProfit([partner('A', 0), partner('B', 0), partner('C', 0)], D(90_000)),
      ).toThrow(/no basis to split/i);
    });

    it('refuses even when there is no profit to split', () => {
      // Nothing to distribute today, but the cycle is still unfunded and
      // settling it would record capital returns of zero against partners who
      // did put money in. The refusal is about the missing contributions.
      expect(() =>
        distributeCycleProfit([partner('A', 0), partner('B', 0)], D(0)),
      ).toThrow(/no basis to split/i);
    });

    it('still settles an unfunded cycle when the split was agreed explicitly', () => {
      // The escape hatch: percentages agreed between the partners override
      // contribution entirely, so a cycle funded outside the system can still
      // be settled without inventing contribution figures.
      const withPct = (id: string, pct: number) => ({
        ...partner(id, 0),
        customProfitPct: D(pct),
      });
      const r = distributeCycleProfit(
        [withPct('A', 50), withPct('B', 30), withPct('C', 20)],
        D(90_000),
      );
      expect(r.lines.map((l) => l.grossProfit.toFixed(2))).toEqual([
        '45000.00',
        '27000.00',
        '18000.00',
      ]);
    });
  });
});

describe('summarizeCyclePnl', () => {
  const alloc = (qty: string | number, unitPrice: string | number, cogs: string | number) => ({
    qty: D(qty),
    unitPrice: D(unitPrice),
    cogs: D(cogs),
  });

  it('earns revenue and COGS from the batches the cycle actually sold', () => {
    const r = summarizeCyclePnl({
      allocations: [alloc(10, 300, 2270), alloc(5, 320, 1135)],
      expenses: D(0),
      unsoldValue: D(0),
      unitsRemaining: D(0),
    });

    expect(r.revenue.toFixed(2)).toBe('4600.00'); // 10*300 + 5*320
    expect(r.cogs.toFixed(2)).toBe('3405.00');
    expect(r.grossProfit.toFixed(2)).toBe('1195.00');
    expect(r.unitsSold.toFixed(3)).toBe('15.000');
  });

  it('reduces profit by cycle expenses that were not capitalised into landed cost', () => {
    const r = summarizeCyclePnl({
      allocations: [alloc(10, 300, 2000)],
      expenses: D(500),
      unsoldValue: D(0),
      unitsRemaining: D(0),
    });

    expect(r.revenue.toFixed(2)).toBe('3000.00');
    expect(r.expenses.toFixed(2)).toBe('500.00');
    expect(r.grossProfit.toFixed(2)).toBe('500.00'); // 3000 - 2000 - 500
  });

  it('keeps unsold stock out of profit and reports it separately', () => {
    const r = summarizeCyclePnl({
      allocations: [alloc(10, 300, 2000)],
      expenses: D(0),
      unsoldValue: D(9080),
      unitsRemaining: D(40),
    });

    expect(r.grossProfit.toFixed(2)).toBe('1000.00');
    expect(r.unsoldValue.toFixed(2)).toBe('9080.00');
    expect(r.unitsRemaining.toFixed(3)).toBe('40.000');
    expect(r.fullySold).toBe(false);
  });

  it('flags a cycle as fully sold when nothing remains', () => {
    const r = summarizeCyclePnl({
      allocations: [alloc(10, 300, 2000)],
      expenses: D(0),
      unsoldValue: D(0),
      unitsRemaining: D(0),
    });
    expect(r.fullySold).toBe(true);
  });

  it('reports a loss when costs exceed revenue', () => {
    const r = summarizeCyclePnl({
      allocations: [alloc(10, 100, 2000)],
      expenses: D(300),
      unsoldValue: D(0),
      unitsRemaining: D(0),
    });
    expect(r.grossProfit.toFixed(2)).toBe('-1300.00');
  });

  it('is zero for a cycle that has sold nothing', () => {
    const r = summarizeCyclePnl({
      allocations: [],
      expenses: D(0),
      unsoldValue: D(5000),
      unitsRemaining: D(20),
    });
    expect(r.revenue.toFixed(2)).toBe('0.00');
    expect(r.grossProfit.toFixed(2)).toBe('0.00');
  });
});
