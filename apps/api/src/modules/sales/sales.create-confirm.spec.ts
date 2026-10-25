/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- an in-memory stand-in for Prisma answers loosely-shaped query objects */
// The fake store holds real Decimals, as the service expects.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { Prisma } from '@prisma/client';
import type { HttpException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { PaymentsService } from '../payments/payments.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PriceCheckController, SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import {
  businessDay,
  businessToday,
  endOfBusinessDay,
  instantOfDay,
} from '../../common/dates';

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
  users: any[];
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
    users: [
      { id: 'partner-a', role: 'CORE_PARTNER', status: 'ACTIVE' },
      { id: 'partner-b', role: 'CORE_PARTNER', status: 'ACTIVE' },
      { id: 'investor', role: 'TEMP_INVESTOR', status: 'ACTIVE' },
    ],
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
  const db: { store: Store; queue: Promise<unknown> } = {
    store: initial,
    queue: Promise.resolve(),
  };

  // `createdAt: { lt }` — the received cut-off of a sale dated in the past
  // (§4, 2026-10-16). Ignoring it would let any back-dating test pass.
  const receivedBefore = (b: any, where: any) =>
    where.createdAt?.lt === undefined || b.createdAt < where.createdAt.lt;

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
    // No customer here has branches (§7, 2026-10-25): no default to fall back to.
    customerBranch: {
      findFirst: async () => null,
      findUnique: async () => null,
    },
    product: {
      findUnique: async ({ where }: any) =>
        db.store.products.find((p) => p.id === where.id) ?? null,
      // findLowStock's query: active, a minimum set, these ids; with batches.
      findMany: async ({ where }: any) =>
        db.store.products
          .filter(
            (p) =>
              p.status === where.status &&
              p.minStock != null &&
              (!where.id || where.id.in.includes(p.id)),
          )
          .map((p) => ({
            ...p,
            inventoryBatches: db.store.batches
              .filter((b) => b.productId === p.id)
              .map((b) => ({ remainingQty: b.remainingQty })),
          })),
    },
    user: {
      findMany: async ({ where }: any) =>
        db.store.users.filter(
          (u) => u.role === where.role && u.status === where.status,
        ),
    },
    inventoryBatch: {
      groupBy: async ({ where }: any) => {
        const ids: string[] = where.productId.in;
        return ids
          .map((productId) => {
            const rows = db.store.batches.filter(
              (b) =>
                b.productId === productId &&
                b.verificationStatus === 'VERIFIED' &&
                receivedBefore(b, where),
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
              b.saleableQty.gt(0) &&
              receivedBefore(b, where),
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
      findUnique: async ({ where, include }: any) => {
        const byKey = where.createdBy_idempotencyKey;
        return orderWithItems(
          db.store.orders.find((o) =>
            byKey
              ? o.createdBy === byKey.createdBy &&
                o.idempotencyKey === byKey.idempotencyKey
              : o.id === where.id,
          ),
          include,
        );
      },
      create: async ({ data, include }: any) => {
        const { items, ...rest } = data;
        // The unique index on (created_by, idempotency_key). NULL keys never
        // collide, as in Postgres.
        if (
          rest.idempotencyKey != null &&
          db.store.orders.some(
            (o) =>
              o.createdBy === rest.createdBy &&
              o.idempotencyKey === rest.idempotencyKey,
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed on the fields: (`created_by`,`idempotency_key`)',
            { code: 'P2002', clientVersion: 'test' },
          );
        }
        const order = {
          id: id('order'),
          version: 1,
          // The columns' defaults, now(), as Postgres fills them.
          createdAt: new Date(),
          orderedAt: new Date(),
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
    // One transaction at a time, as Postgres makes a second insert of the same
    // unique key wait for the first to commit before it fails.
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const run = db.queue.then(async () => {
        const before = clone(db.store);
        try {
          return await fn(client);
        } catch (e) {
          db.store = before;
          throw e;
        }
      });
      db.queue = run.catch(() => undefined);
      return run;
    },
  };

  return { client, db };
}

function build(
  stock: Record<string, number>,
  /** A minimum per product; the product is then ACTIVE with that minimum. */
  minStock: Record<string, number> = {},
) {
  const store = seed(stock);
  for (const p of store.products) {
    if (minStock[p.id] !== undefined) {
      p.status = 'ACTIVE';
      p.minStock = D(minStock[p.id]);
    }
  }
  const { client, db } = fakePrisma(store);
  const audit = { log: jest.fn(async () => undefined) };
  const notify = jest.fn(async () => ({ count: 0 }));
  const service = new SalesService(
    client as PrismaService,
    audit as unknown as AuditService,
    {} as PaymentsService,
    { createForMultipleUsers: notify },
  );
  return { service, db, audit, notify };
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

  it('a negative discount → DISCOUNT_NEGATIVE, on a draft and on Create & confirm, nothing saved', async () => {
    const { service, db } = build({ [PISTON]: 60 });
    for (const confirm of [false, true]) {
      const r = await refused(
        service.create(
          order(
            [{ productId: PISTON, quantity: 1, unitPrice: 100, discount: -50 }],
            { confirm },
          ),
          'actor-1',
        ),
      );
      expect(r).toEqual({ status: 400, code: 'DISCOUNT_NEGATIVE' });
    }
    // One cent below zero is still a hidden price rise.
    const cent = await refused(
      service.create(
        order([
          { productId: PISTON, quantity: 1, unitPrice: 100, discount: -0.01 },
        ]),
        'actor-1',
      ),
    );
    expect(cent.code).toBe('DISCOUNT_NEGATIVE');
    expect(db.store.orders).toHaveLength(0);
    expect(saleable(db, PISTON)).toBe(60);
  });

  it('a zero or missing discount is fine', async () => {
    const { service, db } = build({ [PISTON]: 60 });
    await service.create(
      order([{ productId: PISTON, quantity: 1, unitPrice: 100, discount: 0 }]),
      'actor-1',
    );
    await service.create(
      order([{ productId: PISTON, quantity: 1, unitPrice: 100 }]),
      'actor-1',
    );
    expect(db.store.orders).toHaveLength(2);
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

  it('a repeated key returns the same order and creates no second — even on another server instance', async () => {
    // Vercel: the retry lands on an instance that never saw the first request.
    // Two services over one database stand in for that; a key kept in memory
    // would let the second instance sell the goods again.
    const { service, db } = build({ [PISTON]: 60 });
    const elsewhere = new SalesService(
      (service as any).prisma,
      { log: jest.fn(async () => undefined) } as unknown as AuditService,
      {} as PaymentsService,
      { createForMultipleUsers: () => Promise.resolve({ count: 0 }) },
    );
    const body = order([{ productId: PISTON, quantity: 10, unitPrice: 100 }], {
      confirm: true,
    });

    const a: any = await service.create(body, 'actor-1', 'key-9');
    const b: any = await elsewhere.create(body, 'actor-1', 'key-9');

    expect(b.data.id).toBe(a.data.id);
    expect(db.store.orders).toHaveLength(1);
    expect(db.store.orders[0].idempotencyKey).toBe('key-9');
    expect(saleable(db, PISTON)).toBe(50);
  });

  it('a repeated key on a draft returns the same draft', async () => {
    const { service, db } = build({ [PISTON]: 60 });
    const body = order([{ productId: PISTON, quantity: 1, unitPrice: 100 }]);
    const a: any = await service.create(body, 'actor-1', 'draft-key');
    const b: any = await service.create(body, 'actor-1', 'draft-key');
    expect(b.data.id).toBe(a.data.id);
    expect(db.store.orders).toHaveLength(1);
  });

  it('without a key, two identical creates are two orders (nothing is guessed)', async () => {
    const { service, db } = build({ [PISTON]: 60 });
    const body = order([{ productId: PISTON, quantity: 1, unitPrice: 100 }]);
    await service.create(body, 'actor-1');
    await service.create(body, 'actor-1');
    expect(db.store.orders).toHaveLength(2);
    expect(db.store.orders.every((o: any) => o.idempotencyKey === null)).toBe(
      true,
    );
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

describe('a sale that takes a product into low stock says so (§3, 2026-10-11)', () => {
  /** The products each low-stock alert named, in the order raised. */
  const alerts = (notify: jest.Mock) =>
    notify.mock.calls.map(([userIds, data]: any) => ({
      userIds,
      code: data.code,
      products: data.payload.products.map((p: any) => [
        p.productName,
        p.currentStock,
        p.minStock,
      ]),
    }));

  it('12 on the shelf, minimum 10, 3 sold → one alert to every core partner, after the sale', async () => {
    const { service, notify } = build({ [PISTON]: 12 }, { [PISTON]: 10 });
    await service.create(
      order([{ productId: PISTON, quantity: 3, unitPrice: 100 }], {
        confirm: true,
      }),
      'actor-1',
    );
    expect(alerts(notify)).toEqual([
      {
        userIds: ['partner-a', 'partner-b'],
        code: 'LOW_STOCK_DETECTED',
        products: [['Piston kit', 9, 10]],
      },
    ]);
  });

  it('the second sale while it stays low raises nothing more', async () => {
    const { service, notify } = build({ [PISTON]: 12 }, { [PISTON]: 10 });
    const sell = (quantity: number) =>
      service.create(
        order([{ productId: PISTON, quantity, unitPrice: 100 }], {
          confirm: true,
        }),
        'actor-1',
      );
    await sell(3);
    await sell(2);
    await sell(7);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('left exactly at the minimum is not low: no alert', async () => {
    const { service, notify } = build({ [PISTON]: 12 }, { [PISTON]: 10 });
    await service.create(
      order([{ productId: PISTON, quantity: 2, unitPrice: 100 }], {
        confirm: true,
      }),
      'actor-1',
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it('a product with no minimum is never alerted, even sold out', async () => {
    const { service, notify } = build({ [PISTON]: 5 });
    await service.create(
      order([{ productId: PISTON, quantity: 5, unitPrice: 100 }], {
        confirm: true,
      }),
      'actor-1',
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it('a draft takes nothing off the shelf and raises nothing; confirming it does', async () => {
    const { service, notify } = build({ [PISTON]: 12 }, { [PISTON]: 10 });
    const draft: any = await service.create(
      order([{ productId: PISTON, quantity: 5, unitPrice: 100 }]),
      'actor-1',
    );
    expect(notify).not.toHaveBeenCalled();
    await service.confirmOrder(draft.data.id, 'actor-1', draft.data.version);
    expect(alerts(notify)[0].products).toEqual([['Piston kit', 7, 10]]);
  });

  it('a refused sale (more than is in stock) raises nothing — nothing left the shelf', async () => {
    const { service, notify, db } = build({ [PISTON]: 12 }, { [PISTON]: 10 });
    await refused(
      service.create(
        order([{ productId: PISTON, quantity: 13, unitPrice: 100 }], {
          confirm: true,
        }),
        'actor-1',
      ),
    );
    expect(notify).not.toHaveBeenCalled();
    expect(saleable(db, PISTON)).toBe(12);
  });

  it('two lines of one product count together; two products crossing are named in one alert', async () => {
    const { service, notify } = build(
      { [PISTON]: 12, [CHAIN]: 20 },
      { [PISTON]: 10, [CHAIN]: 15 },
    );
    await service.create(
      order(
        [
          { productId: PISTON, quantity: 1, unitPrice: 100 },
          { productId: PISTON, quantity: 2, unitPrice: 100 },
          { productId: CHAIN, quantity: 6, unitPrice: 50 },
        ],
        { confirm: true },
      ),
      'actor-1',
    );
    expect(alerts(notify)).toHaveLength(1);
    expect(alerts(notify)[0].products.sort()).toEqual([
      ['Chain', 14, 15],
      ['Piston kit', 9, 10],
    ]);
  });

  it('the same order sent twice with one key is one sale and one alert', async () => {
    const { service, notify } = build({ [PISTON]: 12 }, { [PISTON]: 10 });
    const body = order([{ productId: PISTON, quantity: 3, unitPrice: 100 }], {
      confirm: true,
    });
    await service.create(body, 'actor-1', 'k-1');
    await service.create(body, 'actor-1', 'k-1');
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('the price check — selling below cost warns, never refuses (§4, 2026-10-11)', () => {
  /** TC-INV-30's shelf: 2 at 900 received first, then 5 at 1,100. */
  function twoBatches() {
    const built = build({ [PISTON]: 2 });
    const [older] = built.db.store.batches;
    older.landedUnitCostEgp = D(900);
    built.db.store.batches.push({
      id: 'batch-newer',
      productId: PISTON,
      verificationStatus: 'VERIFIED',
      saleableQty: D(5),
      remainingQty: D(5),
      landedUnitCostEgp: D('1100.0000'),
      createdAt: new Date(2026, 5, 1),
    });
    return built;
  }

  const check = (service: SalesService, items: any[], currency = 'EGP') =>
    service.priceCheck({ currency, items }) as Promise<{ data: any }>;

  it('3 at 950 across two batches → below cost: each costs 966.67, selling at 950.00, a loss of 50.00', async () => {
    const { service } = twoBatches();
    const { data } = await check(service, [
      { productId: PISTON, quantity: 3, unitPrice: 950 },
    ]);
    expect(data.compared).toBe(true);
    expect(data.lines).toEqual([
      expect.objectContaining({
        line: 1,
        productId: PISTON,
        costed: true,
        belowCost: true,
        code: 'BELOW_COST',
        unitCostEgp: '966.67',
        unitPriceEgp: '950.00',
        costEgp: '2900.00',
        netEgp: '2850.00',
        lossEgp: '50.00',
      }),
    ]);
    expect(data.totalLossEgp).toBe('50.00');
    expect(data.belowCostLines).toBe(1);
  });

  it('checking writes nothing: no order, no allocation, the shelf unchanged', async () => {
    const { service, db } = twoBatches();
    await check(service, [{ productId: PISTON, quantity: 3, unitPrice: 1 }]);
    expect(db.store.orders).toHaveLength(0);
    expect(db.store.allocations).toHaveLength(0);
    expect(saleable(db, PISTON)).toBe(7);
  });

  it.each([
    ['one batch', [{ quantity: 2, unitPrice: 800 }]],
    ['spanning both', [{ quantity: 3, unitPrice: 950 }]],
    [
      'two lines, the second on the newer batch',
      [
        { quantity: 2, unitPrice: 1000 },
        { quantity: 1, unitPrice: 1000, discount: 5 },
      ],
    ],
    ['all seven', [{ quantity: 7, unitPrice: 1 }]],
  ])(
    'what the check says it costs is the COGS confirming records (%s)',
    async (_name, lines) => {
      const { service, db } = twoBatches();
      const items = (lines as any[]).map((l) => ({ productId: PISTON, ...l }));
      const { data } = await check(service, items);
      await service.create(order(items, { confirm: true }), 'actor-1');

      const cogs = db.store.allocations
        .reduce((t, a) => t.add(a.cogsEgp), D(0))
        .toFixed(2);
      const predicted = data.lines
        .reduce((t: Prisma.Decimal, l: any) => t.add(l.costEgp), D(0))
        .toFixed(2);
      expect(predicted).toBe(cogs);
    },
  );

  it('a confirmed sale below cost goes through — the warning never refuses', async () => {
    const { service, db } = twoBatches();
    const res: any = await service.create(
      order([{ productId: PISTON, quantity: 3, unitPrice: 1 }], {
        confirm: true,
      }),
      'actor-1',
    );
    expect(res.data.status).toBe('CONFIRMED');
    expect(db.store.orders).toHaveLength(1);
  });

  it('a sale in another currency is not compared (the cost is in pounds and the order carries no rate)', async () => {
    const { service } = twoBatches();
    const { data } = await check(
      service,
      [{ productId: PISTON, quantity: 3, unitPrice: 1 }],
      'USD',
    );
    expect(data.compared).toBe(false);
    expect(data.lines[0]).toMatchObject({
      costed: false,
      belowCost: false,
      reason: 'CURRENCY',
      code: null,
    });
    expect(data.totalLossEgp).toBe('0.00');
  });

  it('no stock, more than the shelf, and an id that is not a product are not costed — and never a 500', async () => {
    const { service } = twoBatches();
    const { data } = await check(service, [
      { productId: CHAIN, quantity: 1, unitPrice: 1 },
      { productId: PISTON, quantity: 8, unitPrice: 1 },
      { productId: 'not-a-uuid', quantity: 1, unitPrice: 1 },
      { productId: NOBODY, quantity: 1, unitPrice: 1 },
    ]);
    expect(
      data.lines.map((l: any) => [l.costed, l.belowCost, l.reason]),
    ).toEqual([
      [false, false, 'NO_STOCK'],
      [false, false, 'NO_STOCK'],
      [false, false, 'INCOMPLETE'],
      [false, false, 'NO_STOCK'],
    ]);
    expect(data.totalLossEgp).toBe('0.00');
  });

  it('a body without an items list → VALIDATION_FAILED, not a 500', async () => {
    const { service } = twoBatches();
    expect(await refused(service.priceCheck({} as any))).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(await refused(service.priceCheck({ items: 'x' } as any))).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('more lines than any order would carry → VALIDATION_FAILED', async () => {
    const { service } = twoBatches();
    const items = Array.from({ length: 201 }, () => ({
      productId: PISTON,
      quantity: 1,
      unitPrice: 1,
    }));
    expect(await refused(service.priceCheck({ items }))).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  describe('who may ask — the roles that sell, and no one else', () => {
    function contextFor(role: string): ExecutionContext {
      return {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- the guard reads metadata off the handler; it never calls it
        getHandler: () => PriceCheckController.prototype.priceCheck,
        getClass: () => PriceCheckController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as unknown as ExecutionContext;
    }
    const guard = new RolesGuard(new Reflector());

    it('an investor and a shop are refused (costs are not theirs to see)', () => {
      expect(() => guard.canActivate(contextFor('TEMP_INVESTOR'))).toThrow();
      expect(() =>
        guard.canActivate(contextFor('SHOP_OWNER_PORTAL')),
      ).toThrow();
    });

    it('a core partner and admin support may ask', () => {
      expect(guard.canActivate(contextFor('CORE_PARTNER'))).toBe(true);
      expect(guard.canActivate(contextFor('ADMIN_SUPPORT'))).toBe(true);
    });
  });
});

describe('a sale has a date (§4, 2026-10-16)', () => {
  /** The Cairo day `n` days before today, YYYY-MM-DD. */
  const daysAgo = (n: number) =>
    new Date(Date.parse(`${businessToday()}T00:00:00Z`) - n * 86_400_000)
      .toISOString()
      .slice(0, 10);

  /**
   * A shelf received in two goes: 5 pistons twenty days ago at 100, and 10
   * two days ago at 200. A sale dated ten days ago can only have drawn the
   * first five.
   */
  function shelf() {
    const built = build({ [PISTON]: 5 });
    const [older] = built.db.store.batches;
    older.createdAt = instantOfDay(daysAgo(20));
    built.db.store.batches.push({
      id: 'batch-later',
      productId: PISTON,
      verificationStatus: 'VERIFIED',
      saleableQty: D(10),
      remainingQty: D(10),
      landedUnitCostEgp: D(200),
      createdAt: instantOfDay(daysAgo(2)),
    });
    return built;
  }

  const piston = (quantity: number) => [
    { productId: PISTON, quantity, unitPrice: 300 },
  ];

  const codeAndParams = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      const err = e as HttpException;
      return {
        status: err.getStatus(),
        ...(err.getResponse() as { code: string; params?: any }),
      };
    }
    throw new Error('expected a refusal, and the request went through');
  };

  it('a sale dated ten days ago is stored on that day in Cairo', async () => {
    const { service, db } = shelf();
    await service.create(
      order(piston(1), { orderedOn: daysAgo(10), confirm: true }),
      'actor-1',
    );
    expect(businessDay(db.store.orders[0].orderedAt)).toBe(daysAgo(10));
  });

  it('left out, the sale is today, and draws the whole shelf as before', async () => {
    const { service, db } = shelf();
    const res: any = await service.create(
      order(piston(12), { confirm: true }),
      'actor-1',
    );
    expect(res.data.status).toBe('CONFIRMED');
    expect(businessDay(db.store.orders[0].orderedAt)).toBe(businessToday());
    expect(saleable(db, PISTON)).toBe(3);
  });

  it('today, said outright, behaves exactly as left out', async () => {
    const { service, db } = shelf();
    await service.create(
      order(piston(12), { orderedOn: businessToday(), confirm: true }),
      'actor-1',
    );
    expect(saleable(db, PISTON)).toBe(3);
  });

  it('a back-dated sale draws only what existed by its day, oldest first — never the later batch', async () => {
    const { service, db } = shelf();
    // Two early batches: 5 at 20 days ago (batch-0) and 3 at 15 days ago.
    db.store.batches[0].saleableQty = D(2);
    db.store.batches.push({
      id: 'batch-middle',
      productId: PISTON,
      verificationStatus: 'VERIFIED',
      saleableQty: D(3),
      remainingQty: D(3),
      landedUnitCostEgp: D(150),
      createdAt: instantOfDay(daysAgo(15)),
    });
    await service.create(
      order(piston(5), { orderedOn: daysAgo(10), confirm: true }),
      'actor-1',
    );
    expect(
      db.store.allocations.map((a) => [a.inventoryBatchId, Number(a.qty)]),
    ).toEqual([
      ['batch-0', 2],
      ['batch-middle', 3],
    ]);

    // Everything that existed ten days ago is gone; the later batch cannot
    // stand in for it.
    const r = await refused(
      service.create(
        order(piston(1), { orderedOn: daysAgo(10), confirm: true }),
        'actor-1',
      ),
    );
    expect(r).toEqual({ status: 400, code: 'NOT_ENOUGH_STOCK_ON_DATE' });
    const later = db.store.batches.find((b) => b.id === 'batch-later');
    expect(Number(later.saleableQty)).toBe(10);

    // Today it can.
    await service.create(order(piston(1), { confirm: true }), 'actor-1');
    expect(Number(later.saleableQty)).toBe(9);
  });

  it('more than had arrived by that day → NOT_ENOUGH_STOCK_ON_DATE naming the day and what there was; nothing saved', async () => {
    const { service, db } = shelf();
    const r = await codeAndParams(
      service.create(
        order(piston(8), { orderedOn: daysAgo(10), confirm: true }),
        'actor-1',
      ),
    );
    expect(r).toMatchObject({
      status: 400,
      code: 'NOT_ENOUGH_STOCK_ON_DATE',
      params: {
        product: 'Piston kit',
        day: daysAgo(10),
        available: '5.000',
        wanted: '8.000',
      },
    });
    expect(db.store.orders).toHaveLength(0);
    expect(saleable(db, PISTON)).toBe(15);
  });

  it('a back-dated draft is refused at creation too — the same check as Create & confirm', async () => {
    const { service, db } = shelf();
    const r = await refused(
      service.create(order(piston(6), { orderedOn: daysAgo(10) }), 'actor-1'),
    );
    expect(r).toEqual({ status: 400, code: 'NOT_ENOUGH_STOCK_ON_DATE' });
    expect(db.store.orders).toHaveLength(0);
  });

  it('a day before any stock arrived → refused, even with a full shelf today', async () => {
    const { service } = shelf();
    const r = await refused(
      service.create(
        order(piston(1), { orderedOn: daysAgo(30), confirm: true }),
        'actor-1',
      ),
    );
    expect(r).toEqual({ status: 400, code: 'NOT_ENOUGH_STOCK_ON_DATE' });
  });

  it('the edges of the day: received at its last instant counts, at the first instant of the next does not', async () => {
    const { service, db } = build({ [PISTON]: 1 });
    const day = daysAgo(5);
    db.store.batches[0].createdAt = new Date(
      endOfBusinessDay(day).getTime() - 1,
    );
    db.store.batches.push({
      id: 'batch-next-day',
      productId: PISTON,
      verificationStatus: 'VERIFIED',
      saleableQty: D(1),
      remainingQty: D(1),
      landedUnitCostEgp: D(100),
      createdAt: endOfBusinessDay(day),
    });
    await service.create(
      order(piston(1), { orderedOn: day, confirm: true }),
      'actor-1',
    );
    expect(db.store.allocations.map((a) => a.inventoryBatchId)).toEqual([
      'batch-0',
    ]);
    const r = await refused(
      service.create(
        order(piston(1), { orderedOn: day, confirm: true }),
        'actor-1',
      ),
    );
    expect(r.code).toBe('NOT_ENOUGH_STOCK_ON_DATE');
  });

  it('a day that has not arrived → DATE_IN_FUTURE; nothing saved', async () => {
    const { service, db } = shelf();
    const tomorrow = new Date(
      Date.parse(`${businessToday()}T00:00:00Z`) + 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const r = await refused(
      service.create(
        order(piston(1), { orderedOn: tomorrow, confirm: true }),
        'actor-1',
      ),
    );
    expect(r).toEqual({ status: 400, code: 'DATE_IN_FUTURE' });
    expect(db.store.orders).toHaveLength(0);
  });

  it.each(['2026-02-30', '16/10/2026', 'yesterday', 20261001])(
    'a day that is not a date (%p) → BAD_DATE, never a 500',
    async (orderedOn) => {
      const { service, db } = shelf();
      const r = await refused(
        service.create(
          order(piston(1), { orderedOn, confirm: true }),
          'actor-1',
        ),
      );
      expect(r).toEqual({ status: 400, code: 'BAD_DATE' });
      expect(db.store.orders).toHaveLength(0);
    },
  );

  it('the second visit: a back-dated draft confirmed later still draws only from its own day', async () => {
    const { service, db } = shelf();
    const draft: any = await service.create(
      order(piston(5), { orderedOn: daysAgo(10) }),
      'actor-1',
    );
    // Someone sold most of the early batch in between; the later one cannot
    // stand in for it.
    db.store.batches[0].saleableQty = D(2);
    const r = await codeAndParams(
      service.confirmOrder(draft.data.id, 'actor-1', 1),
    );
    expect(r).toMatchObject({
      code: 'NOT_ENOUGH_STOCK_ON_DATE',
      params: { day: daysAgo(10), available: '2.000', wanted: '5.000' },
    });
    expect(db.store.allocations).toHaveLength(0);
  });

  it('a draft saved for its own day and confirmed days later is not back-dated: it draws later stock as before', async () => {
    const { service, db } = shelf();
    const draft: any = await service.create(order(piston(12)), 'actor-1');
    // Saved three days ago, for that day.
    const row = db.store.orders[0];
    row.createdAt = instantOfDay(daysAgo(3));
    row.orderedAt = instantOfDay(daysAgo(3));
    const res: any = await service.confirmOrder(draft.data.id, 'actor-1', 1);
    expect(res.data.status).toBe('CONFIRMED');
    expect(saleable(db, PISTON)).toBe(3);
  });

  it('the price check of a back-dated sale costs what that day could draw', async () => {
    const { service } = shelf();
    // Ten days ago there were five: a sixth was not on the shelf, so the line
    // is not costed (confirming would refuse it).
    const back: any = await service.priceCheck({
      currency: 'EGP',
      orderedOn: daysAgo(10),
      items: [{ productId: PISTON, quantity: 6, unitPrice: 150 }],
    });
    expect(back.data.lines[0]).toMatchObject({ costed: false });
    // Today the sixth comes from the later batch at 200.
    const today: any = await service.priceCheck({
      currency: 'EGP',
      items: [{ productId: PISTON, quantity: 6, unitPrice: 150 }],
    });
    expect(today.data.lines[0]).toMatchObject({ costEgp: '700.00' });
  });
});
