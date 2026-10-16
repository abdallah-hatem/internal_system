/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- the fake database's rows are untyped records, as Prisma's argument objects are */
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PaymentsService } from '../payments/payments.service';
import { PaymentPlansService } from './payment-plans.service';
import { SaleContractController } from './sale-contract.controller';
import { PaymentPlansController } from './payment-plans.controller';
import { CreateSaleContractPlanDto } from './dto/payment-plan.dto';
import { SalesService } from '../sales/sales.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { businessToday } from '../../common/dates';

/**
 * A sale's instalment contract (BUSINESS_LOGIC §7, 2026-10-16): the Contract
 * button agrees a plan for exactly what is outstanding on one sale, linked to
 * it, under every rule an ordinary plan already has — and the contract is read
 * back from the sale and that plan.
 */

const D = (v: number | string) => new Prisma.Decimal(v);

/** A calendar day `n` days from Cairo's today, YYYY-MM-DD. */
function day(n: number) {
  const d = new Date(`${businessToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const SALE = '11111111-1111-4111-8111-111111111111';
const OTHER_SALE = '22222222-2222-4222-8222-222222222222';
const SHOP = '33333333-3333-4333-8333-333333333333';

interface World {
  sales: any[];
  customers: any[];
  plans: any[];
}

function world(): World {
  return {
    customers: [
      {
        id: SHOP,
        displayName: 'Al Nour Motors',
        phone: '01125550198',
        verificationStatus: 'VERIFIED',
        isWalkIn: false,
      },
    ],
    sales: [
      {
        id: SALE,
        orderNo: 'ORD-2026-00001',
        customerId: SHOP,
        status: 'PARTIALLY_PAID',
        currency: 'EGP',
        total: D('35200.00'),
        outstanding: D('25200.00'),
        items: [
          {
            id: 'line-1',
            quantity: D('10'),
            unitPrice: D('1250'),
            discount: D('0'),
            lineTotal: D('12500'),
            product: {
              name: 'Q58 Max Intercom',
              nameAr: 'إنتركم Q58',
              sku: 'Q58',
            },
          },
          {
            id: 'line-2',
            quantity: D('15'),
            unitPrice: D('980'),
            discount: D('0'),
            lineTotal: D('14700'),
            product: { name: 'Y20 Headset', nameAr: null, sku: 'Y20' },
          },
        ],
      },
    ],
    plans: [],
  };
}

function fakePrisma(w: World) {
  const customerOf = (id: string) => w.customers.find((c) => c.id === id);
  const planOfSale = (id: string) =>
    w.plans.find((p) => p.saleOrderId === id) ?? null;
  const withRelations = (p: any) => ({
    ...p,
    customer: customerOf(p.customerId),
    saleOrder: p.saleOrderId
      ? {
          id: p.saleOrderId,
          orderNo: w.sales.find((s) => s.id === p.saleOrderId)?.orderNo,
        }
      : null,
  });

  const db: any = {
    saleOrder: {
      findUnique: jest.fn(({ where }: any) => {
        const s = w.sales.find((x) => x.id === where.id);
        if (!s) return Promise.resolve(null);
        return Promise.resolve({
          ...s,
          customer: customerOf(s.customerId),
          paymentPlan: planOfSale(s.id),
          paymentAllocations: [],
        });
      }),
      aggregate: jest.fn(({ where }: any) => {
        const sum = w.sales
          .filter(
            (s) =>
              s.customerId === where.customerId &&
              where.status.in.includes(s.status),
          )
          .reduce((t, s) => t.add(s.outstanding), D(0));
        return Promise.resolve({ _sum: { outstanding: sum } });
      }),
    },
    paymentPlan: {
      findFirst: jest.fn(({ where }: any) => {
        if (where.reference?.startsWith) {
          const refs = w.plans
            .map((p) => p.reference)
            .filter((r: string) => r.startsWith(where.reference.startsWith))
            .sort();
          return Promise.resolve(
            refs.length ? { reference: refs[refs.length - 1] } : null,
          );
        }
        return Promise.resolve(
          w.plans.find(
            (p) =>
              p.customerId === where.customerId && p.status === where.status,
          ) ?? null,
        );
      }),
      create: jest.fn(({ data }: any) => {
        const plan = {
          id: `plan-${w.plans.length + 1}`,
          status: 'ACTIVE',
          ...data,
          instalments: data.instalments.create.map((i: any, idx: number) => ({
            id: `inst-${w.plans.length + 1}-${idx + 1}`,
            ...i,
          })),
        };
        w.plans.push(plan);
        return Promise.resolve(withRelations(plan));
      }),
      update: jest.fn(({ where, data }: any) => {
        const plan = w.plans.find((p) => p.id === where.id);
        Object.assign(plan, data);
        return Promise.resolve(withRelations(plan));
      }),
    },
  };
  db.$transaction = jest.fn((fn: any) => fn(db));
  return db;
}

function setup(w = world()) {
  const prisma = fakePrisma(w);
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new PaymentPlansService(
    prisma,
    audit as unknown as AuditService,
    {} as NotificationsService,
  );
  return { w, prisma, audit, service };
}

const three = (amounts = ['8400.00', '8400.00', '8400.00']) =>
  amounts.map((amount, i) => ({
    dueOn: day(30 * (i + 1)),
    amount: Number(amount),
  }));

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as HttpException;
    const body = err.getResponse() as {
      code: string;
      params?: Record<string, unknown>;
    };
    return { status: err.getStatus(), code: body.code, params: body.params };
  }
  throw new Error('expected a refusal');
}

describe('POST /sales/orders/:id/contract-plan — the plan is agreed for the sale', () => {
  it('creates a plan linked to the sale, with its instalments in date order', async () => {
    const { w, service, audit } = setup();
    const res = await service.createForSale(
      SALE,
      { instalments: [three()[2], three()[0], three()[1]] },
      'user-1',
    );

    expect(w.plans).toHaveLength(1);
    const plan = w.plans[0];
    expect(plan.saleOrderId).toBe(SALE);
    expect(plan.customerId).toBe(SHOP);
    expect(plan.totalEgp.toFixed(2)).toBe('25200.00');
    expect(
      plan.instalments.map((i: any) => [i.sequence, i.amount.toFixed(2)]),
    ).toEqual([
      [1, '8400.00'],
      [2, '8400.00'],
      [3, '8400.00'],
    ]);
    expect(
      plan.instalments.map((i: any) => i.dueOn.toISOString().slice(0, 10)),
    ).toEqual([day(30), day(60), day(90)]);
    expect(res.data.saleOrder).toEqual({ id: SALE, orderNo: 'ORD-2026-00001' });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        afterJson: expect.objectContaining({ saleOrderId: SALE }),
      }),
    );
  });

  it('unequal amounts are fine as long as they add up to what is outstanding', async () => {
    const { w, service } = setup();
    await service.createForSale(SALE, {
      instalments: three(['10000', '10000', '5200']),
    });
    expect(w.plans[0].totalEgp.toFixed(2)).toBe('25200.00');
  });

  it('a first instalment due today is allowed — the payment taken at signing', async () => {
    const { w, service } = setup();
    await service.createForSale(SALE, {
      instalments: [
        { dueOn: day(0), amount: 5200 },
        { dueOn: day(30), amount: 20000 },
      ],
    });
    expect(w.plans).toHaveLength(1);
  });
});

describe('a sale contract plan is refused, with a code', () => {
  it('a sale that does not exist, or an id that cannot be one → NOT_FOUND, never a 500', async () => {
    const { service } = setup();
    expect(
      await refusal(
        service.createForSale(OTHER_SALE, { instalments: three() }),
      ),
    ).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      params: { entity: 'saleOrder' },
    });
    expect(
      await refusal(service.createForSale('abc', { instalments: three() })),
    ).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it.each(['DRAFT', 'PAID', 'CANCELLED', 'RETURNED'])(
    'a %s sale → SALE_CONTRACT_NOT_OPEN',
    async (status) => {
      const w = world();
      w.sales[0].status = status;
      const { service } = setup(w);
      expect(
        await refusal(service.createForSale(SALE, { instalments: three() })),
      ).toMatchObject({
        status: 400,
        code: 'SALE_CONTRACT_NOT_OPEN',
        params: { order: 'ORD-2026-00001', status },
      });
    },
  );

  it('a sale in another currency → SALE_CONTRACT_NOT_EGP', async () => {
    const w = world();
    w.sales[0].currency = 'USD';
    const { service } = setup(w);
    expect(
      await refusal(service.createForSale(SALE, { instalments: three() })),
    ).toMatchObject({
      code: 'SALE_CONTRACT_NOT_EGP',
      params: { currency: 'USD' },
    });
  });

  it('nothing outstanding → SALE_CONTRACT_NOTHING_OWED', async () => {
    const w = world();
    w.sales[0].status = 'CONFIRMED';
    w.sales[0].outstanding = D('0');
    const { service } = setup(w);
    expect(
      await refusal(service.createForSale(SALE, { instalments: three() })),
    ).toMatchObject({
      code: 'SALE_CONTRACT_NOTHING_OWED',
    });
  });

  it('a walk-in sale → SALE_CONTRACT_NOTHING_OWED: there is no account to owe on', async () => {
    const w = world();
    w.customers[0].isWalkIn = true;
    const { service } = setup(w);
    expect(
      await refusal(service.createForSale(SALE, { instalments: three() })),
    ).toMatchObject({
      code: 'SALE_CONTRACT_NOTHING_OWED',
    });
  });

  it('instalments adding up to less than what is outstanding → CONTRACT_SUM_MISMATCH', async () => {
    const { w, service } = setup();
    expect(
      await refusal(
        service.createForSale(SALE, {
          instalments: three(['8400', '8400', '8399.99']),
        }),
      ),
    ).toMatchObject({
      code: 'CONTRACT_SUM_MISMATCH',
      params: {
        total: '25,199.99',
        owed: '25,200.00',
        order: 'ORD-2026-00001',
      },
    });
    expect(w.plans).toHaveLength(0);
  });

  it('instalments adding up to more than what is outstanding → CONTRACT_SUM_MISMATCH', async () => {
    const { service } = setup();
    expect(
      await refusal(
        service.createForSale(SALE, {
          instalments: three(['9000', '9000', '9000']),
        }),
      ),
    ).toMatchObject({ code: 'CONTRACT_SUM_MISMATCH' });
  });

  it('an instalment due yesterday → INSTALMENT_DUE_IN_PAST', async () => {
    const { w, service } = setup();
    expect(
      await refusal(
        service.createForSale(SALE, {
          instalments: [
            { dueOn: day(-1), amount: 12600 },
            { dueOn: day(30), amount: 12600 },
          ],
        }),
      ),
    ).toMatchObject({
      code: 'INSTALMENT_DUE_IN_PAST',
      params: { day: day(-1) },
    });
    expect(w.plans).toHaveLength(0);
  });

  it('the second time — the sale already has its plan → SALE_HAS_PLAN, and no second plan', async () => {
    const { w, service } = setup();
    await service.createForSale(SALE, { instalments: three() });
    expect(
      await refusal(service.createForSale(SALE, { instalments: three() })),
    ).toMatchObject({
      code: 'SALE_HAS_PLAN',
      params: { order: 'ORD-2026-00001', reference: w.plans[0].reference },
    });
    expect(w.plans).toHaveLength(1);
  });

  it('the shop has another active plan → CUSTOMER_HAS_ACTIVE_PLAN', async () => {
    const w = world();
    w.plans.push({
      id: 'older',
      reference: 'PLAN-2026-0007',
      customerId: SHOP,
      status: 'ACTIVE',
      saleOrderId: null,
      instalments: [],
    });
    const { service } = setup(w);
    expect(
      await refusal(service.createForSale(SALE, { instalments: three() })),
    ).toMatchObject({
      code: 'CUSTOMER_HAS_ACTIVE_PLAN',
      params: { reference: 'PLAN-2026-0007' },
    });
  });

  it('an unverified shop → CUSTOMER_NOT_VERIFIED, as for any plan', async () => {
    const w = world();
    w.customers[0].verificationStatus = 'UNVERIFIED';
    const { service } = setup(w);
    expect(
      await refusal(service.createForSale(SALE, { instalments: three() })),
    ).toMatchObject({
      code: 'CUSTOMER_NOT_VERIFIED',
    });
  });

  it('a cancelled plan lets go of the sale: a new contract plan is agreed and the old one unlinked', async () => {
    const { w, service } = setup();
    await service.createForSale(SALE, { instalments: three() });
    w.plans[0].status = 'CANCELLED';

    await service.createForSale(SALE, {
      instalments: three(['12600', '12600']),
    });
    expect(w.plans).toHaveLength(2);
    expect(w.plans[0].saleOrderId).toBeNull();
    expect(w.plans[1].saleOrderId).toBe(SALE);
    expect(w.plans[1].reference).not.toBe(w.plans[0].reference);
  });

  it('no instalments, or more than 36, is refused by the body rules', async () => {
    const none = await validate(
      plainToInstance(CreateSaleContractPlanDto, { instalments: [] }),
    );
    expect(none).not.toHaveLength(0);
    const many = await validate(
      plainToInstance(CreateSaleContractPlanDto, {
        instalments: Array.from({ length: 37 }, (_, i) => ({
          dueOn: day(i + 1),
          amount: 1,
        })),
      }),
    );
    expect(many.map((e) => e.property)).toContain('instalments');
    const zero = await validate(
      plainToInstance(CreateSaleContractPlanDto, {
        instalments: [{ dueOn: day(1), amount: 0 }],
      }),
    );
    expect(zero).not.toHaveLength(0);
    const ok = await validate(
      plainToInstance(CreateSaleContractPlanDto, { instalments: three() }),
    );
    expect(ok).toHaveLength(0);
  });
});

describe('GET /sales/orders/:id/contract — built live from the sale and its plan', () => {
  it('the shop, the goods, the totals at signing and the schedule', async () => {
    const { service } = setup();
    await service.createForSale(SALE, { instalments: three() });
    const { data } = await service.saleContract(SALE);

    expect(data.number).toBe('CT-ORD-2026-00001');
    expect(data.customer).toMatchObject({
      displayName: 'Al Nour Motors',
      phone: '01125550198',
    });
    expect(
      data.lines.map((l) => [
        l.product,
        l.productAr,
        l.quantity,
        l.unitPrice,
        l.lineTotal,
      ]),
    ).toEqual([
      ['Q58 Max Intercom', 'إنتركم Q58', '10', '1250.00', '12500.00'],
      ['Y20 Headset', null, '15', '980.00', '14700.00'],
    ]);
    expect([data.total, data.paidAtSigning, data.remaining]).toEqual([
      '35200.00',
      '10000.00',
      '25200.00',
    ]);
    expect(
      data.plan.instalments.map((i) => [i.sequence, i.dueOn, i.amount]),
    ).toEqual([
      [1, day(30), '8400.00'],
      [2, day(60), '8400.00'],
      [3, day(90), '8400.00'],
    ]);
  });

  it('what was signed does not move as the shop pays: the totals come from the plan, not the live balance', async () => {
    const { w, service } = setup();
    await service.createForSale(SALE, { instalments: three() });
    w.sales[0].outstanding = D('16800.00'); // an instalment came in
    const { data } = await service.saleContract(SALE);
    expect([data.paidAtSigning, data.remaining]).toEqual([
      '10000.00',
      '25200.00',
    ]);
  });

  it('a sale with no plan, or only a cancelled one → SALE_HAS_NO_PLAN', async () => {
    const { w, service } = setup();
    expect(await refusal(service.saleContract(SALE))).toMatchObject({
      status: 400,
      code: 'SALE_HAS_NO_PLAN',
    });
    await service.createForSale(SALE, { instalments: three() });
    w.plans[0].status = 'CANCELLED';
    expect(await refusal(service.saleContract(SALE))).toMatchObject({
      code: 'SALE_HAS_NO_PLAN',
    });
    expect(await refusal(service.saleContract('nope'))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('GET /sales/orders/:id says whether the sale has its plan', () => {
  function sales(w: World) {
    return new SalesService(
      fakePrisma(w),
      { log: jest.fn() } as unknown as AuditService,
      {} as PaymentsService,
      {} as NotificationsService,
    );
  }

  it('no plan → contractPlan null', async () => {
    const { data } = await sales(world()).findById(SALE);
    expect(data.contractPlan).toBeNull();
    expect(data).not.toHaveProperty('paymentPlan');
  });

  it('an active plan → contractPlan names it; a cancelled one → null', async () => {
    const w = world();
    await setup(w).service.createForSale(SALE, { instalments: three() });
    expect((await sales(w).findById(SALE)).data.contractPlan).toMatchObject({
      id: w.plans[0].id,
      reference: w.plans[0].reference,
      status: 'ACTIVE',
    });
    w.plans[0].status = 'CANCELLED';
    expect((await sales(w).findById(SALE)).data.contractPlan).toBeNull();
  });
});

describe('who may agree a sale contract plan, and who may read the contract', () => {
  const guard = new RolesGuard(new Reflector());
  function outcome(cls: any, handler: string, role: string) {
    const context = {
      getHandler: () => cls.prototype[handler],
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext;
    try {
      guard.canActivate(context);
      return 'allowed';
    } catch (e) {
      const err = e as HttpException;
      return `${err.getStatus()} ${(err.getResponse() as { code: string }).code}`;
    }
  }

  it('agreeing the plan: a core partner only — the same roles as POST /payment-plans', () => {
    expect(outcome(SaleContractController, 'createPlan', 'CORE_PARTNER')).toBe(
      'allowed',
    );
    for (const role of [
      'ADMIN_SUPPORT',
      'TEMP_INVESTOR',
      'SHOP_OWNER_PORTAL',
    ]) {
      expect(outcome(SaleContractController, 'createPlan', role)).toBe(
        '403 ROLE_NOT_ALLOWED',
      );
    }
    for (const role of ['CORE_PARTNER', 'ADMIN_SUPPORT', 'TEMP_INVESTOR']) {
      expect(outcome(SaleContractController, 'createPlan', role)).toBe(
        outcome(PaymentPlansController, 'create', role),
      );
    }
  });

  it('reading the contract: the sales roles; an investor or a shop is refused', () => {
    expect(outcome(SaleContractController, 'contract', 'CORE_PARTNER')).toBe(
      'allowed',
    );
    expect(outcome(SaleContractController, 'contract', 'ADMIN_SUPPORT')).toBe(
      'allowed',
    );
    expect(outcome(SaleContractController, 'contract', 'TEMP_INVESTOR')).toBe(
      '403 ROLE_NOT_ALLOWED',
    );
    expect(
      outcome(SaleContractController, 'contract', 'SHOP_OWNER_PORTAL'),
    ).toBe('403 ROLE_NOT_ALLOWED');
  });
});
