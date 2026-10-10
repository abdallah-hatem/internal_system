/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- an in-memory stand-in for Prisma answers loosely-shaped query objects */
// The fake store holds real Decimals, as the service expects.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { Prisma } from '@prisma/client';
import type { HttpException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

/**
 * Create & confirm in one step (BUSINESS_LOGIC §4, DECIDED 2026-10-10).
 *
 * The fake database below keeps every table in memory and gives `$transaction`
 * real rollback: it snapshots the store before the callback and restores it if
 * the callback throws. Without that, "no draft left behind" would pass whether
 * the service used a transaction or not — the shape of a test that proves
 * nothing (CLAUDE.md rule 2).
 */

const D = (v: number | string) => new Prisma.Decimal(v);

const SHOP = '11111111-1111-4111-8111-111111111111';
const PISTON = '22222222-2222-4222-8222-222222222222';
const CHAIN = '33333333-3333-4333-8333-333333333333';
const NOBODY = '99999999-9999-4999-8999-999999999999';

interface Store {
  customers: any[];
  products: any[];
  batches: any[];
  reservations: any[];
  orders: any[];
  items: any[];
  movements: any[];
  allocations: any[];
}

function seed(stock: Record<string, number>): Store {
  return {
    customers: [
      {
        id: SHOP,
        displayName: 'Nile Motors',
        type: 'B2B',
        verificationStatus: 'VERIFIED',
      },
    ],
    products: [
      { id: PISTON, name: 'Piston kit' },
      { id: CHAIN, name: 'Chain' },
    ],
    batches: Object.entries(stock).map(([productId, qty], i) => ({
      id: `batch-${i}`,
      productId,
      verificationStatus: 'VERIFIED',
      saleableQty: D(qty),
      remainingQty: D(qty),
      landedUnitCostEgp: D(100),
      createdAt: new Date(2026, 0, 1 + i),
    })),
    reservations: [],
    orders: [],
    items: [],
    movements: [],
    allocations: [],
  };
}

function clone(store: Store): Store {
  const copyRow = (r: any) => ({ ...r });
  return Object.fromEntries(
    Object.entries(store).map(([k, rows]) => [k, (rows as any[]).map(copyRow)]),
  ) as unknown as Store;
}

let seq = 0;
const id = (prefix: string) => `${prefix}-${++seq}`;

function fakePrisma(initial: Store) {
  const db = { store: initial };

  const decrement = (current: Prisma.Decimal, change: any) =>
    change?.decrement !== undefined ? current.sub(change.decrement) : D(change);

  const orderWithItems = (order: any, include: any) => {
    if (!order) return null;
    const out: any = { ...order };
    if (include?.items) {
      out.items = db.store.items
        .filter((i) => i.saleOrderId === order.id)
        .map((i) => ({
          ...i,
          ...(include.items.include?.product
            ? { product: db.store.products.find((p) => p.id === i.productId) }
            : {}),
        }));
    }
    if (include?.customer) {
      out.customer = db.store.customers.find((c) => c.id === order.customerId);
    }
    return out;
  };

  const client: any = {
    customer: {
      findUnique: async ({ where }: any) =>
        db.store.customers.find((c) => c.id === where.id) ?? null,
    },
    product: {
      findUnique: async ({ where }: any) =>
        db.store.products.find((p) => p.id === where.id) ?? null,
    },
    inventoryBatch: {
      groupBy: async ({ where }: any) => {
        const ids: string[] = where.productId.in;
        return ids
          .map((productId) => {
            const rows = db.store.batches.filter(
              (b) =>
                b.productId === productId &&
                b.verificationStatus === 'VERIFIED',
            );
            if (rows.length === 0) return null;
            return {
              productId,
              _sum: {
                saleableQty: rows.reduce((t, b) => t.add(b.saleableQty), D(0)),
              },
            };
          })
          .filter(Boolean);
      },
      findMany: async ({ where }: any) =>
        db.store.batches
          .filter(
            (b) =>
              b.productId === where.productId &&
              b.verificationStatus === 'VERIFIED' &&
              b.saleableQty.gt(0),
          )
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((b) => ({ ...b })),
      update: async ({ where, data }: any) => {
        const b = db.store.batches.find((x) => x.id === where.id);
        b.saleableQty = decrement(b.saleableQty, data.saleableQty);
        b.remainingQty = decrement(b.remainingQty, data.remainingQty);
        return { ...b };
      },
    },
    inventoryReservation: { findMany: async () => [] },
    inventoryMovement: {
      create: async ({ data }: any) => {
        const row = { id: id('mv'), ...data };
        db.store.movements.push(row);
        return row;
      },
    },
    saleItemAllocation: {
      create: async ({ data }: any) => {
        const row = { id: id('alloc'), ...data };
        db.store.allocations.push(row);
        return row;
      },
    },
    saleOrder: {
      findFirst: async ({ where }: any) => {
        const prefix = where.orderNo.startsWith;
        const rows = db.store.orders
          .filter((o) => o.orderNo.startsWith(prefix))
          .sort((a, b) => (a.orderNo < b.orderNo ? 1 : -1));
        return rows[0] ? { orderNo: rows[0].orderNo } : null;
      },
      findUnique: async ({ where, include }: any) =>
        orderWithItems(
          db.store.orders.find((o) => o.id === where.id),
          include,
        ),
      create: async ({ data, include }: any) => {
        const { items, ...rest } = data;
        const order = {
          id: id('order'),
          version: 1,
          ...rest,
          subtotal: D(rest.subtotal),
          total: D(rest.total),
          outstanding: D(rest.outstanding),
        };
        db.store.orders.push(order);
        for (const it of items.create) {
          db.store.items.push({
            id: id('item'),
            saleOrderId: order.id,
            ...it,
            quantity: D(it.quantity),
            unitPrice: D(it.unitPrice),
            discount: D(it.discount),
            lineTotal: D(it.lineTotal),
          });
        }
        return orderWithItems(order, include);
      },
      update: async ({ where, data, include }: any) => {
        const order = db.store.orders.find(
          (o) =>
            o.id === where.id &&
            (where.version === undefined || o.version === where.version),
        );
        if (!order) throw new Error('P2025: record to update not found');
        order.status = data.status ?? order.status;
        if (data.version?.increment) order.version += data.version.increment;
        return orderWithItems(order, include);
      },
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

function build(stock: Record<string, number>) {
  const { client, db } = fakePrisma(seed(stock));
  const audit = { log: jest.fn(async () => undefined) };
  const service = new SalesService(
    client as PrismaService,
    audit as unknown as AuditService,
  );
  return { service, db, audit };
}

function refusalOf(e: unknown): { status: number; code: string } {
  const err = e as HttpException;
  return {
    status: err.getStatus(),
    code: (err.getResponse() as { code: string }).code,
  };
}

async function refused(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return refusalOf(e);
  }
  throw new Error('expected a refusal, and the request went through');
}

const order = (items: any[], extra: Record<string, unknown> = {}) => ({
  customerId: SHOP,
  channel: 'B2B',
  currency: 'EGP',
  items,
  ...extra,
});

const saleable = (db: { store: Store }, productId: string) =>
  db.store.batches
    .filter((b) => b.productId === productId)
    .reduce((t, b) => t.add(b.saleableQty), D(0))
    .toNumber();

describe('POST /sales/orders with confirm: true', () => {
  it('Create & confirm with enough stock → one confirmed order, stock reduced, in one request', async () => {
    const { service, db, audit } = build({ [PISTON]: 60 });

    const res: any = await service.create(
      order(
        [{ productId: PISTON, quantity: 10, unitPrice: 250, discount: 0 }],
        {
          confirm: true,
        },
      ),
      'actor-1',
    );

    expect(res.data.status).toBe('CONFIRMED');
    expect(db.store.orders).toHaveLength(1);
    expect(db.store.orders[0].status).toBe('CONFIRMED');
    expect(saleable(db, PISTON)).toBe(50);
    expect(db.store.allocations).toHaveLength(1);
    expect(audit.log.mock.calls.map((c: any[]) => c[0].action)).toEqual([
      'CREATE',
      'CONFIRM',
    ]);
  });

  it('Create & confirm for more than is in stock → NOT_ENOUGH_STOCK, no draft left behind', async () => {
    const { service, db, audit } = build({ [PISTON]: 5 });

    const r = await refused(
      service.create(
        order([{ productId: PISTON, quantity: 6, unitPrice: 250 }], {
          confirm: true,
        }),
        'actor-1',
      ),
    );

    expect(r).toEqual({ status: 400, code: 'NOT_ENOUGH_STOCK' });
    expect(db.store.orders).toHaveLength(0);
    expect(db.store.items).toHaveLength(0);
    expect(saleable(db, PISTON)).toBe(5);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('no draft left behind when the confirm step itself refuses (the FIFO allocation runs short)', async () => {
    // The pre-check passes — the shelf reads 10 — but the confirm finds only
    // 4 in batches it can allocate from. The draft was already inserted inside
    // the transaction; this is the case only the transaction can clean up.
    const { service, db } = build({ [PISTON]: 10 });
    const real = db.store.batches[0];
    const svc: any = service;
    const originalConfirm = svc.confirmWithin.bind(service);
    svc.confirmWithin = async (tx: any, ...rest: any[]) => {
      real.saleableQty = D(4);
      return originalConfirm(tx, ...rest);
    };

    const r = await refused(
      service.create(
        order([{ productId: PISTON, quantity: 8, unitPrice: 100 }], {
          confirm: true,
        }),
        'actor-1',
      ),
    );

    expect(r).toEqual({ status: 400, code: 'INSUFFICIENT_STOCK' });
    expect(db.store.orders).toHaveLength(0);
    expect(db.store.items).toHaveLength(0);
    expect(db.store.allocations).toHaveLength(0);
    expect(db.store.movements).toHaveLength(0);
  });

  it('Create & confirm with a discount larger than the line → DISCOUNT_EXCEEDS_LINE, nothing saved', async () => {
    const { service, db } = build({ [PISTON]: 60 });

    const r = await refused(
      service.create(
        order(
          [{ productId: PISTON, quantity: 1, unitPrice: 100, discount: 9999 }],
          {
            confirm: true,
          },
        ),
        'actor-1',
      ),
    );

    expect(r).toEqual({ status: 400, code: 'DISCOUNT_EXCEEDS_LINE' });
    expect(db.store.orders).toHaveLength(0);
    expect(saleable(db, PISTON)).toBe(60);
  });

  it('a discount exactly equal to the line is allowed and totals zero', async () => {
    const { service } = build({ [PISTON]: 60 });
    const res: any = await service.create(
      order(
        [{ productId: PISTON, quantity: 2, unitPrice: 50, discount: 100 }],
        {
          confirm: true,
        },
      ),
      'actor-1',
    );
    expect(Number(res.data.items[0].lineTotal)).toBe(0);
  });

  it('Create & confirm for a customer id that does not exist → 404, not 500', async () => {
    const { service, db } = build({ [PISTON]: 60 });

    const r = await refused(
      service.create(
        {
          ...order([{ productId: PISTON, quantity: 1, unitPrice: 100 }], {
            confirm: true,
          }),
          customerId: NOBODY,
        },
        'actor-1',
      ),
    );

    expect(r).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(db.store.orders).toHaveLength(0);
  });

  it('Create & confirm for a product id that does not exist → 404, nothing saved', async () => {
    const { service, db } = build({ [PISTON]: 60 });
    const r = await refused(
      service.create(
        order([{ productId: NOBODY, quantity: 1, unitPrice: 100 }], {
          confirm: true,
        }),
        'actor-1',
      ),
    );
    expect(r).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(db.store.orders).toHaveLength(0);
  });

  it('Two lines of one product (40 + 40) against 60 in stock on Create & confirm → refused as a sum', async () => {
    const { service, db } = build({ [PISTON]: 60 });

    const r = await refused(
      service.create(
        order(
          [
            { productId: PISTON, quantity: 40, unitPrice: 100 },
            { productId: PISTON, quantity: 40, unitPrice: 100 },
          ],
          { confirm: true },
        ),
        'actor-1',
      ),
    );

    expect(r).toEqual({ status: 400, code: 'NOT_ENOUGH_STOCK' });
    expect(db.store.orders).toHaveLength(0);
    expect(saleable(db, PISTON)).toBe(60);
  });

  it('zero and negative quantities, and a negative price, are refused with nothing saved', async () => {
    const { service, db } = build({ [PISTON]: 60 });
    for (const [line, code] of [
      [{ productId: PISTON, quantity: 0, unitPrice: 100 }, 'QTY_NOT_POSITIVE'],
      [{ productId: PISTON, quantity: -3, unitPrice: 100 }, 'QTY_NOT_POSITIVE'],
      [{ productId: PISTON, quantity: 1, unitPrice: -1 }, 'PRICE_NEGATIVE'],
    ] as const) {
      const r = await refused(
        service.create(order([line], { confirm: true }), 'actor-1'),
      );
      expect(r.code).toBe(code);
    }
    const empty = await refused(
      service.create(order([], { confirm: true }), 'actor-1'),
    );
    expect(empty.code).toBe('ORDER_NEEDS_ITEM');
    expect(db.store.orders).toHaveLength(0);
  });

  it('an unverified customer cannot be sold to on the one-step path either', async () => {
    const { service, db } = build({ [PISTON]: 60 });
    db.store.customers[0].verificationStatus = 'UNVERIFIED';
    const r = await refused(
      service.create(
        order([{ productId: PISTON, quantity: 1, unitPrice: 100 }], {
          confirm: true,
        }),
        'actor-1',
      ),
    );
    expect(r.code).toBe('CUSTOMER_NOT_VERIFIED');
    expect(db.store.orders).toHaveLength(0);
  });

  it('confirm missing or not exactly true saves a draft, which reserves nothing', async () => {
    const { service, db } = build({ [PISTON]: 60 });
    for (const confirm of [undefined, false, 'true']) {
      const res: any = await service.create(
        order([{ productId: PISTON, quantity: 5, unitPrice: 100 }], {
          confirm,
        }),
        'actor-1',
      );
      expect(res.data.status).toBe('DRAFT');
    }
    expect(saleable(db, PISTON)).toBe(60);
    expect(db.store.allocations).toHaveLength(0);
  });

  it('Double-click Create & confirm → one order', async () => {
    const { service, db } = build({ [PISTON]: 60 });
    const body = order([{ productId: PISTON, quantity: 10, unitPrice: 100 }], {
      confirm: true,
    });

    // Both clicks leave before either is answered.
    const [a, b]: any[] = await Promise.all([
      service.create(body, 'actor-1', 'key-1'),
      service.create(body, 'actor-1', 'key-1'),
    ]);
    // And a late third, after the first was answered.
    const c: any = await service.create(body, 'actor-1', 'key-1');

    expect(db.store.orders).toHaveLength(1);
    expect(a.data.id).toBe(b.data.id);
    expect(c.data.id).toBe(a.data.id);
    expect(saleable(db, PISTON)).toBe(50);
  });

  it('a refused attempt is not remembered: fixing the lines and retrying with the same key runs', async () => {
    const { service, db } = build({ [PISTON]: 60 });
    const tooMany = order(
      [{ productId: PISTON, quantity: 61, unitPrice: 100 }],
      { confirm: true },
    );
    const fixed = order([{ productId: PISTON, quantity: 6, unitPrice: 100 }], {
      confirm: true,
    });

    expect(
      (await refused(service.create(tooMany, 'actor-1', 'key-2'))).code,
    ).toBe('NOT_ENOUGH_STOCK');
    const res: any = await service.create(fixed, 'actor-1', 'key-2');

    expect(res.data.status).toBe('CONFIRMED');
    expect(db.store.orders).toHaveLength(1);
  });

  it("one person's key does not answer for another's order", async () => {
    const { service, db } = build({ [PISTON]: 60 });
    const body = order([{ productId: PISTON, quantity: 1, unitPrice: 100 }], {
      confirm: true,
    });
    const a: any = await service.create(body, 'actor-1', 'same-key');
    const b: any = await service.create(body, 'actor-2', 'same-key');
    expect(a.data.id).not.toBe(b.data.id);
    expect(db.store.orders).toHaveLength(2);
  });

  it('The running total equals the server order total for the same lines, discounts included', async () => {
    const { service } = build({ [PISTON]: 60, [CHAIN]: 60 });
    const res: any = await service.create(
      order(
        [
          { productId: PISTON, quantity: 3, unitPrice: 33.33, discount: 0.99 },
          { productId: CHAIN, quantity: 1.255, unitPrice: 19.99, discount: 5 },
        ],
        { confirm: true },
      ),
      'actor-1',
    );
    // 3 × 33.33 = 99.99 − 0.99 = 99.00; 1.255 × 19.99 = 25.087… → 25.09 − 5 = 20.09.
    expect(res.data.items.map((i: any) => Number(i.lineTotal))).toEqual([
      99, 20.09,
    ]);
    expect(Number(res.data.total)).toBe(119.09);
    expect(Number(res.data.outstanding)).toBe(119.09);
  });

  it('confirming an order created that way again is refused (only drafts confirm)', async () => {
    const { service } = build({ [PISTON]: 60 });
    const res: any = await service.create(
      order([{ productId: PISTON, quantity: 1, unitPrice: 100 }], {
        confirm: true,
      }),
      'actor-1',
    );
    const r = await refused(
      service.confirmOrder(res.data.id, 'actor-1', res.data.version),
    );
    expect(r.code).toBe('ONLY_DRAFT_CONFIRMABLE');
  });

  it('the two-step path still works: draft, then confirm through the same rules', async () => {
    const { service, db } = build({ [PISTON]: 60 });
    const draft: any = await service.create(
      order([{ productId: PISTON, quantity: 7, unitPrice: 100 }]),
      'actor-1',
    );
    expect(saleable(db, PISTON)).toBe(60);
    const confirmed: any = await service.confirmOrder(
      draft.data.id,
      'actor-1',
      1,
    );
    expect(confirmed.data.status).toBe('CONFIRMED');
    expect(saleable(db, PISTON)).toBe(53);
  });
});

describe('who may create & confirm', () => {
  function contextFor(role: string): ExecutionContext {
    return {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- the guard reads metadata off the handler; it never calls it
      getHandler: () => SalesController.prototype.create,
      getClass: () => SalesController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext;
  }
  const guard = new RolesGuard(new Reflector());

  it('Create & confirm as an investor → refused with a code', () => {
    let caught: unknown;
    try {
      guard.canActivate(contextFor('TEMP_INVESTOR'));
    } catch (e) {
      caught = e;
    }
    expect(refusalOf(caught)).toEqual({
      status: 403,
      code: 'ROLE_NOT_ALLOWED',
    });
  });

  it('a shop-portal account is refused too', () => {
    expect(() => guard.canActivate(contextFor('SHOP_OWNER_PORTAL'))).toThrow();
  });

  it('a core partner and admin support are let through', () => {
    expect(guard.canActivate(contextFor('CORE_PARTNER'))).toBe(true);
    expect(guard.canActivate(contextFor('ADMIN_SUPPORT'))).toBe(true);
  });
});
