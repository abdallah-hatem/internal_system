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
  equalShares,
  inTargetCurrency,
  potsOf,
  potsTotal,
  putInSoFar,
} from './partner-account';
import { profitShareOf } from '../modules/settlements/settlement-math';
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
    ...(['funding', 'target', 'contribute'] as const).map(
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
