import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UsersController } from './users.controller';
import type { UsersService } from './users.service';
import {
  INVESTOR_NAME_MAX,
  investorName,
  madeUpInvestorEmail,
  madeUpInvestorPassword,
} from './new-investor';

/**
 * A temporary investor from the Funding card's `+` (BUSINESS_LOGIC §8,
 * owner 2026-10-26): `POST /users/investors`, a name alone. It must never be
 * a way to make a partner (CLAUDE.md §12) — the role is not the caller's to
 * choose — and only a core partner may call it.
 */

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpException) {
      return {
        status: e.getStatus(),
        body: e.getResponse() as { code: string; params?: unknown },
      };
    }
    throw e;
  }
  throw new Error('expected a refusal');
};

describe('an investor’s name', () => {
  it('is trimmed, its inner spaces made one', () => {
    expect(investorName('  Mohammed   Setta  ')).toBe('Mohammed Setta');
    expect(investorName('محمد ستة')).toBe('محمد ستة');
  });

  it.each([[''], ['   '], [undefined], [null], [42], [{ name: 'x' }]])(
    'empty or not text (%p) is refused INVESTOR_NAME_REQUIRED',
    (raw) => {
      expect(refusal(() => investorName(raw))).toMatchObject({
        status: 400,
        body: { code: 'INVESTOR_NAME_REQUIRED' },
      });
    },
  );

  it(`${INVESTOR_NAME_MAX} characters go; one more is refused INVESTOR_NAME_TOO_LONG, naming the limit`, () => {
    expect(investorName('a'.repeat(INVESTOR_NAME_MAX))).toHaveLength(
      INVESTOR_NAME_MAX,
    );
    expect(
      refusal(() => investorName('a'.repeat(INVESTOR_NAME_MAX + 1))),
    ).toMatchObject({
      status: 400,
      body: {
        code: 'INVESTOR_NAME_TOO_LONG',
        params: { max: INVESTOR_NAME_MAX },
      },
    });
  });

  it('spaces do not count towards the limit; what is stored does', () => {
    expect(investorName(`  ${'a'.repeat(INVESTOR_NAME_MAX)}  `)).toHaveLength(
      INVESTOR_NAME_MAX,
    );
  });
});

describe('the made-up sign-in', () => {
  it('an address under .invalid — reserved, never delivered — and a new one each time', () => {
    const a = madeUpInvestorEmail();
    const b = madeUpInvestorEmail();
    expect(a).toMatch(/^investor-[0-9a-f-]{36}@investors\.invalid$/);
    expect(a).not.toBe(b);
  });

  it('a long random password, never the same twice', () => {
    const a = madeUpInvestorPassword();
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).not.toBe(madeUpInvestorPassword());
  });
});

describe('POST /users/investors — the caller does not choose the role', () => {
  const make = () => {
    const service = {
      createInvestor: jest.fn(() => Promise.resolve({ data: {} })),
      create: jest.fn(),
    };
    return {
      service,
      controller: new UsersController(service as unknown as UsersService),
    };
  };

  it('a body asking for CORE_PARTNER, an email and a password passes on the name alone', async () => {
    const { service, controller } = make();
    await controller.createInvestor({
      displayName: 'Mohammed Setta',
      role: 'CORE_PARTNER',
      email: 'me@motoparts.com',
      password: 'Partner123!',
    } as unknown as { displayName: string });
    expect(service.createInvestor).toHaveBeenCalledWith('Mohammed Setta');
    expect(service.create).not.toHaveBeenCalled();
  });

  it('no body at all reaches the name check as nothing, not a crash', async () => {
    const { service, controller } = make();
    await controller.createInvestor(undefined as unknown as object);
    expect(service.createInvestor).toHaveBeenCalledWith(undefined);
  });
});

describe('POST /users/investors — who may call it (rule 12)', () => {
  const guard = new RolesGuard(new Reflector());
  const h = Object.getOwnPropertyDescriptor(
    UsersController.prototype,
    'createInvestor',
  )!.value as object;
  const as = (role: string | undefined) =>
    ({
      getHandler: () => h,
      getClass: () => UsersController,
      switchToHttp: () => ({
        getRequest: () => ({ user: role ? { role } : undefined }),
      }),
    }) as unknown as ExecutionContext;

  it.each([
    'TEMP_INVESTOR',
    'ADMIN_SUPPORT',
    'SHOP_OWNER_PORTAL',
    'SOMETHING_NEW',
    undefined,
  ])('%s is refused 403 ROLE_NOT_ALLOWED', (role) => {
    expect(refusal(() => guard.canActivate(as(role)))).toMatchObject({
      status: 403,
      body: { code: 'ROLE_NOT_ALLOWED' },
    });
  });

  it('a core partner is let through', () => {
    expect(guard.canActivate(as('CORE_PARTNER'))).toBe(true);
  });

  it('the guard is on the controller, not only the roles declared', () => {
    const guards = Reflect.getMetadata('__guards__', UsersController) as
      unknown[] | undefined;
    expect(guards).toContain(RolesGuard);
  });
});
