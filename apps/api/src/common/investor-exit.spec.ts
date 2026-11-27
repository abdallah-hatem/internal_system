import { BadRequestException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access
import { Prisma } from '@prisma/client';
import {
  distributeCycleProfit,
  profitSplitView,
  profitTakeOf,
  type ParticipantInput,
} from '../modules/settlements/settlement-math';
import { exitPayout, remainingRecoveredShare } from './investor-exit';

/**
 * An investor paid out and taken off a cycle (BUSINESS_LOGIC §8, owner
 * 2026-11-27) — the arithmetic, on its own: his share frozen, the rest split
 * among those still on the cycle, the payout cut into profit and capital, and
 * what cash recovered still covers for the others. The Postgres suite
 * (`profit-draws/investor-exit.db.spec.ts`) drives the same through the
 * services.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

const seat = (
  id: string,
  type: 'CORE_PARTNER' | 'TEMP_INVESTOR',
  contribution: Prisma.Decimal.Value,
  extra: Partial<ParticipantInput> = {},
): ParticipantInput => ({
  id,
  type,
  contribution: D(contribution),
  customProfitPct: null,
  investorFeePct: null,
  ...extra,
});

/** CYC-2026-0001 as the owner gave it on 2026-11-27. */
const cycle1 = () => [
  seat('abdallah', 'CORE_PARTNER', '55000'),
  seat('shady', 'CORE_PARTNER', '45584.50'),
  seat('fares', 'CORE_PARTNER', '45584.49'),
  seat('eraiby', 'TEMP_INVESTOR', '27500'),
  seat('osama', 'TEMP_INVESTOR', '27500'),
];
const PROFIT = D('34433.90');

/** Freeze one participant's line as an exit records it. */
function exitOf(
  people: ParticipantInput[],
  id: string,
  profit: Prisma.Decimal,
): ParticipantInput[] {
  const line = distributeCycleProfit(people, profit).lines.find(
    (l) => l.participantId === id,
  )!;
  return people.map((p) =>
    p.id === id
      ? {
          ...p,
          exited: {
            grossProfit: line.grossProfit,
            investorFee: line.investorFee,
            netProfit: line.netProfit,
            sharePct: line.sharePct,
          },
        }
      : p,
  );
}

const sum = (xs: Prisma.Decimal[]) => xs.reduce((s, x) => s.add(x), D(0));

describe('an investor exits: the split (§8, 2026-11-27)', () => {
  it('CYC-2026-0001: each investor 13.6701% of 34,433.90 = 4,707.15, capital 27,500, paid 32,207.15', () => {
    const before = distributeCycleProfit(cycle1(), PROFIT);
    const eraiby = before.lines[3];
    expect(eraiby.sharePct.toFixed(4)).toBe('13.6701');
    expect(eraiby.netProfit.toFixed(2)).toBe('4707.15');
    expect(eraiby.capitalReturn.add(eraiby.netProfit).toFixed(2)).toBe(
      '32207.15',
    );
  });

  it('after both exit, the same profit gives the partners exactly what they had — and every line still sums to the profit', () => {
    const before = distributeCycleProfit(cycle1(), PROFIT).lines;
    const one = exitOf(cycle1(), 'eraiby', PROFIT);
    const both = exitOf(one, 'osama', PROFIT);
    const osama = distributeCycleProfit(one, PROFIT).lines[4];
    // Renormalised among the remaining by contribution, his share is the same.
    expect(osama.netProfit.toFixed(2)).toBe('4707.15');
    const after = distributeCycleProfit(both, PROFIT).lines;
    expect(sum(after.map((l) => l.grossProfit)).toFixed(2)).toBe('34433.90');
    after.slice(0, 3).forEach((l, i) => {
      // The odd piastre may move; never more.
      expect(l.grossProfit.sub(before[i].grossProfit).abs().lte('0.01')).toBe(
        true,
      );
    });
    expect(after[3].netProfit.toFixed(2)).toBe('4707.15');
    expect(after[4].netProfit.toFixed(2)).toBe('4707.15');
    expect(after[3].sharePct.toFixed(4)).toBe('13.6701');
  });

  it('a later cost lands only on the remaining partners: the exited share does not move', () => {
    const both = exitOf(exitOf(cycle1(), 'eraiby', PROFIT), 'osama', PROFIT);
    const later = PROFIT.sub(10_000);
    const lines = distributeCycleProfit(both, later).lines;
    expect(lines[3].grossProfit.toFixed(2)).toBe('4707.15');
    expect(lines[4].grossProfit.toFixed(2)).toBe('4707.15');
    const partners = sum(lines.slice(0, 3).map((l) => l.grossProfit));
    expect(partners.toFixed(2)).toBe(later.sub('9414.30').toFixed(2));
    // Split among them by contribution: 55,000 of 146,168.99.
    expect(lines[0].grossProfit.toFixed(2)).toBe(
      partners
        .mul(55000)
        .div('146168.99')
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(2),
    );
    expect(lines[0].sharePct.toFixed(4)).toBe('37.6277');
  });

  it('a loss after the exit beyond what is left: the partners carry it, the exited share still stands', () => {
    const both = exitOf(exitOf(cycle1(), 'eraiby', PROFIT), 'osama', PROFIT);
    const lines = distributeCycleProfit(both, D(-5000)).lines;
    expect(lines[3].grossProfit.toFixed(2)).toBe('4707.15');
    expect(sum(lines.slice(0, 3).map((l) => l.grossProfit)).toFixed(2)).toBe(
      '-14414.30',
    );
  });

  it("his fee is frozen with his share and still passes to the core partners: partners' + investors' = the profit", () => {
    const people = [
      seat('a', 'CORE_PARTNER', 1000),
      seat('b', 'CORE_PARTNER', 1000),
      seat('m', 'TEMP_INVESTOR', 2000, { investorFeePct: D(20) }),
    ];
    const exited = exitOf(people, 'm', D(900));
    const m = exited[2].exited!;
    expect(m.grossProfit.toFixed(2)).toBe('450.00');
    expect(m.investorFee.toFixed(2)).toBe('90.00');
    expect(m.netProfit.toFixed(2)).toBe('360.00');
    const later = distributeCycleProfit(exited, D(1300));
    // The partners split 1,300 − 450 and receive the 90 fee between them.
    expect(later.lines[0].grossProfit.toFixed(2)).toBe('425.00');
    expect(later.lines[0].feeReceived.toFixed(2)).toBe('45.00');
    expect(later.totals.netProfit.toFixed(2)).toBe('1300.00');
    expect(later.lines[2].netProfit.toFixed(2)).toBe('360.00');
  });

  it('an agreed split: the remaining percentages renormalised among the remaining (GUESS)', () => {
    const people = [
      seat('a', 'CORE_PARTNER', 1000, { customProfitPct: D(30) }),
      seat('b', 'CORE_PARTNER', 1000, { customProfitPct: D(30) }),
      seat('m', 'TEMP_INVESTOR', 1000, { customProfitPct: D(40) }),
    ];
    const exited = exitOf(people, 'm', D(1000));
    expect(exited[2].exited!.grossProfit.toFixed(2)).toBe('400.00');
    const lines = distributeCycleProfit(exited, D(2000)).lines;
    expect(lines.map((l) => l.grossProfit.toFixed(2))).toEqual([
      '800.00',
      '800.00',
      '400.00',
    ]);
    expect(lines[0].sharePct.toFixed(4)).toBe('50.0000');
    // Still refused when the stored split is not whole.
    const broken = exited.map((p, i) =>
      i === 0 ? { ...p, customProfitPct: D(10) } : p,
    );
    expect(() => distributeCycleProfit(broken, D(2000))).toThrow();
  });

  it('nobody left with a basis: refused, never a split that lands on whoever is last (CLAUDE.md §10)', () => {
    const people = [
      seat('a', 'CORE_PARTNER', 0),
      seat('m', 'TEMP_INVESTOR', 1000),
    ];
    const exited = exitOf(people, 'm', D(500));
    let code: string | undefined;
    try {
      distributeCycleProfit(exited, D(800));
    } catch (e) {
      code = ((e as BadRequestException).getResponse() as { code?: string })
        .code;
    }
    expect(code).toBe('CYCLE_NOT_FUNDED');
  });

  it("taking early after the exit: the partners' share of what is collected is less what the exits paid as profit", () => {
    const both = exitOf(exitOf(cycle1(), 'eraiby', PROFIT), 'osama', PROFIT);
    // 95.04% collected of 34,433.90.
    const collected = D('32726.00');
    const lines = profitTakeOf(both, collected)!;
    const partners = sum(lines.slice(0, 3).map((l) => l.takeable));
    expect(partners.toFixed(2)).toBe(collected.sub('9414.30').toFixed(2));
  });

  it("the Funding card's percentages: the remaining read 100 among themselves, the exited none", () => {
    const both = exitOf(exitOf(cycle1(), 'eraiby', PROFIT), 'osama', PROFIT);
    const view = profitSplitView(both);
    expect(view.pcts).toEqual(['37.63', '31.19', '31.18', null, null]);
    expect(view.basis).toBe('CONTRIBUTIONS');
  });
});

describe('exitPayout: what an exit hands over, and as what', () => {
  it('nothing taken: capital and profit, as they are', () => {
    const p = exitPayout({
      capital: D(27500),
      netProfit: D('4707.15'),
      takenProfit: D(0),
      takenCapital: D(0),
    })!;
    expect([p.profitPart, p.capitalPart, p.payout].map(String)).toEqual([
      '4707.15',
      '27500',
      '32207.15',
    ]);
  });

  it("what he took on the card comes off — the owner's case: 4,473.75 profit and 22,972.73 capital taken leave 233.40 + 4,527.27", () => {
    const p = exitPayout({
      capital: D(27500),
      netProfit: D('4707.15'),
      takenProfit: D('4473.75'),
      takenCapital: D('22972.73'),
    })!;
    expect(p.profitPart.toFixed(2)).toBe('233.40');
    expect(p.capitalPart.toFixed(2)).toBe('4527.27');
    expect(p.payout.toFixed(2)).toBe('4760.67');
  });

  it('drew more profit than his share: the excess comes off his capital', () => {
    const p = exitPayout({
      capital: D(1000),
      netProfit: D(100),
      takenProfit: D(300),
      takenCapital: D(0),
    })!;
    expect(p.profitPart.toFixed(2)).toBe('0.00');
    expect(p.capitalPart.toFixed(2)).toBe('800.00');
  });

  it('a loss: his share of it comes off his capital (GUESS)', () => {
    const p = exitPayout({
      capital: D(1000),
      netProfit: D(-250),
      takenProfit: D(0),
      takenCapital: D(0),
    })!;
    expect(p.payout.toFixed(2)).toBe('750.00');
    expect(p.profitPart.toFixed(2)).toBe('0.00');
  });

  it('exactly nothing left to pay: an exit of zero is allowed', () => {
    const p = exitPayout({
      capital: D(1000),
      netProfit: D(0),
      takenProfit: D(0),
      takenCapital: D(1000),
    })!;
    expect(p.payout.toFixed(2)).toBe('0.00');
  });

  it('he would owe the business: refused (null), never a negative payout', () => {
    expect(
      exitPayout({
        capital: D(1000),
        netProfit: D(-400),
        takenProfit: D(0),
        takenCapital: D(700),
      }),
    ).toBeNull();
  });
});

describe('remainingRecoveredShare: what recovered cash still covers for those left', () => {
  it('nobody exited: the cycle share, untouched', () => {
    expect(
      remainingRecoveredShare({
        share: D('0.8354'),
        allContributions: D(100),
        liveContributions: D(100),
        exitedCapitalTaken: D(0),
        anyExited: false,
      }).toString(),
    ).toBe('0.8354');
  });

  it("CYC-2026-0001: 83.54% recovered, both investors' 55,000 paid out of it — the partners' cover falls to 77.35%", () => {
    const s = remainingRecoveredShare({
      share: D('0.8354'),
      allContributions: D('201168.99'),
      liveContributions: D('146168.99'),
      exitedCapitalTaken: D(55000),
      anyExited: true,
    });
    expect(s.mul(100).toFixed(2)).toBe('77.35');
  });

  it('the exits took more than was recovered: nothing for anyone yet', () => {
    expect(
      remainingRecoveredShare({
        share: D('0.1'),
        allContributions: D(1000),
        liveContributions: D(500),
        exitedCapitalTaken: D(500),
        anyExited: true,
      }).toString(),
    ).toBe('0');
  });

  it('never more than the cycle share', () => {
    expect(
      remainingRecoveredShare({
        share: D('0.5'),
        allContributions: D(1000),
        liveContributions: D(500),
        exitedCapitalTaken: D(0),
        anyExited: true,
      }).toString(),
    ).toBe('0.5');
  });
});
