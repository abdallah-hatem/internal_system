import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RolesGuard } from '../../common/guards/roles.guard';
import { PAYMENT_ROLES } from '../payments/payment-roles';
import { SalesController } from './sales.controller';
import type { SalesService } from './sales.service';
import { CONFIRM_AND_PAY_ROLES, SALES_ROLES } from './sales-roles';

/**
 * Confirm & paid (BUSINESS_LOGIC §4, owner 2026-10-27): who may call it, and
 * the controller's own refusal. Everything that writes is in
 * `confirm-and-pay.db.spec.ts`, against a real Postgres.
 */

function refusalOf(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    const err = e as HttpException;
    return {
      status: err.getStatus(),
      code: (err.getResponse() as { code: string }).code,
    };
  }
  return 'allowed';
}

describe('who may confirm and pay in one step', () => {
  function contextFor(role: string): ExecutionContext {
    return {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- the guard reads metadata off the handler; it never calls it
      getHandler: () => SalesController.prototype.confirmAndPay,
      getClass: () => SalesController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext;
  }
  const guard = new RolesGuard(new Reflector());
  const as = (role: string) =>
    refusalOf(() => guard.canActivate(contextFor(role)));

  it('an investor or a shop → refused with a code', () => {
    expect(as('TEMP_INVESTOR')).toEqual({
      status: 403,
      code: 'ROLE_NOT_ALLOWED',
    });
    expect(as('SHOP_OWNER_PORTAL')).toEqual({
      status: 403,
      code: 'ROLE_NOT_ALLOWED',
    });
  });

  it('a core partner and admin support — who may both confirm and record a payment — are let through', () => {
    expect(as('CORE_PARTNER')).toBe('allowed');
    expect(as('ADMIN_SUPPORT')).toBe('allowed');
  });

  it('the roles are exactly those allowed both to sell and to receive money', () => {
    const both = SALES_ROLES.filter((r) =>
      (PAYMENT_ROLES as readonly string[]).includes(r),
    );
    expect([...CONFIRM_AND_PAY_ROLES].sort()).toEqual([...both].sort());
    // Not left to the guard's default, which allows anyone (rule 12).
    expect(CONFIRM_AND_PAY_ROLES.length).toBeGreaterThan(0);
  });
});

describe('POST /sales/orders/:id/confirm-and-pay — the body', () => {
  const service = {
    confirmAndPay: jest.fn(() => Promise.resolve({ data: {} })),
  };
  const controller = new SalesController(
    service as unknown as SalesService,
    {} as never,
    {} as never,
  );
  beforeEach(() => service.confirmAndPay.mockClear());

  it('no body, or no version → VERSION_REQUIRED, and the service is never reached', () => {
    expect(
      refusalOf(() =>
        controller.confirmAndPay('o-1', undefined, { id: 'u-1' }),
      ),
    ).toEqual({ status: 400, code: 'VERSION_REQUIRED' });
    expect(
      refusalOf(() => controller.confirmAndPay('o-1', {}, { id: 'u-1' })),
    ).toEqual({ status: 400, code: 'VERSION_REQUIRED' });
    expect(service.confirmAndPay).not.toHaveBeenCalled();
  });

  it('the version and the payment method are handed on as sent', async () => {
    await controller.confirmAndPay(
      'o-1',
      { version: 3, payment: { method: 'CHEQUE' } },
      { id: 'u-1' },
    );
    expect(service.confirmAndPay).toHaveBeenCalledWith('o-1', 'u-1', 3, {
      method: 'CHEQUE',
    });
  });
});
