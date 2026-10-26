// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access
import { Prisma } from '@prisma/client';
import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ROLES_KEY, RolesGuard } from './guards/roles.guard';
import {
  assertCovers,
  balanceOf,
  equalShares,
  inTargetCurrency,
} from './partner-account';
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
