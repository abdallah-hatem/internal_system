// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access
import { Prisma } from '@prisma/client';
import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ROLES_KEY, RolesGuard } from './guards/roles.guard';
import {
  assertCovers,
  assertCycleCovers,
  availableTo,
  balanceOf,
  contributionShares,
  equalShareGap,
  equalShareSettleUp,
  equalShares,
  inTargetCurrency,
  isUntiedMovement,
  potsOf,
  potsTotal,
  putInSoFar,
} from './partner-account';
import {
  agreedSplitIsEqual,
  profitShareOf,
} from '../modules/settlements/settlement-math';
import {
  CycleAccountFundingController,
  PartnerAccountsController,
} from '../modules/partner-accounts/partner-accounts.controller';

/**
 * The partner-account rules that need no database (BUSINESS_LOGIC §8, owner
 * 2026-10-25). The rest is `partner-accounts.db.spec.ts`.
 */
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

describe('equalShares — equal thirds to the piastre (CLAUDE.md §10)', () => {
  it.each([
    ['1000', ['333.33', '333.33', '333.34']],
    ['100000', ['33333.33', '33333.33', '33333.34']],
    ['75645.50', ['25215.16', '25215.16', '25215.18']],
    ['0.02', ['0', '0', '0.02']],
  ])('%s splits into %j and re-sums exactly', (total, expected) => {
    const shares = equalShares(total, 3);
    expect(shares.map((s) => s.toString())).toEqual(expected);
    expect(shares.reduce((s, x) => s.add(x), D(0)).eq(D(total))).toBe(true);
  });

  it('refuses a total of zero or less, or nobody to share it — rounding never decides', () => {
    expect(() => equalShares(0, 3)).toThrow();
    expect(() => equalShares(-5, 3)).toThrow();
    expect(() => equalShares(100, 0)).toThrow();
    expect(() => equalShares('10.005', 3)).toThrow();
  });
});

describe('the balance', () => {
  const m = (
    kind: string,
    amountEgp: number,
    reversedAt: Date | null = null,
  ) => ({ kind, amountEgp, reversedAt });

  it('advances and payouts left in add; contributions and withdrawals take away; reversed movements count for nothing', () => {
    expect(
      balanceOf([
        m('ADVANCE', 1000),
        m('PAYOUT_LEFT_IN', 250),
        m('CONTRIBUTION', 666.67),
        m('WITHDRAWAL', 100),
        m('ADVANCE', 5000, new Date()),
      ]).toFixed(2),
    ).toBe('483.33');
  });

  it('an expense he paid (§9 "Paid by") adds, as untied money any cycle can draw or he can take out; reversed, nothing', () => {
    const rows = [
      { kind: 'EXPENSE_PAID', amountEgp: 300, reversedAt: null },
      { kind: 'EXPENSE_PAID', amountEgp: 80, reversedAt: new Date() },
      { kind: 'WITHDRAWAL', amountEgp: 100, reversedAt: null },
    ];
    expect(balanceOf(rows).toFixed(2)).toBe('200.00');
    const pots = potsOf(rows);
    expect(pots.untied.toFixed(2)).toBe('200.00');
    expect(pots.byCycle.size).toBe(0);
    expect(availableTo(pots, 'any-cycle').toFixed(2)).toBe('200.00');
  });

  it('refuses taking more than it holds, naming what is short', () => {
    let err: HttpException | undefined;
    try {
      assertCovers({ balance: D(400), amount: D('666.67'), partner: 'Fares' });
    } catch (e) {
      err = e as HttpException;
    }
    expect(err?.getResponse()).toEqual(
      expect.objectContaining({
        code: 'ACCOUNT_BALANCE_TOO_LOW',
        params: expect.objectContaining({ short: '266.67' }) as unknown,
      }),
    );
    expect(() =>
      assertCovers({ balance: D(400), amount: D(400), partner: 'Fares' }),
    ).not.toThrow();
  });
});

describe('each cycle’s funding is its own (owner 2026-10-26)', () => {
  const m = (
    kind: string,
    amountEgp: number,
    cycleId: string | null = null,
    reversedAt: Date | null = null,
  ) => ({ kind, amountEgp, cycleId, reversedAt });
  const view = (movements: ReturnType<typeof m>[]) => {
    const pots = potsOf(movements);
    return {
      untied: pots.untied.toFixed(2),
      byCycle: Object.fromEntries(
        [...pots.byCycle].map(([k, v]) => [k, v.toFixed(2)]),
      ),
    };
  };

  it('an advance sits in its own cycle’s pot; a payout left in is untied though it names the cycle it came from', () => {
    expect(
      view([
        m('ADVANCE', 50_775, 'c2'),
        m('PAYOUT_LEFT_IN', 300, 'c0'),
        m('ADVANCE', 9_999, 'c2', new Date()),
      ]),
    ).toEqual({ untied: '300.00', byCycle: { c2: '50775.00' } });
  });

  it('a contribution draws its own cycle’s advance first, untied money for the rest; never another cycle’s', () => {
    const movements = [
      m('ADVANCE', 100, 'c2'),
      m('ADVANCE', 1_000, 'c3'),
      m('PAYOUT_LEFT_IN', 500),
      m('CONTRIBUTION', 250, 'c2'),
      m('WITHDRAWAL', 50),
    ];
    expect(view(movements)).toEqual({
      untied: '300.00',
      byCycle: { c3: '1000.00' },
    });
    const pots = potsOf(movements);
    // The pots add up to the balance, exactly.
    expect(potsTotal(pots).toFixed(2)).toBe(balanceOf(movements).toFixed(2));
    expect(availableTo(pots, 'c1').toFixed(2)).toBe('300.00');
    expect(availableTo(pots, 'c3').toFixed(2)).toBe('1300.00');
  });

  it('a draw beyond the cycle’s pot and untied money is refused, naming money held for other cycles', () => {
    const pots = potsOf([m('ADVANCE', 50_775, 'c2')]);
    let err: HttpException | undefined;
    try {
      assertCycleCovers({
        pots,
        cycleId: 'c1',
        cycleCode: 'CYC-2026-0001',
        amount: D(16_925),
        partner: 'Abdallah',
      });
    } catch (e) {
      err = e as HttpException;
    }
    expect(err?.getResponse()).toEqual(
      expect.objectContaining({
        code: 'ACCOUNT_MONEY_FOR_OTHER_CYCLE',
        params: expect.objectContaining({
          available: '0.00',
          elsewhere: '50,775.00',
          short: '16,925.00',
        }) as unknown,
      }),
    );
    expect(() =>
      assertCycleCovers({
        pots,
        cycleId: 'c2',
        cycleCode: 'CYC-2026-0002',
        amount: D(50_775),
        partner: 'Abdallah',
      }),
    ).not.toThrow();
  });

  it('untied money below zero (cross-cycle draws from before the rule) offers nothing, and hides no cycle’s pot', () => {
    const pots = potsOf([
      m('ADVANCE', 1_000, 'c2'),
      m('ADVANCE', 400, 'c1'),
      m('CONTRIBUTION', 900, 'c1'),
    ]);
    expect(pots.untied.toFixed(2)).toBe('-500.00');
    expect(availableTo(pots, 'c1').toFixed(2)).toBe('0.00');
    expect(availableTo(pots, 'c2').toFixed(2)).toBe('1000.00');
  });
});

describe('the Funding card: into capital, equal shares, covered or short (owner 2026-10-26)', () => {
  const m = (
    kind: string,
    amountEgp: number,
    cycleId: string | null = null,
  ) => ({
    kind,
    amountEgp,
    cycleId,
    reversedAt: null,
  });

  it('into capital is what his contributions to a cycle drew from that cycle’s own advances — never more than he paid there', () => {
    const pots = potsOf([
      m('ADVANCE', 50_775, 'c2'),
      m('CONTRIBUTION', 40_000, 'c2'),
      m('ADVANCE', 1_000, 'c1'),
      m('PAYOUT_LEFT_IN', 5_000),
      // 3,000 into c1 with 1,000 advanced there: 1,000 from it, 2,000 untied.
      m('CONTRIBUTION', 3_000, 'c1'),
      m('ADVANCE', 700, 'c3'),
    ]);
    expect(pots.intoCapital.get('c2')?.toFixed(2)).toBe('40000.00');
    expect(pots.intoCapital.get('c1')?.toFixed(2)).toBe('1000.00');
    // Paid but nothing contributed yet: nothing into capital.
    expect(pots.intoCapital.has('c3')).toBe(false);
  });

  it('from untied is what a cycle drew beyond its own advances — the rest of into capital, and it adds up to the pots', () => {
    const pots = potsOf([
      m('ADVANCE', 50_775, 'c2'),
      m('ADVANCE', 5_225, 'c2'),
      m('ADVANCE', 10_000), // tied to no cycle (production's Aug 15)
      m('CONTRIBUTION', 65_862.26, 'c2'),
      m('ADVANCE', 1_000, 'c1'),
      m('CONTRIBUTION', 400, 'c1'),
    ]);
    expect(pots.fromUntied.get('c2')?.toFixed(2)).toBe('9862.26');
    expect(pots.intoCapital.get('c2')?.toFixed(2)).toBe('56000.00');
    // c1 drew less than it advanced: nothing from untied, 600 still its own.
    expect(pots.fromUntied.has('c1')).toBe(false);
    expect(pots.byCycle.get('c1')?.toFixed(2)).toBe('600.00');
    expect(pots.untied.toFixed(2)).toBe('137.74');
  });

  it('isUntiedMovement follows the pots: only an advance or a contribution with a cycle is tied', () => {
    expect(isUntiedMovement({ kind: 'ADVANCE', cycleId: 'c1' })).toBe(false);
    expect(isUntiedMovement({ kind: 'CONTRIBUTION', cycleId: 'c1' })).toBe(
      false,
    );
    expect(isUntiedMovement({ kind: 'ADVANCE', cycleId: null })).toBe(true);
    // A payout left in names the cycle it came from, and is still untied.
    expect(isUntiedMovement({ kind: 'PAYOUT_LEFT_IN', cycleId: 'c1' })).toBe(
      true,
    );
    expect(isUntiedMovement({ kind: 'EXPENSE_PAID' })).toBe(true);
    expect(isUntiedMovement({ kind: 'WITHDRAWAL' })).toBe(true);
  });

  it('production’s cycle 2: a target of 120,000 gives 40,000 each — Abdallah covered with 10,775 over, Shady 30,000 short, Fares 40,000 short', () => {
    const r = contributionShares({
      targetEgp: '120000.00',
      toFundEgp: '95000.00',
      investorsEgp: 0,
      partners: [
        { availableEgp: 50_775, contributionEgp: 0 },
        { availableEgp: 10_000, contributionEgp: 0 },
        { availableEgp: 0, contributionEgp: 0 },
      ],
    });
    expect(r.basis).toBe('TARGET');
    expect(r.lines.map((l) => l.share.toFixed(2))).toEqual([
      '40000.00',
      '40000.00',
      '40000.00',
    ]);
    expect(r.lines.map((l) => l.cover.toFixed(2))).toEqual([
      '10775.00',
      '-30000.00',
      '-40000.00',
    ]);
  });

  it('no target, or one below the cost to fund: shares of the cost to fund, the odd piastre to the last partner', () => {
    const none = contributionShares({
      targetEgp: null,
      toFundEgp: '1000.00',
      investorsEgp: 0,
      partners: [0, 0, 0].map(() => ({ availableEgp: 0, contributionEgp: 0 })),
    });
    expect(none.basis).toBe('COST_TO_FUND');
    expect(none.lines.map((l) => l.share.toFixed(2))).toEqual([
      '333.33',
      '333.33',
      '333.34',
    ]);
    const lower = contributionShares({
      targetEgp: '500.00',
      toFundEgp: '1000.00',
      investorsEgp: 0,
      partners: [{ availableEgp: 0, contributionEgp: 0 }],
    });
    expect(lower.basis).toBe('COST_TO_FUND');
    expect(lower.lines[0].share.toFixed(2)).toBe('1000.00');
  });

  it('an investor’s money comes off first; what a partner already put in counts against his share; more than his share asks nothing', () => {
    const r = contributionShares({
      targetEgp: '120000.00',
      toFundEgp: 0,
      investorsEgp: '30000.00',
      partners: [
        { availableEgp: 0, contributionEgp: '30000.00' },
        { availableEgp: 0, contributionEgp: '50000.00' },
        { availableEgp: 100, contributionEgp: 0 },
      ],
    });
    expect(r.partnersEgp.toFixed(2)).toBe('90000.00');
    expect(r.lines.map((l) => l.stillToGive.toFixed(2))).toEqual([
      '0.00',
      '0.00',
      '30000.00',
    ]);
    expect(r.lines.map((l) => l.cover.toFixed(2))).toEqual([
      '0.00',
      '0.00',
      '-29900.00',
    ]);
  });

  it('nothing to fund: every share is zero, never a rounding residual on the last partner (CLAUDE.md §10)', () => {
    const r = contributionShares({
      targetEgp: null,
      toFundEgp: 0,
      investorsEgp: '500.00',
      partners: [0, 0, 0].map(() => ({ availableEgp: 0, contributionEgp: 0 })),
    });
    expect(r.lines.every((l) => l.share.eq(0))).toBe(true);
  });
});

describe('the Funding card on a cycle a friend paid (owner 2026-10-26)', () => {
  const three = (contributionEgp: Prisma.Decimal.Value) =>
    [0, 0, 0].map(() => ({ availableEgp: 0, contributionEgp }));

  it('production’s cycle 1: thirds of what was repaid him (201,168.99), not of the cost to fund — 67,056.33 each, covered, nothing left over', () => {
    const r = contributionShares({
      targetEgp: null,
      toFundEgp: '193382.28',
      repaidEgp: '201168.99',
      investorsEgp: 0,
      partners: three('67056.33'),
    });
    expect(r.basis).toBe('REPAID');
    expect(r.ofEgp.toFixed(2)).toBe('201168.99');
    expect(r.lines.map((l) => l.share.toFixed(2))).toEqual([
      '67056.33',
      '67056.33',
      '67056.33',
    ]);
    expect(r.lines.map((l) => l.cover.toFixed(2))).toEqual([
      '0.00',
      '0.00',
      '0.00',
    ]);
  });

  it('before any repayment: thirds of the cost to fund, as before', () => {
    const r = contributionShares({
      targetEgp: null,
      toFundEgp: '193382.28',
      repaidEgp: 0,
      investorsEgp: 0,
      partners: three(0),
    });
    expect(r.basis).toBe('COST_TO_FUND');
    expect(r.lines.map((l) => l.share.toFixed(2))).toEqual([
      '64460.76',
      '64460.76',
      '64460.76',
    ]);
  });

  it('investors’ money still comes off first, and a target not below the repaid figure still wins', () => {
    const r = contributionShares({
      targetEgp: null,
      toFundEgp: '900.00',
      repaidEgp: '1200.00',
      investorsEgp: '300.00',
      partners: three(0),
    });
    expect(r.partnersEgp.toFixed(2)).toBe('900.00');
    const t = contributionShares({
      targetEgp: '1500.00',
      toFundEgp: '900.00',
      repaidEgp: '1200.00',
      investorsEgp: 0,
      partners: three(0),
    });
    expect(t.basis).toBe('TARGET');
  });
});

describe('the partners’ part and each share, once investors are in (owner 2026-10-27)', () => {
  /**
   * CYC-2026-0001 as corrected: Ahmad Eraiby repaid 141,168.92 in pounds;
   * 60,000 of his loan stayed in as his investment, Mohammed Setta put in
   * 20,000 (into repaying him), and the partners agreed 55,000 / 33,084.50 /
   * 33,084.49 — 201,168.99 in all.
   */
  const cycleOne = (contributions = ['55000.00', '33084.50', '33084.49']) => ({
    targetEgp: null,
    toFundEgp: '193382.28',
    repaidEgp: '141168.92',
    investorsEgp: '80000.00',
    partners: contributions.map((c) => ({
      availableEgp: 0,
      contributionEgp: c,
    })),
  });

  it('production’s cycle 1: the partners’ part is 121,168.99 — what they put in — not 61,168.92; each share as agreed, all covered', () => {
    const r = contributionShares(cycleOne());
    expect(r.basis).toBe('PUT_IN');
    expect(r.ofEgp.toFixed(2)).toBe('201168.99');
    expect(r.partnersEgp.toFixed(2)).toBe('121168.99');
    expect(r.agreed).toBe(true);
    expect(r.lines.map((l) => l.share.toFixed(2))).toEqual([
      '55000.00',
      '33084.50',
      '33084.49',
    ]);
    expect(
      r.lines.map((l) => [l.stillToGive.toFixed(2), l.cover.toFixed(2)]),
    ).toEqual([0, 1, 2].map(() => ['0.00', '0.00']));
  });

  it('the second visit: the old equal thirds of 2026-10-26, then the corrected funding — both as agreed, never one over and two short', () => {
    const before = contributionShares({
      targetEgp: null,
      toFundEgp: '193382.28',
      repaidEgp: '201168.99',
      investorsEgp: 0,
      partners: [0, 1, 2].map(() => ({
        availableEgp: 0,
        contributionEgp: '67056.33',
      })),
    });
    expect([before.basis, before.agreed]).toEqual(['REPAID', true]);
    const after = contributionShares(cycleOne());
    expect([after.basis, after.agreed]).toEqual(['PUT_IN', true]);
    // Fares later lowered by 1,000: still everything put in, still as agreed.
    const edited = contributionShares(
      cycleOne(['55000.00', '33084.50', '32084.49']),
    );
    expect(edited.partnersEgp.toFixed(2)).toBe('120168.99');
    expect(edited.lines.map((l) => l.share.toFixed(2))).toEqual([
      '55000.00',
      '33084.50',
      '32084.49',
    ]);
  });

  it('a partner missing his contribution: equal shares stay the suggestion, and he reads short', () => {
    const r = contributionShares(cycleOne(['55000.00', '33084.50', '0']));
    // 168,084.50 put in, more than repaid: the partners' part is theirs, 88,084.50.
    expect(r.partnersEgp.toFixed(2)).toBe('88084.50');
    expect(r.agreed).toBe(false);
    expect(r.lines.map((l) => l.share.toFixed(2))).toEqual([
      '29361.50',
      '29361.50',
      '29361.50',
    ]);
    expect(r.lines.map((l) => l.cover.toFixed(2))).toEqual([
      '0.00',
      '0.00',
      '-29361.50',
    ]);
  });

  it('investors only, the partners not entered yet: the repaid figure stays the floor (GUESS — whose investment repaid him is not recorded)', () => {
    const r = contributionShares(cycleOne(['0', '0', '0']));
    expect(r.basis).toBe('REPAID');
    expect(r.partnersEgp.toFixed(2)).toBe('61168.92');
    expect(r.agreed).toBe(false);
  });

  it('contributions that do not make up the partners’ part: equal shares, the short partner named', () => {
    // Cost to fund 1,000; 300 each entered — 900, not 1,000.
    const r = contributionShares({
      targetEgp: null,
      toFundEgp: '1000.00',
      investorsEgp: 0,
      partners: [0, 1, 2].map(() => ({
        availableEgp: 0,
        contributionEgp: '300.00',
      })),
    });
    expect(r.agreed).toBe(false);
    expect(r.lines.map((l) => l.share.toFixed(2))).toEqual([
      '333.33',
      '333.33',
      '333.34',
    ]);
    expect(r.lines.map((l) => l.stillToGive.toFixed(2))).toEqual([
      '33.33',
      '33.33',
      '33.34',
    ]);
    // Off by one piastre is off: to the piastre or not at all.
    const near = contributionShares({
      targetEgp: null,
      toFundEgp: '1000.00',
      investorsEgp: 0,
      partners: ['300.00', '300.00', '399.99'].map((c) => ({
        availableEgp: 0,
        contributionEgp: c,
      })),
    });
    expect(near.agreed).toBe(false);
    // More than the cost: not agreed either, and nobody is asked for more.
    const over = contributionShares({
      targetEgp: null,
      toFundEgp: '1000.00',
      investorsEgp: 0,
      partners: [0, 1, 2].map(() => ({
        availableEgp: 0,
        contributionEgp: '500.00',
      })),
    });
    expect(over.agreed).toBe(false);
    expect(over.lines.every((l) => l.stillToGive.eq(0))).toBe(true);
  });

  it('a repaid friend and contributions short of it: of what was repaid, equal shares, each short his part', () => {
    const r = contributionShares({
      targetEgp: null,
      toFundEgp: '900.00',
      repaidEgp: '1200.00',
      investorsEgp: 0,
      partners: [0, 1, 2].map(() => ({
        availableEgp: 0,
        contributionEgp: '300.00',
      })),
    });
    expect([r.basis, r.agreed]).toEqual(['REPAID', false]);
    expect(r.lines.map((l) => l.cover.toFixed(2))).toEqual([
      '-100.00',
      '-100.00',
      '-100.00',
    ]);
  });

  it('30 / 30 / 40 of the cost to fund, as entered: as agreed on any basis, not equal thirds', () => {
    const r = contributionShares({
      targetEgp: null,
      toFundEgp: '1000.00',
      investorsEgp: 0,
      partners: ['300.00', '300.00', '400.00'].map((c) => ({
        availableEgp: 0,
        contributionEgp: c,
      })),
    });
    expect([r.basis, r.agreed]).toEqual(['COST_TO_FUND', true]);
    expect(r.lines.map((l) => l.share.toFixed(2))).toEqual([
      '300.00',
      '300.00',
      '400.00',
    ]);
  });

  it('the target basis is unaffected: it still wins when not below what was put in, and the shares are its thirds', () => {
    const r = contributionShares({ ...cycleOne(), targetEgp: '250000.00' });
    expect(r.basis).toBe('TARGET');
    expect(r.partnersEgp.toFixed(2)).toBe('170000.00');
    expect(r.agreed).toBe(false);
    expect(r.lines.map((l) => l.share.toFixed(2))).toEqual([
      '56666.66',
      '56666.66',
      '56666.68',
    ]);
    // A target below everything put in gives way, as it gives way to the cost.
    expect(
      contributionShares({ ...cycleOne(), targetEgp: '150000.00' }).basis,
    ).toBe('PUT_IN');
  });

  it('nothing contributed and nothing to fund: zero shares, never agreed', () => {
    const r = contributionShares({
      targetEgp: null,
      toFundEgp: 0,
      investorsEgp: 0,
      partners: [0, 1, 2].map(() => ({ availableEgp: 0, contributionEgp: 0 })),
    });
    expect(r.agreed).toBe(false);
    expect(r.lines.every((l) => l.share.eq(0))).toBe(true);
    // Investors' money alone covering the whole cost: nothing for the partners, nothing agreed.
    const covered = contributionShares({
      targetEgp: null,
      toFundEgp: '1000.00',
      investorsEgp: '1000.00',
      partners: [0, 1].map(() => ({ availableEgp: 0, contributionEgp: 0 })),
    });
    expect([covered.partnersEgp.toFixed(2), covered.agreed]).toEqual([
      '0.00',
      false,
    ]);
  });
});

describe('put in so far — contribution + undrawn advances, never counting a drawn advance twice', () => {
  it('a contribution entered directly (repaying a friend) is all of it', () => {
    const r = putInSoFar({
      contributionEgp: '67056.33',
      fromAccountEgp: 0,
      undrawnAdvancesEgp: 0,
    });
    expect(
      [r.totalEgp, r.enteredEgp, r.fromAccountEgp].map((v) => v.toFixed(2)),
    ).toEqual(['67056.33', '67056.33', '0.00']);
  });

  it('50,775 advanced, 10,000 of it drawn into a contribution: 50,775 put in, not 60,775', () => {
    // The pot after the draw: 40,775 undrawn; the contribution holds the 10,000.
    const pots = potsOf([
      { kind: 'ADVANCE', amountEgp: 50775, cycleId: 'c2' },
      { kind: 'CONTRIBUTION', amountEgp: 10000, cycleId: 'c2' },
    ]);
    const r = putInSoFar({
      contributionEgp: 10000,
      fromAccountEgp: 10000,
      undrawnAdvancesEgp: pots.byCycle.get('c2')!,
    });
    expect(r.totalEgp.toFixed(2)).toBe('50775.00');
    expect(r.enteredEgp.toFixed(2)).toBe('0.00');
    expect(r.undrawnAdvancesEgp.toFixed(2)).toBe('40775.00');
  });

  it('a contribution lowered by hand below what the account gave never makes a part negative', () => {
    const r = putInSoFar({
      contributionEgp: 500,
      fromAccountEgp: 800,
      undrawnAdvancesEgp: 0,
    });
    expect([r.enteredEgp, r.fromAccountEgp].map((v) => v.toFixed(2))).toEqual([
      '0.00',
      '500.00',
    ]);
    expect(r.totalEgp.toFixed(2)).toBe('500.00');
  });
});

describe('each partner’s part of the exchange difference: the profit split’s', () => {
  const core = (id: string, contribution: Prisma.Decimal.Value) => ({
    id,
    type: 'CORE_PARTNER' as const,
    contribution: D(contribution),
    customProfitPct: null,
    investorFeePct: null,
  });

  it('equal contributions: thirds, re-summing to the whole', () => {
    const parts = profitShareOf(
      [core('a', '67056.33'), core('b', '67056.33'), core('c', '67056.33')],
      D('7788.12'),
    )!;
    expect(parts.map((v) => v.toFixed(2))).toEqual([
      '2596.04',
      '2596.04',
      '2596.04',
    ]);
  });

  it('a gain splits as a gain (negative), by contribution when unequal', () => {
    const parts = profitShareOf(
      [core('a', 300), core('b', 700)],
      D('-1000.00'),
    )!;
    expect(parts.map((v) => v.toFixed(2))).toEqual(['-300.00', '-700.00']);
  });

  it('nothing contributed: no basis, so no split (CLAUDE.md §10)', () => {
    expect(profitShareOf([core('a', 0), core('b', 0)], D('900'))).toBeNull();
  });
});

describe('a funding target in its own currency', () => {
  it('counts an advance in the target currency at face value, any other at its pounds over the target rate', () => {
    const target = { currency: 'USD', rate: 50 };
    expect(
      inTargetCurrency(
        { currency: 'USD', amount: 400, amountEgp: 20400 },
        target,
      ).toFixed(2),
    ).toBe('400.00');
    expect(
      inTargetCurrency(
        { currency: 'EGP', amount: 10000, amountEgp: 10000 },
        target,
      ).toFixed(2),
    ).toBe('200.00');
  });
});

describe('who may call the account endpoints (CLAUDE.md §12)', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const ctx = (cls: object, handler: () => unknown, role: string) =>
    ({
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;

  /** The method as Nest registers it, read off the prototype without calling it. */
  const handlerOf = (cls: { prototype: object }, k: string) =>
    Object.getOwnPropertyDescriptor(cls.prototype, k)!.value as () => unknown;
  const endpoints: [object, () => unknown][] = [
    ...(['list', 'advance', 'withdraw', 'reverse'] as const).map(
      (k) =>
        [
          PartnerAccountsController,
          handlerOf(PartnerAccountsController, k),
        ] as [object, () => unknown],
    ),
    ...(['funding', 'partnerMoney', 'target', 'contribute'] as const).map(
      (k) =>
        [
          CycleAccountFundingController,
          handlerOf(CycleAccountFundingController, k),
        ] as [object, () => unknown],
    ),
  ];

  it('every endpoint names its roles: core partners only', () => {
    for (const [cls, handler] of endpoints) {
      expect(
        reflector.getAllAndOverride(ROLES_KEY, [handler, cls as never]),
      ).toEqual(['CORE_PARTNER']);
    }
  });

  it.each(['TEMP_INVESTOR', 'ADMIN_SUPPORT', 'SHOP_OWNER_PORTAL'])(
    'refuses %s with a coded refusal',
    (role) => {
      for (const [cls, handler] of endpoints) {
        let code: unknown;
        try {
          guard.canActivate(ctx(cls, handler, role));
        } catch (e) {
          code = ((e as HttpException).getResponse() as { code: string }).code;
        }
        expect(code).toBe('ROLE_NOT_ALLOWED');
      }
    },
  );

  it('lets a core partner through', () => {
    for (const [cls, handler] of endpoints) {
      expect(guard.canActivate(ctx(cls, handler, 'CORE_PARTNER'))).toBe(true);
    }
  });
});

describe('equal shares for everyone, investors included (owner 2026-11-20)', () => {
  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

  it('an agreed split is equal when every one is within a hundredth of 100 ÷ n and they make 100', () => {
    expect(agreedSplitIsEqual(['25', '25', '25', '25'].map(D))).toBe(true);
    expect(agreedSplitIsEqual(['33.33', '33.33', '33.34'].map(D))).toBe(true);
    expect(agreedSplitIsEqual(['50', '50'].map(D))).toBe(true);
    expect(agreedSplitIsEqual(['30', '30', '20', '20'].map(D))).toBe(false);
    expect(agreedSplitIsEqual(['33.32', '33.32', '33.36'].map(D))).toBe(false);
    // Partial, off 100, a single participant, nobody, no split at all.
    expect(agreedSplitIsEqual([D(25), D(25), D(25), null])).toBe(false);
    expect(agreedSplitIsEqual(['25', '25', '25', '24.99'].map(D))).toBe(false);
    expect(agreedSplitIsEqual([D(100)])).toBe(false);
    expect(agreedSplitIsEqual([])).toBe(false);
    expect(agreedSplitIsEqual([null, null, null])).toBe(false);
  });

  it('CYC-2026-0002: quarters of 256,786.78 sum to it exactly, the last (Youssef) taking the odd piastre; the differences cancel', () => {
    const gap = equalShareGap({
      ofEgp: '256786.78',
      participants: [
        { contributionEgp: '65862.26' },
        { contributionEgp: '65862.26' },
        { contributionEgp: '65862.26' },
        { contributionEgp: '59200' },
      ],
    })!;
    expect(gap.lines.map((l) => l.share.toFixed(2))).toEqual([
      '64196.69',
      '64196.69',
      '64196.69',
      '64196.71',
    ]);
    expect(gap.lines.map((l) => l.difference.toFixed(2))).toEqual([
      '1665.57',
      '1665.57',
      '1665.57',
      '-4996.71',
    ]);
    expect(gap.lines.reduce((s, l) => s.add(l.share), D(0)).toFixed(2)).toBe(
      '256786.78',
    );
    expect(
      gap.lines.reduce((s, l) => s.add(l.difference), D(0)).toFixed(2),
    ).toBe('0.00');
  });

  it('a cost added after a friend paid is in the shares: of the cost to fund when it is more', () => {
    // CYC-2026-0002 (owner 2026-11-20): put in 256,786.78 (three partners at
    // 65,862.26 and Youssef 59,200); leg 2's freight then doubled to 8,000 AED
    // at 14.8, so the cost to fund is 315,986.78 and 59,200 is still unpaid.
    const people = [65862.26, 65862.26, 65862.26, 59200].map((c) => ({
      contributionEgp: c,
    }));
    const gap = equalShareGap({
      ofEgp: '256786.78',
      costToFundEgp: '315986.78',
      participants: people,
    })!;
    expect(gap.ofEgp.toFixed(2)).toBe('315986.78');
    expect(gap.lines.map((l) => l.share.toFixed(2))).toEqual([
      '78996.69',
      '78996.69',
      '78996.69',
      '78996.71',
    ]);
    expect(gap.lines.map((l) => l.difference.toFixed(2))).toEqual([
      '-13134.43',
      '-13134.43',
      '-13134.43',
      '-19796.71',
    ]);
    // Everyone short, by exactly what is still to pay.
    expect(
      gap.lines
        .reduce((s, l) => s.add(l.difference), new Prisma.Decimal(0))
        .toFixed(2),
    ).toBe('-59200.00');
    // The card's own figure stands when it is the larger.
    expect(
      equalShareGap({
        ofEgp: 300,
        costToFundEgp: 200,
        participants: people.slice(0, 2),
      })!.ofEgp.toFixed(2),
    ).toBe('300.00');
  });

  it('nothing to share, or one person, is no gap; a negative contribution counts as nothing put in', () => {
    const two = [{ contributionEgp: 10 }, { contributionEgp: 10 }];
    expect(equalShareGap({ ofEgp: 0, participants: two })).toBeNull();
    expect(equalShareGap({ ofEgp: -5, participants: two })).toBeNull();
    expect(
      equalShareGap({ ofEgp: 100, participants: [{ contributionEgp: 100 }] }),
    ).toBeNull();
    const gap = equalShareGap({
      ofEgp: 100,
      participants: [{ contributionEgp: -20 }, { contributionEgp: 120 }],
    })!;
    expect(gap.lines.map((l) => l.difference.toFixed(2))).toEqual([
      '-50.00',
      '70.00',
    ]);
  });
});

/**
 * Who pays whom to make it equal (§8, owner 2026-11-27: "beside showing short
 * we should show also, pay for who to be equal"). Display only.
 */
describe('equalShareSettleUp — who pays whom, to the piastre', () => {
  type Line = ReturnType<typeof equalShareSettleUp>[number];
  const view = (lines: Line[]) =>
    lines.map((l) => [l.from, l.kind, l.to, l.amount.toFixed(2)]);
  const sum = (lines: Line[], pred: (l: Line) => boolean) =>
    lines
      .filter(pred)
      .reduce((s, l) => s.add(l.amount), D(0))
      .toFixed(2);
  /** Every invariant the plan promises, for any input. */
  const holds = (differences: string[], lines: Line[]) => {
    const short = differences.map((d) => (D(d).lt(0) ? D(d).neg() : D(0)));
    const over = differences.map((d) => (D(d).gt(0) ? D(d) : D(0)));
    const S = short.reduce((s, x) => s.add(x), D(0)).toFixed(2);
    const O = over.reduce((s, x) => s.add(x), D(0)).toFixed(2);
    expect(sum(lines, (l) => l.kind !== 'TAKE_BACK')).toBe(S);
    expect(
      sum(lines, (l) => l.kind === 'PARTICIPANT' || l.kind === 'TAKE_BACK'),
    ).toBe(O);
    for (const l of lines) {
      expect(l.amount.gt(0)).toBe(true);
      expect(l.amount.decimalPlaces()).toBeLessThanOrEqual(2);
    }
    differences.forEach((_, i) => {
      // Nobody pays more than he is short, nor receives more than he is over.
      expect(
        D(sum(lines, (l) => l.from === i && l.kind !== 'TAKE_BACK')).lte(
          short[i],
        ),
      ).toBe(true);
      expect(
        D(
          sum(
            lines,
            (l) =>
              (l.kind === 'PARTICIPANT' && l.to === i) ||
              (l.kind === 'TAKE_BACK' && l.from === i),
          ),
        ).equals(over[i]),
      ).toBe(true);
      // Nobody both pays and is paid.
      const pays = lines.some((l) => l.from === i && l.kind !== 'TAKE_BACK');
      const paid = lines.some(
        (l) => l.to === i || (l.kind === 'TAKE_BACK' && l.from === i),
      );
      expect(pays && paid).toBe(false);
    });
  };

  it('production CYC-2026-0002: everyone short by the 3,000 AED still to pay at 15.2 — every line is toward the freight, nobody pays a person', () => {
    const differences = ['-13509.43', '-13509.43', '-13509.43', '-5071.71'];
    const lines = equalShareSettleUp({
      differences,
      unpaidFreightEgp: '45600.00',
    });
    expect(view(lines)).toEqual([
      [0, 'FREIGHT', null, '13509.43'],
      [1, 'FREIGHT', null, '13509.43'],
      [2, 'FREIGHT', null, '13509.43'],
      [3, 'FREIGHT', null, '5071.71'],
    ]);
    expect(sum(lines, () => true)).toBe('45600.00');
    holds(differences, lines);
  });

  it('2026-11-20: nothing unpaid — Youssef pays each partner his 1,665.57, in the cycle’s order', () => {
    const differences = ['1665.57', '1665.57', '1665.57', '-4996.71'];
    const lines = equalShareSettleUp({ differences, unpaidFreightEgp: 0 });
    expect(view(lines)).toEqual([
      [3, 'PARTICIPANT', 0, '1665.57'],
      [3, 'PARTICIPANT', 1, '1665.57'],
      [3, 'PARTICIPANT', 2, '1665.57'],
    ]);
    holds(differences, lines);
  });

  it('mixed: some over, some short, and freight still to pay — the short pay toward the freight in proportion to their shortfalls, the rest to the one over', () => {
    // Shares of 100,000; A over 10,000; B, C, D short 5,000 / 20,000 / 15,000.
    // 30,000 nobody has put in is exactly the freight still to pay.
    const differences = ['10000', '-5000', '-20000', '-15000'];
    const lines = equalShareSettleUp({ differences, unpaidFreightEgp: 30000 });
    expect(view(lines)).toEqual([
      [1, 'FREIGHT', null, '3750.00'],
      [2, 'FREIGHT', null, '15000.00'],
      [3, 'FREIGHT', null, '11250.00'],
      [2, 'PARTICIPANT', 0, '5000.00'],
      [3, 'PARTICIPANT', 0, '3750.00'],
      [1, 'PARTICIPANT', 0, '1250.00'],
    ]);
    expect(sum(lines, (l) => l.kind === 'PARTICIPANT')).toBe('10000.00');
    holds(differences, lines);
  });

  it('more unpaid freight than nobody has put in: only the uncovered part goes toward it — the cycle already holds the rest', () => {
    // 30,000 not put in, 50,000 still to pay: contributions already hold 20,000 of it.
    const differences = ['10000', '-5000', '-20000', '-15000'];
    const lines = equalShareSettleUp({ differences, unpaidFreightEgp: 50000 });
    expect(sum(lines, (l) => l.kind === 'FREIGHT')).toBe('30000.00');
    expect(sum(lines, (l) => l.kind === 'PARTICIPANT')).toBe('10000.00');
    holds(differences, lines);
  });

  it('less unpaid freight than nobody has put in: the rest is put into the cycle, not paid to anyone', () => {
    const differences = ['10000', '-5000', '-20000', '-15000'];
    const lines = equalShareSettleUp({ differences, unpaidFreightEgp: 12000 });
    expect(sum(lines, (l) => l.kind === 'FREIGHT')).toBe('12000.00');
    expect(sum(lines, (l) => l.kind === 'COST')).toBe('18000.00');
    expect(sum(lines, (l) => l.kind === 'PARTICIPANT')).toBe('10000.00');
    holds(differences, lines);
  });

  it('more put in than the shares: the over who have nobody to pay them take it back', () => {
    const differences = ['300', '200', '-100'];
    const lines = equalShareSettleUp({ differences, unpaidFreightEgp: 500 });
    expect(view(lines)).toEqual([
      [2, 'PARTICIPANT', 0, '100.00'],
      [0, 'TAKE_BACK', null, '200.00'],
      [1, 'TAKE_BACK', null, '200.00'],
    ]);
    holds(differences, lines);
  });

  it('odd piastres: two piastres of freight over three one-piastre shortfalls — the first two pay it, the third puts his into the cycle; never more than he is short', () => {
    const differences = ['-0.01', '-0.01', '-0.01'];
    const lines = equalShareSettleUp({ differences, unpaidFreightEgp: '0.02' });
    expect(view(lines)).toEqual([
      [0, 'FREIGHT', null, '0.01'],
      [1, 'FREIGHT', null, '0.01'],
      [2, 'COST', null, '0.01'],
    ]);
    holds(differences, lines);
  });

  it('everyone even, or an empty cycle, is nothing to pay; a negative "unpaid" counts as none', () => {
    expect(
      equalShareSettleUp({ differences: ['0', '0'], unpaidFreightEgp: 100 }),
    ).toEqual([]);
    expect(equalShareSettleUp({ differences: [] })).toEqual([]);
    const differences = ['50', '-50'];
    expect(
      view(equalShareSettleUp({ differences, unpaidFreightEgp: -40 })),
    ).toEqual([[1, 'PARTICIPANT', 0, '50.00']]);
  });

  it('the sums hold for any mix of shortfalls, overs and freight (a thousand seeded cases)', () => {
    let seed = 7;
    const rand = () =>
      (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 1000; n++) {
      const people = 2 + Math.floor(rand() * 5);
      const differences = Array.from({ length: people }, () =>
        D(Math.floor((rand() - 0.6) * 2000000))
          .div(100)
          .toFixed(2),
      );
      const unpaid = D(Math.floor(rand() * 1500000)).div(100);
      holds(
        differences,
        equalShareSettleUp({ differences, unpaidFreightEgp: unpaid }),
      );
    }
  });
});
