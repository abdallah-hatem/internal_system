/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- an in-memory stand-in for Prisma answers loosely-shaped query objects */
// The fake store holds real Decimals, as the services expect.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { Prisma } from '@prisma/client';
import type { HttpException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { businessToday } from '../../common/dates';
import { PaymentPlansService } from '../payment-plans/payment-plans.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * A payment put on a chosen order (BUSINESS_LOGIC §7, DECIDED 2026-10-10).
 *
 * The fake database keeps every table in memory and gives `$transaction` real
 * rollback — it snapshots the store and restores it if the callback throws —
 * so "nothing saved" means something here: without the transaction the
 * payment row would survive a refused allocation, and these tests would see it.
 */

const D = (v: number | string) => new Prisma.Decimal(v);

const SHOP = '11111111-1111-4111-8111-111111111111';
const OTHER_SHOP = '22222222-2222-4222-8222-222222222222';
const NOBODY = '99999999-9999-4999-8999-999999999999';

interface Store {
  customers: any[];
  orders: any[];
  payments: any[];
  allocations: any[];
  ledger: any[];
  plans: any[];
}

let seq = 0;
const id = (prefix: string) => `${prefix}-${++seq}`;

function order(over: Record<string, unknown>) {
  return {
    id: id('order'),
    orderNo: `ORD-2026-${String(seq).padStart(5, '0')}`,
    customerId: SHOP,
    status: 'CONFIRMED',
    total: D(800),
    outstanding: D(800),
    createdAt: new Date(2026, 0, 1),
    version: 1,
    ...over,
    ...(over.outstanding !== undefined
      ? { outstanding: D(over.outstanding as number) }
      : {}),
  };
}

function seed(orders: any[] = []): Store {
  return {
    customers: [
      { id: SHOP, displayName: 'Nile Motors', verificationStatus: 'VERIFIED' },
      {
        id: OTHER_SHOP,
        displayName: 'Delta Parts',
        verificationStatus: 'VERIFIED',
      },
    ],
    orders,
    payments: [],
    allocations: [],
    ledger: [],
    plans: [],
  };
}

function clone(store: Store): Store {
  return Object.fromEntries(
    Object.entries(store).map(([k, rows]) => [
      k,
      (rows as any[]).map((r) => ({ ...r })),
    ]),
  ) as unknown as Store;
}

function fakePrisma(initial: Store) {
  const db = { store: initial };

  const client: any = {
    customer: {
      findUnique: async ({ where }: any) =>
        db.store.customers.find((c) => c.id === where.id) ?? null,
    },
    saleOrder: {
      aggregate: async ({ where }: any) => {
        const rows = db.store.orders.filter(
          (o) =>
            o.customerId === where.customerId &&
            where.status.in.includes(o.status),
        );
        return {
          _sum: {
            outstanding: rows.length
              ? rows.reduce((t, o) => t.add(o.outstanding), D(0))
              : null,
          },
        };
      },
      findUnique: async ({ where }: any) => {
        const o = db.store.orders.find((x) => x.id === where.id);
        return o ? { ...o } : null;
      },
      update: async ({ where, data }: any) => {
        const o = db.store.orders.find((x) => x.id === where.id);
        o.outstanding = D(data.outstanding);
        o.status = data.status;
        o.version += data.version?.increment ?? 0;
        return { ...o };
      },
    },
    payment: {
      findFirst: async ({ where }: any) =>
        db.store.payments.find((p) => p.reference === where.reference) ?? null,
      findUnique: async ({ where }: any) =>
        db.store.payments.find((p) => p.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const row = { id: id('payment'), ...data, amount: D(data.amount) };
        db.store.payments.push(row);
        return { ...row };
      },
      aggregate: async ({ where }: any) => {
        const rows = db.store.payments.filter(
          (p) =>
            p.customerId === where.customerId &&
            p.status === where.status &&
            p.receivedOn >= where.receivedOn.gte,
        );
        return {
          _sum: { amount: rows.reduce((t, p) => t.add(p.amount), D(0)) },
        };
      },
    },
    paymentAllocation: {
      aggregate: async ({ where }: any) => {
        const rows = db.store.allocations.filter(
          (a) => a.paymentId === where.paymentId,
        );
        return {
          _sum: {
            amount: rows.length
              ? rows.reduce((t, a) => t.add(a.amount), D(0))
              : null,
          },
        };
      },
      create: async ({ data }: any) => {
        const row = { id: id('alloc'), ...data, amount: D(data.amount) };
        db.store.allocations.push(row);
        return { ...row };
      },
    },
    financialTransaction: {
      create: async ({ data }: any) => {
        const row = { id: id('ledger'), ...data };
        db.store.ledger.push(row);
        return row;
      },
    },
    paymentPlan: {
      findUnique: async ({ where }: any) =>
        db.store.plans.find((p) => p.id === where.id) ?? null,
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const before = clone(db.store);
      try {
        return await fn(client);
      } catch (e) {
        db.store = before;
        throw e;
      }
    },
  };
  return { client, db };
}

function build(orders: any[] = []) {
  const { client, db } = fakePrisma(seed(orders));
  const audit = { log: jest.fn(async () => undefined) };
  const service = new PaymentsService(
    client as PrismaService,
    audit as unknown as AuditService,
  );
  return { service, client, db, audit };
}

function refusalOf(e: unknown): { status: number; code: string; params?: any } {
  const err = e as HttpException;
  const body = err.getResponse() as { code: string; params?: any };
  return { status: err.getStatus(), code: body.code, params: body.params };
}

async function refused(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return refusalOf(e);
  }
  throw new Error('expected a refusal, and the request went through');
}

const pay = (
  amount: number,
  orderId?: string,
  extra: Record<string, unknown> = {},
) => ({
  customerId: SHOP,
  amount,
  currency: 'EGP',
  method: 'CASH',
  ...(orderId ? { orderId } : {}),
  ...extra,
});

const nothingSaved = (db: { store: Store }) => {
  expect(db.store.payments).toHaveLength(0);
  expect(db.store.allocations).toHaveLength(0);
  expect(db.store.ledger).toHaveLength(0);
};

describe('POST /payments with an orderId', () => {
  it('Pay 500 on an order owing 800 → allocated to that order only, even when an older order is unpaid', async () => {
    const older = order({ createdAt: new Date(2025, 0, 1), outstanding: 300 });
    const chosen = order({ createdAt: new Date(2026, 5, 1), outstanding: 800 });
    const { service, db } = build([older, chosen]);

    const res: any = await service.create(pay(500, chosen.id), 'actor-1');

    expect(db.store.payments).toHaveLength(1);
    expect(db.store.allocations).toEqual([
      expect.objectContaining({
        paymentId: res.data.id,
        saleOrderId: chosen.id,
      }),
    ]);
    expect(Number(db.store.allocations[0].amount)).toBe(500);
    const after = (o: any) => db.store.orders.find((x) => x.id === o.id);
    expect(Number(after(chosen).outstanding)).toBe(300);
    expect(after(chosen).status).toBe('PARTIALLY_PAID');
    expect(Number(after(older).outstanding)).toBe(300);
    expect(after(older).status).toBe('CONFIRMED');
    // The money arrived once: one ledger inflow.
    expect(db.store.ledger).toHaveLength(1);
  });

  it('paying exactly what the order owes marks it paid', async () => {
    const chosen = order({ outstanding: 800 });
    const { service, db } = build([chosen]);
    await service.create(pay(800, chosen.id), 'actor-1');
    expect(db.store.orders[0].status).toBe('PAID');
    expect(Number(db.store.orders[0].outstanding)).toBe(0);
  });

  it('Pay 900 on an order owing 800 → PAYMENT_EXCEEDS_ORDER, nothing saved', async () => {
    // The shop owes 1,100 in all, so the shop-wide cap would let 900 through:
    // only the order's own cap stops it.
    const older = order({ outstanding: 300 });
    const chosen = order({ outstanding: 800 });
    const { service, db } = build([older, chosen]);

    const r = await refused(service.create(pay(900, chosen.id), 'actor-1'));

    expect(r.status).toBe(400);
    expect(r.code).toBe('PAYMENT_EXCEEDS_ORDER');
    expect(r.params).toEqual(
      expect.objectContaining({ owed: '800.00', asked: '900.00' }),
    );
    nothingSaved(db);
    expect(Number(db.store.orders[1].outstanding)).toBe(800);
  });

  it("Pay on another customer's order → refused (404), nothing saved", async () => {
    const theirs = order({ customerId: OTHER_SHOP, outstanding: 800 });
    const mine = order({ outstanding: 800 });
    const { service, db } = build([theirs, mine]);

    const r = await refused(service.create(pay(100, theirs.id), 'actor-1'));

    expect(r).toEqual(
      expect.objectContaining({ status: 404, code: 'NOT_FOUND' }),
    );
    nothingSaved(db);
    expect(Number(db.store.orders[0].outstanding)).toBe(800);
  });

  it('an order id that does not exist → 404, not 500', async () => {
    const { service, db } = build([order({ outstanding: 800 })]);
    const r = await refused(service.create(pay(100, NOBODY), 'actor-1'));
    expect(r).toEqual(
      expect.objectContaining({ status: 404, code: 'NOT_FOUND' }),
    );
    nothingSaved(db);
  });

  it('Pay on a draft → refused (a draft owes nothing)', async () => {
    const draft = order({ status: 'DRAFT', outstanding: 800 });
    // Something else is owed, so the refusal is about the draft, not the shop.
    const { service, db } = build([draft, order({ outstanding: 800 })]);
    const r = await refused(service.create(pay(100, draft.id), 'actor-1'));
    expect(r.code).toBe('ORDER_NOT_CONFIRMED');
    nothingSaved(db);
  });

  it('Pay on a cancelled or fully paid order → refused', async () => {
    const cancelled = order({ status: 'CANCELLED', outstanding: 800 });
    const paid = order({ status: 'PAID', outstanding: 0 });
    const returned = order({ status: 'RETURNED', outstanding: 0 });
    // A credit note can bring a CONFIRMED order to zero without changing its status.
    const creditedToZero = order({ status: 'CONFIRMED', outstanding: 0 });
    const { service, db } = build([
      cancelled,
      paid,
      returned,
      creditedToZero,
      order({ outstanding: 800 }),
    ]);
    for (const o of [cancelled, paid, returned, creditedToZero]) {
      const r = await refused(service.create(pay(100, o.id), 'actor-1'));
      expect(r.code).toBe('ORDER_OWES_NOTHING');
    }
    nothingSaved(db);
  });

  it('Payment dated tomorrow → refused, on the chosen-order path too', async () => {
    const chosen = order({ outstanding: 800 });
    const { service, db } = build([chosen]);
    const [y, m, d] = businessToday().split('-').map(Number);
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1))
      .toISOString()
      .slice(0, 10);

    const r = await refused(
      service.create(pay(100, chosen.id, { receivedOn: tomorrow }), 'actor-1'),
    );
    expect(r.code).toBe('DATE_IN_FUTURE');
    nothingSaved(db);
  });

  it('a payment dated today in Cairo is accepted', async () => {
    const chosen = order({ outstanding: 800 });
    const { service, db } = build([chosen]);
    await service.create(
      pay(100, chosen.id, { receivedOn: businessToday() }),
      'actor-1',
    );
    expect(db.store.payments).toHaveLength(1);
  });

  it("The cap is the order's outstanding net of returns", async () => {
    // An 800 order with a 200 credit note: the return service lowered its
    // outstanding to 600 (§5). 601 is too much; 600 clears it.
    const chosen = order({ total: D(800), outstanding: 600 });
    const { service, db } = build([chosen]);

    const r = await refused(service.create(pay(601, chosen.id), 'actor-1'));
    expect(r.code).toBe('PAYMENT_EXCEEDS_ORDER');
    expect(r.params.owed).toBe('600.00');

    await service.create(pay(600, chosen.id), 'actor-1');
    expect(db.store.orders[0].status).toBe('PAID');
  });

  it('Amount 0 or negative with an orderId → refused', async () => {
    const chosen = order({ outstanding: 800 });
    const { service, db } = build([chosen]);
    for (const amount of [0, -50]) {
      const r = await refused(
        service.create(pay(amount, chosen.id), 'actor-1'),
      );
      expect(r.code).toBe('AMOUNT_NOT_POSITIVE');
    }
    nothingSaved(db);
  });

  it('an unverified customer is refused on the chosen-order path as today', async () => {
    const chosen = order({ outstanding: 800 });
    const { service, db } = build([chosen]);
    db.store.customers[0].verificationStatus = 'UNVERIFIED';
    const r = await refused(service.create(pay(100, chosen.id), 'actor-1'));
    expect(r.code).toBe('CUSTOMER_NOT_VERIFIED');
    nothingSaved(db);
  });

  it('Double submit → one payment (the same key answers with the first)', async () => {
    const chosen = order({ outstanding: 800 });
    const { service, db } = build([chosen]);

    const a: any = await service.create(
      pay(800, chosen.id),
      'actor-1',
      'key-1',
    );
    // The order is now paid in full; the retry must still get its payment back,
    // not "this order owes nothing".
    const b: any = await service.create(
      pay(800, chosen.id),
      'actor-1',
      'key-1',
    );

    expect(b.data.id).toBe(a.data.id);
    expect(db.store.payments).toHaveLength(1);
    expect(db.store.allocations).toHaveLength(1);
    expect(db.store.ledger).toHaveLength(1);
  });

  it("A chosen-order payment still counts toward the shop's payment plan", async () => {
    const chosen = order({ outstanding: 800 });
    const { service, client, db } = build([chosen]);
    const agreedOn = new Date('2026-01-01');
    db.store.plans.push({
      id: 'plan-1',
      customerId: SHOP,
      agreedOn,
      status: 'ACTIVE',
      instalments: [
        {
          id: 'i1',
          sequence: 1,
          dueOn: new Date('2026-02-01'),
          amount: D(500),
          note: null,
        },
        {
          id: 'i2',
          sequence: 2,
          dueOn: new Date('2099-01-01'),
          amount: D(300),
          note: null,
        },
      ],
    });
    const plans = new PaymentPlansService(
      client as PrismaService,
      { log: jest.fn() } as unknown as AuditService,
      {} as NotificationsService,
    );

    await service.create(pay(500, chosen.id), 'actor-1');
    const plan: any = (await plans.findOne('plan-1')).data;

    expect(Number(plan.paidEgp)).toBe(500);
    expect(plan.isOverdue).toBe(false);
    expect(plan.instalments[0].state).toBe('PAID');
  });
});

describe('POST /payments without an orderId (oldest-first stays with the caller)', () => {
  it('records the payment unallocated, exactly as before', async () => {
    const { service, db } = build([
      order({ outstanding: 300 }),
      order({ outstanding: 800 }),
    ]);
    await service.create(pay(500), 'actor-1');
    expect(db.store.payments).toHaveLength(1);
    expect(db.store.allocations).toHaveLength(0);
    expect(db.store.ledger).toHaveLength(1);
  });

  it('more than the shop owes is still PAYMENT_EXCEEDS_OWED', async () => {
    const { service, db } = build([order({ outstanding: 300 })]);
    const r = await refused(service.create(pay(500), 'actor-1'));
    expect(r.code).toBe('PAYMENT_EXCEEDS_OWED');
    nothingSaved(db);
  });

  it('allocating afterwards still goes through the same checks: a draft is refused', async () => {
    const draft = order({ status: 'DRAFT', outstanding: 800 });
    const { service, db } = build([draft, order({ outstanding: 800 })]);
    const p: any = await service.create(pay(100), 'actor-1');
    const r = await refused(
      service.allocateToOrder(p.data.id, draft.id, 100, 'actor-1'),
    );
    expect(r.code).toBe('ORDER_NOT_CONFIRMED');
    expect(db.store.allocations).toHaveLength(0);
  });

  it("allocating to another shop's order is still ORDER_OTHER_CUSTOMER", async () => {
    const theirs = order({ customerId: OTHER_SHOP, outstanding: 800 });
    const { service } = build([theirs, order({ outstanding: 800 })]);
    const p: any = await service.create(pay(100), 'actor-1');
    const r = await refused(
      service.allocateToOrder(p.data.id, theirs.id, 100, 'actor-1'),
    );
    expect(r.code).toBe('ORDER_OTHER_CUSTOMER');
  });
});

describe('who may record a payment', () => {
  function contextFor(role: string): ExecutionContext {
    return {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- the guard reads metadata off the handler; it never calls it
      getHandler: () => PaymentsController.prototype.create,
      getClass: () => PaymentsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext;
  }
  const guard = new RolesGuard(new Reflector());

  it('An investor records a payment → refused with a code', () => {
    let caught: unknown;
    try {
      guard.canActivate(contextFor('TEMP_INVESTOR'));
    } catch (e) {
      caught = e;
    }
    expect(refusalOf(caught)).toEqual(
      expect.objectContaining({ status: 403, code: 'ROLE_NOT_ALLOWED' }),
    );
  });

  it('a core partner and admin support are let through', () => {
    expect(guard.canActivate(contextFor('CORE_PARTNER'))).toBe(true);
    expect(guard.canActivate(contextFor('ADMIN_SUPPORT'))).toBe(true);
  });
});

/**
 * A payment sent with no date is one received today — today in Cairo (§7a),
 * not in UTC. At 22:30 UTC on the 10th it is already past midnight on the
 * 11th in Cairo; dating it by the UTC day put the money into yesterday.
 */
describe('POST /payments with no date', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
  });
  afterEach(() => jest.useRealTimers());

  // A @db.Date column keeps the UTC calendar day of the value it is given,
  // which is what this reads back.
  const storedDay = (p: { receivedOn: Date }) =>
    p.receivedOn.toISOString().slice(0, 10);

  it('at 22:30 UTC on the 10th, an undated payment is dated the 11th (Cairo)', async () => {
    jest.setSystemTime(new Date('2026-10-10T22:30:00Z'));
    const owing = order({ outstanding: 800 });
    const { service, db } = build([owing]);

    await service.create(pay(100, owing.id), 'actor-1');

    expect(db.store.payments).toHaveLength(1);
    expect(storedDay(db.store.payments[0])).toBe('2026-10-11');
  });

  it('undated and unallocated, at 22:30 UTC on the 10th → the 11th too', async () => {
    jest.setSystemTime(new Date('2026-10-10T22:30:00Z'));
    const { service, db } = build([order({ outstanding: 800 })]);

    await service.create(pay(100), 'actor-1');

    expect(storedDay(db.store.payments[0])).toBe('2026-10-11');
  });

  it('at 12:00 UTC the Cairo day and the UTC day agree', async () => {
    jest.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    const { service, db } = build([order({ outstanding: 800 })]);

    await service.create(pay(100), 'actor-1');

    expect(storedDay(db.store.payments[0])).toBe('2026-10-10');
  });

  it('a stated date is kept as given, whatever the clock says', async () => {
    jest.setSystemTime(new Date('2026-10-10T22:30:00Z'));
    const owing = order({ outstanding: 800 });
    const { service, db } = build([owing]);

    await service.create(
      pay(100, owing.id, { receivedOn: '2026-10-09' }),
      'actor-1',
    );

    expect(storedDay(db.store.payments[0])).toBe('2026-10-09');
  });

  it('the 12th, typed at 22:30 UTC on the 10th, is still the future → refused', async () => {
    jest.setSystemTime(new Date('2026-10-10T22:30:00Z'));
    const owing = order({ outstanding: 800 });
    const { service, db } = build([owing]);

    const r = await refused(
      service.create(pay(100, owing.id, { receivedOn: '2026-10-12' }), 'a'),
    );

    expect(r.code).toBe('DATE_IN_FUTURE');
    nothingSaved(db);
  });
});
