import { randomUUID } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type the fake stores money in, not data access
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * An in-memory database answering only the queries the shipping, delivery,
 * costing and cycle-gate code make — for `deliveries.service.spec.ts`.
 *
 * Every read hands back copies, so a caller holding an old read really does
 * hold old data: that is what lets the race test fail without the lock.
 *
 * `$queryRaw` is the row lock: the first transaction to ask for a cycle holds
 * it until its callback finishes, and any other waits — what Postgres does
 * with `SELECT … FOR UPDATE`. Every method yields (`await`), so two calls run
 * with `Promise.all` genuinely interleave.
 *
 * Named `-spec.ts` so the build leaves it out (`**\/*spec.ts`) while jest,
 * which runs `.spec.ts`, does not mistake it for a suite.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- a test double for Prisma's untyped argument objects */

export type Row = Record<string, any>;

export const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export interface Store {
  cycles: Row[];
  legs: Row[];
  orders: Row[];
  items: Row[];
  products: Row[];
  deliveries: Row[];
  losses: Row[];
  batches: Row[];
  participants: Row[];
  /** B3: receipts, the ledger, and the sales and settlements that read them. */
  movements: Row[];
  ledger: Row[];
  customers: Row[];
  saleOrders: Row[];
  saleItems: Row[];
  allocations: Row[];
  settlements: Row[];
  /** How many times the lock was taken, so a test can see it was. */
  locksTaken: number;
}

export function emptyStore(): Store {
  return {
    cycles: [],
    legs: [],
    orders: [],
    items: [],
    products: [],
    deliveries: [],
    losses: [],
    batches: [],
    participants: [],
    movements: [],
    ledger: [],
    customers: [],
    saleOrders: [],
    saleItems: [],
    allocations: [],
    settlements: [],
    locksTaken: 0,
  };
}

/** A deep copy. Decimals are immutable and kept; dates are copied. */
function copy<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Prisma.Decimal.isDecimal(v)) return v;
  if (v instanceof Date) return new Date(v.getTime()) as T;
  if (Array.isArray(v)) return v.map(copy) as T;
  return Object.fromEntries(
    Object.entries(v as Row).map(([k, x]) => [k, copy(x)]),
  ) as T;
}
const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * Put the store back as `snapshot` had it — keeping each row object a test may
 * hold (a fixture's `cycle`), so a test that changes it after a rollback
 * changes the row the fake reads.
 */
function restore(db: Store, snapshot: Store) {
  for (const key of Object.keys(snapshot) as (keyof Store)[]) {
    if (!Array.isArray(snapshot[key])) continue;
    const current = new Map((db[key] as Row[]).map((r) => [r.id, r]));
    const rows = (snapshot[key] as Row[]).map((saved) => {
      const live = saved.id !== undefined ? current.get(saved.id) : undefined;
      if (!live) return saved;
      for (const k of Object.keys(live)) delete live[k];
      return Object.assign(live, saved);
    });
    (db[key] as Row[]).length = 0;
    (db[key] as Row[]).push(...rows);
  }
}

export function fakePrisma(db: Store) {
  const legsOf = (cycleId: string) =>
    db.legs
      .filter((l) => l.cycleId === cycleId)
      .sort((a, b) => a.sequence - b.sequence);

  const fullCycle = (c: Row) => ({
    ...c,
    shippingLegs: legsOf(c.id).map((l) => ({
      ...l,
      deliveries: db.deliveries.filter((d) => d.legId === l.id),
      losses: db.losses.filter((x) => x.legId === l.id),
    })),
    purchaseOrders: db.orders
      .filter((o) => o.cycleId === c.id)
      .map((o) => ({
        ...o,
        items: db.items
          .filter((i) => i.purchaseOrderId === o.id)
          .map((i) => ({
            ...i,
            product: db.products.find((p) => p.id === i.productId),
          })),
      })),
    inventoryBatches: db.batches.filter((b) => b.cycleId === c.id),
  });

  const after = async <T>(v: T): Promise<T> => {
    await tick();
    return copy(v);
  };

  const REALISED = ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'];
  const realised = (a: Row) => {
    const item = db.saleItems.find((i) => i.id === a.saleItemId)!;
    const order = db.saleOrders.find((o) => o.id === item.saleOrderId)!;
    return REALISED.includes(order.status);
  };
  const ledgerMatches = (t: Row, where: Row = {}) =>
    (where.cycleId === undefined || t.cycleId === where.cycleId) &&
    (where.direction === undefined || t.direction === where.direction) &&
    (where.category?.in === undefined ||
      where.category.in.includes(t.category)) &&
    (where.category?.notIn === undefined ||
      !where.category.notIn.includes(t.category));
  const decrement = (current: Prisma.Decimal, change: any) =>
    change?.decrement !== undefined
      ? current.sub(change.decrement)
      : change === undefined
        ? current
        : D(change);
  const orderWithItems = (order: Row | undefined, include: Row | undefined) => {
    if (!order) return null;
    const out: Row = { ...order };
    if (include?.items) {
      out.items = db.saleItems
        .filter((i) => i.saleOrderId === order.id)
        .map((i) => ({
          ...i,
          product: db.products.find((p) => p.id === i.productId),
        }));
    }
    if (include?.customer) {
      out.customer = db.customers.find((c) => c.id === order.customerId);
    }
    return out;
  };

  const prisma: Row = {
    importCycle: {
      findUnique: ({ where, select, include }: Row) => {
        const c = db.cycles.find((x) => x.id === where.id);
        if (!c) return after(null);
        return after(select || include ? fullCycle(c) : c);
      },
      update: ({ where, data }: Row) => {
        const c = db.cycles.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data))
          if (v !== undefined) c[k] = v;
        return after(c);
      },
      // Analytics' cycle profitability: the shape it selects, no more.
      findMany: () =>
        after(
          db.cycles.map((c) => ({
            ...c,
            financialTransactions: db.ledger.filter((t) => t.cycleId === c.id),
            inventoryBatches: db.batches
              .filter((b) => b.cycleId === c.id)
              .map((b) => ({
                ...b,
                saleItemAllocations: db.allocations
                  .filter((a) => a.inventoryBatchId === b.id && realised(a))
                  .map((a) => ({
                    ...a,
                    saleItem: db.saleItems.find((i) => i.id === a.saleItemId),
                  })),
                returnItems: [],
              })),
          })),
        ),
    },
    purchaseOrderItem: {
      findUnique: ({ where }: Row) =>
        after(db.items.find((i) => i.id === where.id) ?? null),
      update: ({ where, data }: Row) => {
        const i = db.items.find((x) => x.id === where.id)!;
        Object.assign(i, data);
        return after(i);
      },
    },
    inventoryBatch: {
      create: ({ data }: Row) => {
        const row = {
          id: randomUUID(),
          createdAt: new Date(),
          reservedQty: D(0),
          ...data,
          receivedQty: D(data.receivedQty),
          remainingQty: D(data.remainingQty),
          saleableQty: D(data.saleableQty),
          landedUnitCostEgp: D(data.landedUnitCostEgp),
        };
        db.batches.push(row);
        return after(row);
      },
      aggregate: ({ where }: Row) =>
        after({
          _sum: where.sourcePoItemId
            ? {
                receivedQty: db.batches
                  .filter((b) => b.sourcePoItemId === where.sourcePoItemId)
                  .reduce((t, b) => t.add(b.receivedQty), D(0)),
              }
            : {
                saleableQty: db.batches
                  .filter((b) => b.productId === where.productId)
                  .reduce((t, b) => t.add(b.saleableQty), D(0)),
              },
        }),
      groupBy: ({ where }: Row) =>
        after(
          (where.productId.in as string[])
            .map((productId) => {
              const rows = db.batches.filter(
                (b) =>
                  b.productId === productId &&
                  b.verificationStatus === 'VERIFIED',
              );
              if (rows.length === 0) return null;
              return {
                productId,
                _sum: {
                  saleableQty: rows.reduce(
                    (t, b) => t.add(b.saleableQty),
                    D(0),
                  ),
                },
              };
            })
            .filter(Boolean),
        ),
      // FIFO (sales: sellable, oldest receipt first), or a plain filter by
      // product and/or cycle (settlement's unsold stock, the inventory read).
      findMany: ({ where = {}, include }: Row) =>
        after(
          where.verificationStatus
            ? db.batches
                .filter(
                  (b) =>
                    b.productId === where.productId &&
                    b.verificationStatus === 'VERIFIED' &&
                    b.saleableQty.gt(0),
                )
                .sort(
                  (a, b) =>
                    a.createdAt.getTime() - b.createdAt.getTime() ||
                    (a.id < b.id ? -1 : 1),
                )
            : db.batches
                .filter(
                  (b) =>
                    (!where.cycleId || b.cycleId === where.cycleId) &&
                    (!where.productId || b.productId === where.productId),
                )
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                .map((b) =>
                  include
                    ? {
                        ...b,
                        product: db.products.find((p) => p.id === b.productId),
                        cycle: {
                          ...db.cycles.find((c) => c.id === b.cycleId),
                          shippingLegs: legsOf(b.cycleId),
                        },
                      }
                    : b,
                ),
        ),
      update: ({ where, data }: Row) => {
        const b = db.batches.find((x) => x.id === where.id)!;
        b.saleableQty = decrement(b.saleableQty, data.saleableQty);
        b.remainingQty = decrement(b.remainingQty, data.remainingQty);
        return after(b);
      },
    },
    inventoryReservation: { findMany: () => after([]) },
    inventoryMovement: {
      create: ({ data }: Row) => {
        db.movements.push({ id: randomUUID(), ...data });
        return after(data);
      },
    },
    financialTransaction: {
      create: ({ data }: Row) => {
        const row = { id: randomUUID(), ...data, amount: D(data.amount) };
        db.ledger.push(row);
        return after(row);
      },
      findMany: ({ where }: Row) =>
        after(db.ledger.filter((t) => ledgerMatches(t, where))),
      aggregate: ({ where }: Row) =>
        after({
          _sum: {
            amount: db.ledger
              .filter((t) => ledgerMatches(t, where))
              .reduce((s, t) => s.add(t.amount), D(0)),
          },
        }),
    },
    product: {
      findUnique: ({ where }: Row) =>
        after(db.products.find((p) => p.id === where.id) ?? null),
    },
    user: { findMany: () => after([]) },
    customer: {
      findUnique: ({ where }: Row) =>
        after(db.customers.find((c) => c.id === where.id) ?? null),
    },
    saleOrder: {
      findFirst: ({ where }: Row) => {
        const prefix = where?.orderNo?.startsWith ?? '';
        const rows = db.saleOrders
          .filter((o) => String(o.orderNo).startsWith(prefix))
          .sort((a, b) => (a.orderNo < b.orderNo ? 1 : -1));
        return after(rows[0] ? { orderNo: rows[0].orderNo } : null);
      },
      findUnique: ({ where, include }: Row) =>
        after(
          orderWithItems(
            db.saleOrders.find((o) => o.id === where.id),
            include,
          ),
        ),
      create: ({ data, include }: Row) => {
        const { items, ...rest } = data;
        const order = {
          id: randomUUID(),
          version: 1,
          ...rest,
          subtotal: D(rest.subtotal),
          total: D(rest.total),
          outstanding: D(rest.outstanding),
        };
        db.saleOrders.push(order);
        for (const it of items.create) {
          db.saleItems.push({
            id: randomUUID(),
            saleOrderId: order.id,
            ...it,
            quantity: D(it.quantity),
            unitPrice: D(it.unitPrice),
            discount: D(it.discount ?? 0),
            lineTotal: D(it.lineTotal),
          });
        }
        return after(orderWithItems(order, include));
      },
      update: ({ where, data, include }: Row) => {
        const order = db.saleOrders.find(
          (o) =>
            o.id === where.id &&
            (where.version === undefined || o.version === where.version),
        )!;
        order.status = data.status ?? order.status;
        if (data.version?.increment) order.version += data.version.increment;
        return after(orderWithItems(order, include));
      },
    },
    saleItemAllocation: {
      create: ({ data }: Row) => {
        const row = { id: randomUUID(), ...data };
        db.allocations.push(row);
        return after(row);
      },
      findMany: ({ where }: Row) =>
        after(
          db.allocations
            .filter(
              (a) =>
                db.batches.find((b) => b.id === a.inventoryBatchId)?.cycleId ===
                  where.inventoryBatch.cycleId && realised(a),
            )
            .map((a) => ({
              ...a,
              saleItem: db.saleItems.find((i) => i.id === a.saleItemId),
            })),
        ),
    },
    saleReturnItem: { findMany: () => after([]) },
    settlement: {
      findFirst: ({ where }: Row) =>
        after(
          db.settlements.find(
            (x) =>
              x.cycleId === where.cycleId && where.status.in.includes(x.status),
          ) ?? null,
        ),
      findUnique: ({ where }: Row) =>
        after(db.settlements.find((x) => x.id === where.id) ?? null),
      findMany: ({ where }: Row) =>
        after(
          db.settlements.filter(
            (x) => x.cycleId === where.cycleId && x.status === where.status,
          ),
        ),
      create: ({ data }: Row) => {
        const row = { id: randomUUID(), ...data };
        db.settlements.push(row);
        return after(row);
      },
      update: ({ where, data }: Row) => {
        const x = db.settlements.find((r) => r.id === where.id)!;
        Object.assign(x, data);
        return after(x);
      },
      deleteMany: () => after({ count: 0 }),
    },
    settlementLine: {
      create: ({ data }: Row) => after(data),
      deleteMany: () => after({ count: 0 }),
    },
    shippingLeg: {
      findUnique: ({ where }: Row) =>
        after(
          db.legs.find((l) =>
            where.id
              ? l.id === where.id
              : l.cycleId === where.cycleId_sequence.cycleId &&
                l.sequence === where.cycleId_sequence.sequence,
          ) ?? null,
        ),
      findUniqueOrThrow: ({ where }: Row) =>
        after(db.legs.find((l) => l.id === where.id)!),
      findMany: ({ where }: Row) =>
        after(
          legsOf(where.cycleId).map((l) => ({
            ...l,
            _count: {
              deliveries: db.deliveries.filter((d) => d.legId === l.id).length,
            },
          })),
        ),
      create: ({ data }: Row) => {
        const row = { id: randomUUID(), arrivedOn: null, ...data };
        db.legs.push(row);
        return after(row);
      },
      update: ({ where, data }: Row) => {
        const l = db.legs.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data))
          if (v !== undefined) l[k] = v;
        return after(l);
      },
    },
    shipmentDelivery: {
      create: ({ data }: Row) => {
        const id = randomUUID();
        const row = {
          id,
          legId: data.legId,
          arrivedOn: data.arrivedOn,
          note: data.note,
          createdBy: data.createdBy,
          lines: data.lines.create.map((l: Row) => ({
            id: randomUUID(),
            deliveryId: id,
            purchaseOrderItemId: l.purchaseOrderItemId,
            qty: D(l.qty),
          })),
        };
        db.deliveries.push(row);
        return after(row);
      },
      findUnique: ({ where }: Row) => {
        const d = db.deliveries.find((x) => x.id === where.id);
        if (!d) return after(null);
        const leg = db.legs.find((l) => l.id === d.legId)!;
        return after({ ...d, leg: { cycleId: leg.cycleId } });
      },
      delete: ({ where }: Row) => {
        const i = db.deliveries.findIndex((x) => x.id === where.id);
        const [row] = db.deliveries.splice(i, 1);
        return after(row);
      },
    },
    shipmentLoss: {
      create: ({ data }: Row) => {
        const row = {
          id: randomUUID(),
          createdAt: new Date(),
          ...data,
          qty: D(data.qty),
          unitCostEgp: D(data.unitCostEgp),
          costEgp: D(data.costEgp),
        };
        db.losses.push(row);
        return after(row);
      },
      findUnique: ({ where }: Row) => {
        const x = db.losses.find((l) => l.id === where.id);
        if (!x) return after(null);
        const leg = db.legs.find((l) => l.id === x.legId)!;
        return after({ ...x, leg: { cycleId: leg.cycleId } });
      },
      delete: ({ where }: Row) => {
        const i = db.losses.findIndex((x) => x.id === where.id);
        const [row] = db.losses.splice(i, 1);
        return after(row);
      },
      aggregate: ({ where }: Row) => {
        // `{}` is every cycle (the dashboard); `{ leg: { cycleId } }` one.
        const legIds = new Set(
          db.legs
            .filter((l) => !where.leg || l.cycleId === where.leg.cycleId)
            .map((l) => l.id),
        );
        const rows = db.losses.filter((x) => legIds.has(x.legId));
        return after({
          _sum: {
            costEgp: rows.length
              ? rows.reduce((s, x) => s.add(x.costEgp), D(0))
              : null,
          },
        });
      },
    },
    cycleParticipant: {
      findMany: ({ where }: Row) =>
        after(db.participants.filter((p) => p.cycleId === where.cycleId)),
    },
    purchaseOrder: { findMany: () => after([]) },
  };

  const locks = new Map<string, Promise<void>>();
  prisma.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
    const held: (() => void)[] = [];
    // Rolled back on a throw, as Postgres does. Snapshotted once the lock is
    // held, so a transaction that waited sees — and on failure restores —
    // what the one before it committed, not what was there when it began.
    let snapshot: Store | null = null;
    const tx: Row = {
      ...prisma,
      $queryRaw: async (_sql: TemplateStringsArray, cycleId: string) => {
        while (locks.has(cycleId)) await locks.get(cycleId);
        let release!: () => void;
        locks.set(cycleId, new Promise<void>((r) => (release = r)));
        db.locksTaken += 1;
        snapshot ??= copy(db);
        held.push(() => {
          locks.delete(cycleId);
          release();
        });
        return [];
      },
    };
    try {
      return await fn(tx);
    } catch (e) {
      if (snapshot) restore(db, snapshot);
      throw e;
    } finally {
      for (const h of held) h();
    }
  };
  return prisma as unknown as PrismaService;
}

// ─── Building states the business recognises (CLAUDE.md rule 4) ──────────

let codes = 0;

/** A cycle with its order: `lines` are [product name, ordered, unit price]. */
export function cycleWithOrder(
  db: Store,
  opts: {
    status?: string;
    originType?: 'CHINA' | 'UAE_DIRECT';
    lines?: [string, number, number][];
  } = {},
) {
  const cycle = {
    id: randomUUID(),
    code: `CYC-2026-${String(++codes).padStart(4, '0')}`,
    status: opts.status ?? 'IN_TRANSIT',
    originType: opts.originType ?? 'UAE_DIRECT',
  };
  db.cycles.push(cycle);
  const po = { id: randomUUID(), cycleId: cycle.id, fxRateToEgp: D(1) };
  db.orders.push(po);
  const items = (opts.lines ?? [['Brake pad', 40, 100]]).map(
    ([name, qty, price]) => {
      const product = { id: randomUUID(), name, unitWeightKg: null };
      db.products.push(product);
      const item = {
        id: randomUUID(),
        purchaseOrderId: po.id,
        productId: product.id,
        orderedQty: D(qty),
        receivedQty: null,
        unitPrice: D(price),
        lineTotal: D(qty).mul(price),
      };
      db.items.push(item);
      return item;
    },
  );
  return { cycle, items };
}

/** A FLAT leg costing `amountEgp`, departed on `departedOn` (or not at all). */
export function addLeg(
  db: Store,
  cycle: Row,
  sequence: number,
  opts: { departedOn?: string | null; amountEgp?: number } = {},
) {
  const leg = {
    id: randomUUID(),
    cycleId: cycle.id,
    sequence,
    origin:
      sequence === 1 && cycle.originType === 'CHINA'
        ? 'Guangzhou, CN'
        : 'Dubai, UAE',
    destination:
      sequence === 1 && cycle.originType === 'CHINA'
        ? 'Dubai, UAE'
        : 'Cairo, Egypt',
    departedOn:
      opts.departedOn === null
        ? null
        : new Date(`${opts.departedOn ?? '2026-09-01'}T00:00:00Z`),
    arrivedOn: null,
    status: opts.departedOn === null ? 'PENDING' : 'IN_TRANSIT',
    costBasis: 'FLAT',
    ratePerUnit: null,
    chargeablePieces: null,
    chargeableWeightKg: null,
    currency: 'EGP',
    fxRateToEgp: D(1),
    amount: D(opts.amountEgp ?? 400),
    amountEgp: D(opts.amountEgp ?? 400),
  };
  db.legs.push(leg);
  return leg;
}

/** A batch received from a delivery line — what B3's receipt writes. */
export function receive(db: Store, cycle: Row, deliveryLine: Row, qty: number) {
  db.batches.push({
    id: randomUUID(),
    cycleId: cycle.id,
    sourcePoItemId: deliveryLine.purchaseOrderItemId,
    sourceDeliveryLineId: deliveryLine.id,
    receivedQty: D(qty),
    landedUnitCostEgp: D(110),
  });
}
