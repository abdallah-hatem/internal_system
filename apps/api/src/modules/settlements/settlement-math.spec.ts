import { Prisma } from '@prisma/client';
import {
  distributeCycleProfit,
  percentagesOf,
  profitSplitView,
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
        [
          partner('A', 50_000),
          partner('B', 50_000),
          investor('INV', 100_000, 15),
        ],
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
          [
            partner('A', 10_000, { customProfitPct: D(50) }),
            partner('B', 90_000),
          ],
          D(20_000),
        ),
      ).toThrow(/every participant/i);
    });
  });

  describe('totals', () => {
    it('reconciles: capital + net profit + fees received equals total payout', () => {
      const r = distributeCycleProfit(
        [
          partner('A', 50_000),
          partner('B', 50_000),
          investor('INV', 100_000, 20),
        ],
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
        distributeCycleProfit(
          [partner('A', 0), partner('B', 0), partner('C', 0)],
          D(90_000),
        ),
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

  /**
   * Owner decision 2026-10-19 (§8, §18), replacing 2026-10-11's equal split:
   * a friend's payment is a loan the partners repay, and each partner's
   * contribution is their share of repaying it — "maybe 30,30,40". Profit
   * follows those contributions; with none entered it refuses like any other
   * cycle (CLAUDE.md §10). Non-zero profits only — zero hides every share bug
   * there is.
   */
  describe('a cycle a friend paid for — the partners repay him (§18, 2026-10-19)', () => {
    it('contributions 30/30/40 of 172,155.50 split 90,000 of profit 30/30/40 and return that capital', () => {
      const r = distributeCycleProfit(
        [
          partner('A', '51646.65'),
          partner('B', '51646.65'),
          partner('C', '68862.20'),
        ],
        D(90_000),
      );
      expect(r.lines.map((l) => l.sharePct.toFixed(2))).toEqual([
        '30.00',
        '30.00',
        '40.00',
      ]);
      expect(r.lines.map((l) => l.grossProfit.toFixed(2))).toEqual([
        '27000.00',
        '27000.00',
        '36000.00',
      ]);
      expect(r.lines.map((l) => l.capitalReturn.toFixed(2))).toEqual([
        '51646.65',
        '51646.65',
        '68862.20',
      ]);
      expect(r.totals.capitalReturned.toFixed(2)).toBe('172155.50');
      expect(r.totals.payout.toFixed(2)).toBe('262155.50');
    });

    it('shares a loss the same 30/30/40', () => {
      const r = distributeCycleProfit(
        [partner('A', 30), partner('B', 30), partner('C', 40)],
        D(-9_000),
      );
      expect(r.lines.map((l) => l.grossProfit.toFixed(2))).toEqual([
        '-2700.00',
        '-2700.00',
        '-3600.00',
      ]);
    });

    it('nothing entered from the partners refuses — there is no equal split for a friend-paid cycle any more', () => {
      expect(() =>
        distributeCycleProfit(
          [partner('A', 0), partner('B', 0), partner('C', 0)],
          D(90_000),
        ),
      ).toThrow(/no basis to split/i);
    });

    it('an investor on it who put in nothing takes nothing, not even the residual', () => {
      const r = distributeCycleProfit(
        [
          partner('A', 1),
          partner('B', 1),
          partner('C', 1),
          investor('INV', 0, 15),
        ],
        D(100_000),
      );
      expect(byId(r, 'INV').grossProfit.toFixed(2)).toBe('0.00');
      expect(byId(r, 'C').grossProfit.toFixed(2)).toBe('33333.34');
      expect(r.totals.payout.toFixed(2)).toBe('100003.00');
    });

    it('lets a custom split override the contributions', () => {
      const r = distributeCycleProfit(
        [
          partner('A', 30, { customProfitPct: D(50) }),
          partner('B', 30, { customProfitPct: D(30) }),
          partner('C', 40, { customProfitPct: D(20) }),
        ],
        D(90_000),
      );
      expect(r.lines.map((l) => l.grossProfit.toFixed(2))).toEqual([
        '45000.00',
        '27000.00',
        '18000.00',
      ]);
    });
  });

  describe('the rounding residual (§8 guess, 2026-10-11)', () => {
    it('an agreed split whose last participant has 0% gives the residual to the last non-zero share, not to him', () => {
      // Thirds to four places leave 0.01 over on 100.00. Before L2 the last
      // line took it, so D — agreed 0% — was paid a piastre.
      const withPct = (id: string, pct: string) => ({
        ...partner(id, 10_000),
        customProfitPct: D(pct),
      });
      const r = distributeCycleProfit(
        [
          withPct('A', '33.3333'),
          withPct('B', '33.3333'),
          withPct('C', '33.3334'),
          withPct('D', '0'),
        ],
        D(100),
      );
      expect(r.lines.map((l) => l.grossProfit.toFixed(2))).toEqual([
        '33.33',
        '33.33',
        '33.34',
        '0.00',
      ]);
      expect(r.totals.grossProfit.toFixed(2)).toBe('100.00');
    });
  });
});

describe('summarizeCyclePnl', () => {
  const alloc = (
    qty: string | number,
    unitPrice: string | number,
    cogs: string | number,
  ) => ({
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

describe('profitSplitView — the Funding card’s split line (owner 2026-10-26)', () => {
  it('equal contributions read as equal thirds, 33.33 / 33.33 / 33.34, adding up to 100', () => {
    const v = profitSplitView([
      partner('a', 40000),
      partner('b', 40000),
      partner('c', 40000),
    ]);
    expect(v).toEqual({
      basis: 'CONTRIBUTIONS',
      equal: true,
      problem: null,
      pcts: ['33.33', '33.33', '33.34'],
    });
  });

  it('unequal contributions read as their shares, each its true rounding — not 26.66 / 33.33 / 40.01 with the last absorbing', () => {
    const v = profitSplitView([
      partner('a', 80000),
      partner('b', 100000),
      partner('c', 120000),
    ]);
    expect(v.equal).toBe(false);
    expect(v.pcts).toEqual(['26.67', '33.33', '40.00']);
  });

  it('a custom split shows the agreed percentages, and names the refusal settling would give', () => {
    expect(
      profitSplitView([
        partner('a', 0, { customProfitPct: D(30) }),
        partner('b', 0, { customProfitPct: D(30) }),
        partner('c', 0, { customProfitPct: D(40) }),
      ]),
    ).toEqual({
      basis: 'CUSTOM_SPLIT',
      equal: false,
      problem: null,
      pcts: ['30.00', '30.00', '40.00'],
    });
    expect(
      profitSplitView([
        partner('a', 0, { customProfitPct: D(50) }),
        partner('b', 0),
      ]).problem,
    ).toBe('PARTIAL_CUSTOM_SPLIT');
    expect(
      profitSplitView([
        partner('a', 0, { customProfitPct: D(33.33) }),
        partner('b', 0, { customProfitPct: D(33.33) }),
        partner('c', 0, { customProfitPct: D(33.33) }),
      ]).problem,
    ).toBe('SPLIT_NOT_100');
  });

  it('nothing contributed: no percentages at all — never 0 / 0 / 100 (CLAUDE.md §10)', () => {
    const v = profitSplitView([
      partner('a', 0),
      partner('b', 0),
      partner('c', 0),
    ]);
    expect(v.basis).toBe('NONE');
    expect(v.pcts).toEqual([null, null, null]);
  });
});

/**
 * CYC-2026-0001 as corrected 2026-10-27: Abdallah 55,000, Shady 33,084.50,
 * Fares 33,084.49, Ahmad Eraiby (investor) 60,000, Mohammed Setta (investor)
 * 20,000 — 201,168.99 in all, in the order production lists them.
 */
const cycleOne = () => [
  partner('abdallah', '55000.00'),
  partner('shady', '33084.50'),
  partner('fares', '33084.49'),
  investor('eraiby', '60000.00', null),
  investor('setta', '20000.00', null),
];

describe('the Funding card’s percentages, every participant, by largest remainder (owner 2026-10-27)', () => {
  it('production’s cycle 1: everyone on it, investors included, each within a hundredth of the truth, summing to 100.00', () => {
    const v = profitSplitView(cycleOne());
    // True shares: 27.3402 / 16.4461 / 16.4461 / 29.8257 / 9.9419.
    // Rounded each: 27.34 + 16.45 + 16.45 + 29.83 + 9.94 = 100.01, so one
    // row must give a hundredth: Eraiby, who rounded up the least (.57
    // against Shady’s and Fares’ .61). Setta reads 9.94, never 9.96.
    expect(v.pcts).toEqual(['27.34', '16.45', '16.45', '29.82', '9.94']);
    expect(v.pcts.reduce((s, p) => s.add(p!), D(0)).toFixed(2)).toBe('100.00');
  });

  it('the same split the settlement makes of the profit, to the hundredth (one definition, CLAUDE.md §11)', () => {
    const v = profitSplitView(cycleOne());
    const settled = distributeCycleProfit(cycleOne(), D('90000.00'));
    settled.lines.forEach((l, i) => {
      expect(l.sharePct.sub(v.pcts[i]!).abs().lte('0.01')).toBe(true);
    });
  });

  it('thirds tie: the odd hundredth to the last, as the money lines do — 33.33 / 33.33 / 33.34', () => {
    expect(percentagesOf([1, 1, 1]).map((p) => p.toFixed(2))).toEqual([
      '33.33',
      '33.33',
      '33.34',
    ]);
    // Seven equal: four hundredths missing, to the last four.
    expect(
      percentagesOf([1, 1, 1, 1, 1, 1, 1]).map((p) => p.toFixed(2)),
    ).toEqual(['14.28', '14.28', '14.28', '14.29', '14.29', '14.29', '14.29']);
  });

  it('one participant reads 100.00; one who put in nothing reads 0.00 and takes no rounding', () => {
    expect(percentagesOf([5]).map((p) => p.toFixed(2))).toEqual(['100.00']);
    expect(percentagesOf([0, 1, 2]).map((p) => p.toFixed(2))).toEqual([
      '0.00',
      '33.33',
      '66.67',
    ]);
  });

  it('nothing put in, or a negative part: no percentages at all (CLAUDE.md §10)', () => {
    expect(() => percentagesOf([0, 0])).toThrow();
    expect(() => percentagesOf([])).toThrow();
    expect(() => percentagesOf([10, -5])).toThrow();
  });

  it('any contributions: always 100.00, every row within a hundredth of its true share', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let run = 0; run < 500; run++) {
      const n = 1 + Math.floor(rand() * 8);
      const values = Array.from({ length: n }, () =>
        D(Math.floor(rand() * 10_000_000) / 100 + 0.01),
      );
      const total = values.reduce((s, v) => s.add(v), D(0));
      const pcts = percentagesOf(values);
      expect(pcts.reduce((s, p) => s.add(p), D(0)).toFixed(2)).toBe('100.00');
      pcts.forEach((p, i) => {
        const exact = values[i].div(total).mul(100);
        expect(p.sub(exact).abs().lt('0.01')).toBe(true);
      });
    }
  });
});
