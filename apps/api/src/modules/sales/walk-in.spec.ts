import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { PaymentsService } from '../payments/payments.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CustomersService } from '../customers/customers.service';
import { ReturnsService } from '../returns/returns.service';
import { SalesController } from './sales.controller';
import { SalesService, type CreateSaleOrderInput } from './sales.service';

/**
 * Walk-in sales, the refusals that need no database (plan W1,
 * BUSINESS_LOGIC §4 DECIDED 2026-10-11).
 *
 * Everything that writes — one transaction, the race, the payment, the
 * return — is in `walk-in.db.spec.ts`, against a real Postgres.
 */

const WALK_IN_ID = '7a1c0de0-0000-4000-8000-0000000000aa';
const PISTON = '22222222-2222-4222-8222-222222222222';

/** A client that fails the test if anything at all reads or writes. */
const untouchable = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`the database was touched (${String(prop)})`);
    },
  },
) as unknown as PrismaService;

const audit = {
  log: jest.fn(() => Promise.resolve()),
} as unknown as AuditService;

function sales(prisma: PrismaService = untouchable) {
  return new SalesService(prisma, audit, {} as PaymentsService, {
    createForMultipleUsers: () => Promise.resolve({ count: 0 }),
  });
}

const line = { productId: PISTON, quantity: 2, unitPrice: 450 };
const walkIn = (extra: Partial<CreateSaleOrderInput> = {}) =>
  ({
    walkIn: true,
    currency: 'EGP',
    items: [line],
    ...extra,
  }) as CreateSaleOrderInput;

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    const body = e.getResponse() as { code: string };
    return { status: e.getStatus(), code: body.code };
  }
  throw new Error('expected a refusal, got success');
}

describe('walk-in sale — refusals before anything is written', () => {
  it('walkIn + customerId → VALIDATION_FAILED', async () => {
    expect(
      await refusal(sales().create(walkIn({ customerId: PISTON }), 'actor')),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('walkIn with confirm:false → WALK_IN_NOT_DRAFT', async () => {
    expect(
      await refusal(sales().create(walkIn({ confirm: false }), 'actor')),
    ).toEqual({ status: 400, code: 'WALK_IN_NOT_DRAFT' });
  });

  it('a payment method nobody offers → VALIDATION_FAILED', async () => {
    expect(
      await refusal(
        sales().create(walkIn({ payment: { method: 'IOU' } }), 'actor'),
      ),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('a walk-in sale at B2B prices → VALIDATION_FAILED (a walk-in is always B2C)', async () => {
    expect(
      await refusal(sales().create(walkIn({ channel: 'B2B' }), 'actor')),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('a payment on an ordinary sale → VALIDATION_FAILED, not silently dropped', async () => {
    expect(
      await refusal(
        sales().create(
          {
            customerId: PISTON,
            channel: 'B2B',
            currency: 'EGP',
            items: [line],
            payment: { method: 'CASH' },
          },
          'actor',
        ),
      ),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('walkIn that is not a boolean → VALIDATION_FAILED', async () => {
    expect(
      await refusal(
        sales().create(
          walkIn({ walkIn: 'yes' as unknown as boolean }),
          'actor',
        ),
      ),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
  });
});

describe('the walk-in record is reserved', () => {
  const walkInRow = {
    id: WALK_IN_ID,
    displayName: 'Walk-in',
    type: 'B2C',
    verificationStatus: 'VERIFIED',
    isWalkIn: true,
  };

  function customers() {
    const update = jest.fn();
    const findMany = jest.fn(() => Promise.resolve([]));
    const prisma = {
      customer: {
        findUnique: jest.fn(() => Promise.resolve(walkInRow)),
        update,
        findMany,
      },
      saleOrder: { groupBy: jest.fn(() => Promise.resolve([])) },
    } as unknown as PrismaService;
    return { service: new CustomersService(prisma, audit), update, findMany };
  }

  it('Editing the walk-in customer → WALK_IN_RESERVED, and nothing is written', async () => {
    const { service, update } = customers();
    expect(
      await refusal(service.update(WALK_IN_ID, { displayName: 'Ahmed' }, 'a')),
    ).toEqual({ status: 400, code: 'WALK_IN_RESERVED' });
    expect(update).not.toHaveBeenCalled();
  });

  it('Verifying (or otherwise changing) the walk-in customer → WALK_IN_RESERVED', async () => {
    const { service, update } = customers();
    expect(await refusal(service.verify(WALK_IN_ID, 'a'))).toEqual({
      status: 400,
      code: 'WALK_IN_RESERVED',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('The customers list (every picker reads it) asks for real customers only', async () => {
    const { service, findMany } = customers();
    await service.findAll({ search: 'walk' });
    await service.findAll({ verification: 'ALL' });
    for (const [args] of findMany.mock.calls as unknown as [
      { where: { isWalkIn?: boolean } },
    ][]) {
      expect(args.where.isWalkIn).toBe(false);
    }
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('An ordinary sale naming the walk-in record by id → WALK_IN_RESERVED (it would leave the walk-in owing)', async () => {
    const prisma = {
      customer: { findUnique: jest.fn(() => Promise.resolve(walkInRow)) },
    } as unknown as PrismaService;
    for (const confirm of [false, true]) {
      const outcome = await refusal(
        new SalesService(
          {
            ...prisma,
            $transaction: (fn: (tx: unknown) => unknown) => fn(prisma),
          } as unknown as PrismaService,
          audit,
          {} as PaymentsService,
          { createForMultipleUsers: () => Promise.resolve({ count: 0 }) },
        ).create(
          {
            customerId: WALK_IN_ID,
            channel: 'B2C',
            currency: 'EGP',
            items: [line],
            confirm,
          },
          'actor',
        ),
      );
      expect(outcome).toEqual({ status: 400, code: 'WALK_IN_RESERVED' });
    }
  });

  it('Return on a walk-in order asking for credit → WALK_IN_REFUND_IN_MONEY', async () => {
    const prisma = {
      saleOrder: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'o1',
            orderNo: 'ORD-2026-00001',
            status: 'PAID',
            outstanding: 0,
            currency: 'EGP',
            customer: { isWalkIn: true },
            items: [],
          }),
        ),
      },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const returns = new ReturnsService(prisma, audit);
    expect(
      await refusal(
        returns.create(
          {
            saleOrderId: 'o1',
            reason: 'wrong size',
            refundMethod: 'CREDIT_NOTE',
            items: [],
          },
          'actor',
        ),
      ),
    ).toEqual({ status: 400, code: 'WALK_IN_REFUND_IN_MONEY' });
  });
});

describe('who may make a walk-in sale', () => {
  function contextFor(role: string): ExecutionContext {
    return {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- the guard reads metadata off the handler; it never calls it
      getHandler: () => SalesController.prototype.create,
      getClass: () => SalesController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext;
  }
  const guard = new RolesGuard(new Reflector());

  function guardRefusal(role: string) {
    try {
      guard.canActivate(contextFor(role));
    } catch (e) {
      const err = e as HttpException;
      return {
        status: err.getStatus(),
        code: (err.getResponse() as { code: string }).code,
      };
    }
    return 'allowed';
  }

  it('Investor or shop → refused with a code', () => {
    expect(guardRefusal('TEMP_INVESTOR')).toEqual({
      status: 403,
      code: 'ROLE_NOT_ALLOWED',
    });
    expect(guardRefusal('SHOP_OWNER_PORTAL')).toEqual({
      status: 403,
      code: 'ROLE_NOT_ALLOWED',
    });
  });

  it('a core partner and admin support are let through', () => {
    expect(guardRefusal('CORE_PARTNER')).toBe('allowed');
    expect(guardRefusal('ADMIN_SUPPORT')).toBe('allowed');
  });
});
