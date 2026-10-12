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
  /** L8: departures, each with its lines inline, as deliveries are. */
  departures: Row[];
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
  /** B5: refunds, and who can pay them. */
  refunds: Row[];
  suppliers: Row[];
  providers: Row[];
  /** L5: leftovers moved between cycles, and holds on batches. */
  transfers: Row[];
  transferLines: Row[];
  holds: Row[];
  users: Row[];
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
    departures: [],
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
    refunds: [],
    suppliers: [],
    providers: [],
    transfers: [],
    transferLines: [],
    holds: [],
    users: [],
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
      departures: departuresOf(l.id),
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

  // In the order they left, then the order they were recorded — the select
  // `loadShipment` sends.
  const departuresOf = (legId: string) =>
    db.departures
      .filter((d) => d.legId === legId)
      .sort(
        (a, b) =>
          a.departedOn.getTime() - b.departedOn.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      );

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
    (where.relatedType === undefined || t.relatedType === where.relatedType) &&
    (where.relatedId === undefined || t.relatedId === where.relatedId) &&
    (where.type === undefined || t.type === where.type) &&
    (where.reversalOfId === undefined ||
      (where.reversalOfId === null
        ? t.reversalOfId == null
        : t.reversalOfId === where.reversalOfId)) &&
    (where.direction === undefined || t.direction === where.direction) &&
    (where.category?.in === undefined ||
      where.category.in.includes(t.category)) &&
    (where.category?.notIn === undefined ||
      !where.category.notIn.includes(t.category));
  // B5b: the refund filters the services use — un-reversed (`reversedAt:
  // null`), reversed (`{ not: null }`), by loss, by id.
  const refundMatches = (r: Row, where: Row = {}) =>
    (where.id === undefined ||
      (typeof where.id === 'string'
        ? r.id === where.id
        : where.id.in.includes(r.id))) &&
    (where.shipmentLossId === undefined ||
      (typeof where.shipmentLossId === 'string'
        ? r.shipmentLossId === where.shipmentLossId
        : where.shipmentLossId.in.includes(r.shipmentLossId))) &&
    (where.reversedAt === undefined ||
      (where.reversedAt === null
        ? r.reversedAt == null
        : r.reversedAt != null));
  const decrement = (current: Prisma.Decimal, change: any) =>
    change?.decrement !== undefined
      ? current.sub(change.decrement)
      : change?.increment !== undefined
        ? current.add(change.increment)
        : change === undefined
          ? current
          : D(change);
  // L5: a batch as the transfer's include reads it, with its history counted.
  const countsOf = (batchId: string) => ({
    saleItemAllocations: db.allocations.filter(
      (a) => a.inventoryBatchId === batchId,
    ).length,
    reservations: db.holds.filter((h) => h.batchId === batchId).length,
    returnItems: 0,
    transferLinesOut: db.transferLines.filter(
      (l) =>
        l.sourceBatchId === batchId &&
        db.transfers.find((t) => t.id === l.transferId)?.status === 'ACTIVE',
    ).length,
  });
  const person = (id: string | null) => {
    if (!id) return null;
    return { id, email: `${id.slice(0, 8)}@example.com`, partner: null };
  };
  const shapedTransfer = (t: Row | undefined) => {
    if (!t) return null;
    const cycle = (id: string) => {
      const c = db.cycles.find((x) => x.id === id)!;
      return { id: c.id, code: c.code, status: c.status };
    };
    return {
      ...t,
      fromCycle: cycle(t.fromCycleId),
      toCycle: cycle(t.toCycleId),
      actor: person(t.createdBy),
      reverser: person(t.reversedBy ?? null),
      lines: db.transferLines
        .filter((l) => l.transferId === t.id)
        .map((l) => {
          const dest = db.batches.find((b) => b.id === l.destBatchId);
          return {
            ...l,
            product: db.products.find((p) => p.id === l.productId),
            destBatch: dest ? { ...dest, _count: countsOf(dest.id) } : null,
          };
        }),
    };
  };
  const qtyMatches = (v: Prisma.Decimal, cond: any) => {
    if (cond === undefined) return true;
    if (Prisma.Decimal.isDecimal(cond) || typeof cond !== 'object') {
      return v.eq(cond);
    }
    return (
      (cond.gt === undefined || v.gt(cond.gt)) &&
      (cond.gte === undefined || v.gte(cond.gte))
    );
  };
  const batchMatches = (b: Row, where: Row = {}) =>
    (where.id === undefined ||
      (typeof where.id === 'string'
        ? b.id === where.id
        : where.id.in.includes(b.id))) &&
    (where.cycleId === undefined || b.cycleId === where.cycleId) &&
    (where.productId === undefined || b.productId === where.productId) &&
    (where.verificationStatus === undefined ||
      b.verificationStatus === where.verificationStatus) &&
    qtyMatches(b.saleableQty, where.saleableQty) &&
    qtyMatches(b.remainingQty, where.remainingQty) &&
    (where.saleItemAllocations?.none === undefined ||
      countsOf(b.id).saleItemAllocations === 0) &&
    (where.reservations?.none === undefined ||
      countsOf(b.id).reservations === 0);
  const orderWithItems = (order: Row | undefined, include: Row | undefined) => {
    if (!order) return null;
    const out: Row = { ...order };
    if (include?.items) {
      out.items = db.saleItems
        .filter((i) => i.saleOrderId === order.id)
        .map((i) => ({
          ...i,
          product: db.products.find((p) => p.id === i.productId),
          // Cancelling a sale reads what each line drew from (L5's test).
          ...(include.items?.include?.allocations
            ? {
                allocations: db.allocations.filter(
                  (a) => a.saleItemId === i.id,
                ),
              }
            : {}),
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
                    // Sales always name the product; the transfer's shelf
                    // names the cycle instead (L5).
                    (where.productId === undefined
                      ? where.cycleId !== undefined
                      : b.productId === where.productId) &&
                    (where.cycleId === undefined ||
                      b.cycleId === where.cycleId) &&
                    b.verificationStatus === 'VERIFIED' &&
                    b.saleableQty.gt(0),
                )
                .sort(
                  (a, b) =>
                    a.createdAt.getTime() - b.createdAt.getTime() ||
                    (a.id < b.id ? -1 : 1),
                )
                .map((b) =>
                  include?.product
                    ? {
                        ...b,
                        product: db.products.find((p) => p.id === b.productId),
                      }
                    : b,
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
      // L5: the guarded take off the shelf, and removing a moved batch.
      updateMany: ({ where, data }: Row) => {
        const rows = db.batches.filter((b) => batchMatches(b, where));
        for (const b of rows) {
          b.saleableQty = decrement(b.saleableQty, data.saleableQty);
          b.remainingQty = decrement(b.remainingQty, data.remainingQty);
        }
        return after({ count: rows.length });
      },
      deleteMany: ({ where }: Row) => {
        const rows = db.batches.filter((b) => batchMatches(b, where));
        if (rows.some((b) => db.movements.some((m) => m.batchId === b.id))) {
          throw new Error('foreign key: movements still point at the batch');
        }
        for (const b of rows) db.batches.splice(db.batches.indexOf(b), 1);
        return after({ count: rows.length });
      },
    },
    // Holds on batches (L5) — none unless a test puts one in `db.holds`.
    inventoryReservation: {
      findMany: ({ where = {} }: Row = {}) =>
        after(
          db.holds.filter(
            (h) =>
              (where.status === undefined || h.status === where.status) &&
              (where.batchId?.in === undefined ||
                where.batchId.in.includes(h.batchId)),
          ),
        ),
    },
    inventoryMovement: {
      create: ({ data }: Row) => {
        db.movements.push({ id: randomUUID(), ...data });
        return after(data);
      },
      deleteMany: ({ where }: Row) => {
        const keep = db.movements.filter((m) => m.batchId !== where.batchId);
        const count = db.movements.length - keep.length;
        db.movements.length = 0;
        db.movements.push(...keep);
        return after({ count });
      },
    },
    // Leftovers moved between cycles (L5).
    stockTransfer: {
      create: ({ data }: Row) => {
        const row = {
          id: randomUUID(),
          status: 'ACTIVE',
          createdAt: new Date(),
          reversedAt: null,
          reversedBy: null,
          reversalReason: null,
          ...data,
        };
        db.transfers.push(row);
        return after(row);
      },
      findUnique: ({ where }: Row) =>
        after(shapedTransfer(db.transfers.find((t) => t.id === where.id))),
      findMany: ({ where }: Row) =>
        after(
          db.transfers
            .filter((t) =>
              where.OR.some(
                (o: Row) =>
                  (o.fromCycleId !== undefined &&
                    t.fromCycleId === o.fromCycleId) ||
                  (o.toCycleId !== undefined && t.toCycleId === o.toCycleId),
              ),
            )
            .map(shapedTransfer),
        ),
      update: ({ where, data }: Row) => {
        const t = db.transfers.find((x) => x.id === where.id)!;
        Object.assign(t, data);
        return after(t);
      },
      count: ({ where }: Row) =>
        after(
          db.transfers.filter(
            (t) =>
              (where.toCycleId === undefined ||
                t.toCycleId === where.toCycleId) &&
              (where.status === undefined || t.status === where.status),
          ).length,
        ),
    },
    stockTransferLine: {
      create: ({ data }: Row) => {
        const row = {
          id: randomUUID(),
          ...data,
          qty: D(data.qty),
          unitCostEgp: D(data.unitCostEgp),
          costEgp: D(data.costEgp),
        };
        db.transferLines.push(row);
        return after(row);
      },
      update: ({ where, data }: Row) => {
        const l = db.transferLines.find((x) => x.id === where.id)!;
        Object.assign(l, data);
        return after(l);
      },
      // `cycleTransfersInEgp`: what stands moved into a cycle.
      aggregate: ({ where }: Row) => {
        const rows = db.transferLines.filter((l) => {
          const t = db.transfers.find((x) => x.id === l.transferId)!;
          return (
            t.toCycleId === where.transfer.toCycleId &&
            t.status === where.transfer.status
          );
        });
        return after({
          _sum: {
            costEgp: rows.length
              ? rows.reduce((s, l) => s.add(l.costEgp), D(0))
              : null,
          },
        });
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
      findUnique: ({ where }: Row) =>
        after(db.ledger.find((t) => t.id === where.id) ?? null),
      // B5b: a refund's own inflow, and whether it was already reversed.
      findFirst: ({ where }: Row) =>
        after(
          db.ledger.find(
            (t) =>
              (where.relatedType === undefined ||
                t.relatedType === where.relatedType) &&
              (where.relatedId === undefined ||
                t.relatedId === where.relatedId) &&
              (where.reversalOfId === undefined ||
                (where.reversalOfId === null
                  ? t.reversalOfId == null
                  : t.reversalOfId === where.reversalOfId)),
          ) ?? null,
        ),
      aggregate: ({ where }: Row) =>
        after({
          _sum: {
            amount: db.ledger
              .filter((t) => ledgerMatches(t, where))
              .reduce((s, t) => s.add(t.amount), D(0)),
          },
        }),
      // The dashboard's cash (common/cash-position.ts), by direction.
      groupBy: ({ where }: Row) =>
        after(
          ['INFLOW', 'OUTFLOW']
            .map((direction) => {
              const rows = db.ledger.filter(
                (t) => t.direction === direction && ledgerMatches(t, where),
              );
              return rows.length
                ? {
                    direction,
                    _sum: {
                      amount: rows.reduce((s, t) => s.add(t.amount), D(0)),
                    },
                  }
                : null;
            })
            .filter(Boolean),
        ),
    },
    product: {
      findUnique: ({ where }: Row) =>
        after(db.products.find((p) => p.id === where.id) ?? null),
      // The low-stock query (common/low-stock.ts): the filter it sends, read
      // honestly, so a product the database would not return is not returned.
      // A product with no status is ACTIVE, the schema's default.
      findMany: ({ where = {} }: Row) =>
        after(
          db.products
            .filter(
              (p) =>
                (where.status === undefined ||
                  (p.status ?? 'ACTIVE') === where.status) &&
                (where.minStock?.not !== null || p.minStock != null) &&
                (!where.id?.in || where.id.in.includes(p.id)),
            )
            .map((p) => ({
              ...p,
              status: p.status ?? 'ACTIVE',
              minStock: p.minStock ?? null,
              inventoryBatches: db.batches
                .filter((b) => b.productId === p.id)
                .map((b) => ({ remainingQty: b.remainingQty })),
            })),
        ),
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
    // Nothing is ever paid against an order in these worlds.
    paymentAllocation: {
      aggregate: () => after({ _sum: { amount: null } }),
    },
    settlement: {
      findFirst: ({ where }: Row) =>
        after(
          db.settlements.find(
            (x) =>
              x.cycleId === where.cycleId && where.status.in.includes(x.status),
          ) ?? null,
        ),
      // Paying out reads the settlement with its cycle and lines (L5's test).
      findUnique: ({ where, include }: Row) => {
        const x = db.settlements.find((r) => r.id === where.id);
        if (!x) return after(null);
        return after(
          include?.cycle
            ? {
                ...x,
                lines: [],
                cycle: db.cycles.find((c) => c.id === x.cycleId),
              }
            : x,
        );
      },
      findMany: ({ where }: Row) =>
        after(
          db.settlements.filter(
            (x) =>
              x.cycleId === where.cycleId &&
              (where.status?.in
                ? where.status.in.includes(x.status)
                : x.status === where.status),
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
    shipmentDeparture: {
      create: ({ data }: Row) => {
        const id = randomUUID();
        const row = {
          id,
          legId: data.legId,
          departedOn: data.departedOn,
          note: data.note,
          createdBy: data.createdBy,
          createdAt: new Date(Date.now() + db.departures.length),
          lines: data.lines.create.map((l: Row) => ({
            id: randomUUID(),
            departureId: id,
            purchaseOrderItemId: l.purchaseOrderItemId,
            qty: D(l.qty),
          })),
        };
        db.departures.push(row);
        return after(row);
      },
      findUnique: ({ where }: Row) => {
        const d = db.departures.find((x) => x.id === where.id);
        if (!d) return after(null);
        const leg = db.legs.find((l) => l.id === d.legId)!;
        return after({ ...d, leg: { cycleId: leg.cycleId } });
      },
      findMany: ({ where }: Row) =>
        after(departuresOf(where.legId).map((d) => ({ id: d.id }))),
      update: ({ where, data }: Row) => {
        const d = db.departures.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data))
          if (v !== undefined) d[k] = v;
        return after(d);
      },
      delete: ({ where }: Row) => {
        const i = db.departures.findIndex((x) => x.id === where.id);
        const [row] = db.departures.splice(i, 1);
        return after(row);
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
    // No friend paid for anything in these worlds (§18): nothing owed,
    // nothing financed, no exchange difference.
    lenderFinancing: {
      count: () => Promise.resolve(0),
      findMany: () => Promise.resolve([]),
      aggregate: () => Promise.resolve({ _sum: { amountEgp: null } }),
    },
    lenderRepayment: {
      aggregate: () => Promise.resolve({ _sum: { exchangeDiffEgp: null } }),
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
      // Every shape asked for at once: the leg, the order line with its
      // product, and the refunds on the loss (B5).
      findUnique: ({ where, select, include }: Row) => {
        const x = db.losses.find((l) => l.id === where.id);
        if (!x) return after(null);
        const leg = db.legs.find((l) => l.id === x.legId)!;
        const item = db.items.find((i) => i.id === x.purchaseOrderItemId)!;
        return after({
          ...x,
          leg: { ...leg, cycleId: leg.cycleId },
          purchaseOrderItem: {
            ...item,
            product: db.products.find((p) => p.id === item.productId),
          },
          refunds: db.refunds.filter(
            (r) =>
              r.shipmentLossId === x.id &&
              refundMatches(
                r,
                select?.refunds?.where ?? include?.refunds?.where,
              ),
          ),
        });
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
    purchaseOrder: {
      // Only the status-filtered read leaving PURCHASING makes (L3): which of
      // the cycle's orders are still drafts. Every other read sees none, as
      // before — a fixture's order carries a status only when a test sets one.
      findMany: ({ where = {} }: Row = {}) =>
        after(
          where.status === undefined
            ? []
            : db.orders
                .filter(
                  (o) =>
                    o.status === where.status &&
                    (where.cycleId === undefined ||
                      o.cycleId === where.cycleId) &&
                    (where.id?.in === undefined || where.id.in.includes(o.id)),
                )
                .map((o) => ({
                  ...o,
                  _count: {
                    items: db.items.filter((i) => i.purchaseOrderId === o.id)
                      .length,
                  },
                  supplier: db.suppliers.find((x) => x.id === o.supplierId),
                })),
        ),
      updateMany: ({ where, data }: Row) => {
        const rows = db.orders.filter(
          (o) => o.cycleId === where.cycleId && o.status === where.status,
        );
        for (const o of rows) Object.assign(o, data);
        return after({ count: rows.length });
      },
      findUnique: ({ where, include }: Row) => {
        const o = db.orders.find((x) => x.id === where.id);
        if (!o) return after(null);
        return after({
          ...o,
          items: db.items.filter((i) => i.purchaseOrderId === o.id),
          supplierRefunds: db.refunds.filter(
            (r) =>
              r.purchaseOrderId === o.id &&
              refundMatches(r, include?.supplierRefunds?.where),
          ),
          cycle: db.cycles.find((c) => c.id === o.cycleId),
        });
      },
    },
    supplierRefund: {
      create: ({ data }: Row) => {
        const row = {
          id: randomUUID(),
          createdAt: new Date(),
          ...data,
          amount: D(data.amount),
          fxRateToEgp: D(data.fxRateToEgp),
        };
        db.refunds.push(row);
        return after(row);
      },
      count: ({ where }: Row) =>
        after(db.refunds.filter((r) => refundMatches(r, where)).length),
      // B5b: the undo reads the refund, with its order's cycle.
      findUnique: ({ where }: Row) => {
        const r = db.refunds.find((x) => x.id === where.id);
        if (!r) return after(null);
        const order = db.orders.find((o) => o.id === r.purchaseOrderId)!;
        return after({ ...r, purchaseOrder: { cycleId: order.cycleId } });
      },
      updateMany: ({ where, data }: Row) => {
        const rows = db.refunds.filter((r) => refundMatches(r, where));
        for (const r of rows) Object.assign(r, data);
        return after({ count: rows.length });
      },
      findMany: ({ where }: Row) =>
        after(
          db.refunds
            .filter((r) => refundMatches(r, where))
            .map((r) => {
              const order = db.orders.find((o) => o.id === r.purchaseOrderId)!;
              const provider = db.providers.find(
                (p) => p.id === r.payerShippingProviderId,
              );
              return {
                ...r,
                payerShippingProvider: provider
                  ? { name: provider.name }
                  : null,
                purchaseOrder: {
                  supplier: db.suppliers.find((x) => x.id === order.supplierId),
                },
              };
            }),
        ),
    },
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
  const supplier = { id: randomUUID(), name: 'Yiwu Parts' };
  db.suppliers.push(supplier);
  const po = {
    id: randomUUID(),
    cycleId: cycle.id,
    supplierId: supplier.id,
    reference: `PO-2026-${String(codes).padStart(4, '0')}`,
    fxRateToEgp: D(1),
    /** The day it was ordered; a test that dates a departure against it sets one. */
    orderedOn: null as Date | null,
  };
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
  return { cycle, items, po, supplier };
}

/**
 * A departure of everything waiting at the leg's origin on `day` — what the
 * office app's Record departure starts at (L8). Leg 1 carries what was
 * ordered; a later leg what the leg before it has delivered, less what already
 * left on it. Writes nothing when nothing waits.
 */
export function departAll(db: Store, leg: Row, day: string) {
  const cycleLegs = db.legs
    .filter((l) => l.cycleId === leg.cycleId)
    .sort((a, b) => a.sequence - b.sequence);
  const previous = cycleLegs[cycleLegs.indexOf(leg) - 1];
  const orderIds = new Set(
    db.orders.filter((o) => o.cycleId === leg.cycleId).map((o) => o.id),
  );
  const entered = new Map<string, Prisma.Decimal>();
  if (!previous) {
    for (const i of db.items.filter((x) => orderIds.has(x.purchaseOrderId)))
      entered.set(i.id, D(i.orderedQty));
  } else {
    for (const d of db.deliveries.filter((x) => x.legId === previous.id))
      for (const l of d.lines)
        entered.set(
          l.purchaseOrderItemId,
          (entered.get(l.purchaseOrderItemId) ?? D(0)).add(l.qty),
        );
  }
  for (const d of db.departures.filter((x) => x.legId === leg.id))
    for (const l of d.lines)
      entered.set(
        l.purchaseOrderItemId,
        (entered.get(l.purchaseOrderItemId) ?? D(0)).sub(l.qty),
      );
  const lines = [...entered].filter(([, q]) => q.gt(0));
  if (lines.length === 0) return null;
  const id = randomUUID();
  const row = {
    id,
    legId: leg.id,
    departedOn: new Date(`${day}T00:00:00Z`),
    note: null,
    createdBy: null,
    createdAt: new Date(Date.now() + db.departures.length),
    lines: lines.map(([purchaseOrderItemId, qty]) => ({
      id: randomUUID(),
      departureId: id,
      purchaseOrderItemId,
      qty,
    })),
  };
  db.departures.push(row);
  if (!leg.departedOn) leg.departedOn = row.departedOn;
  return row;
}

/**
 * A FLAT leg costing `amountEgp`, departed on `departedOn` (or not at all).
 * A departed leg gets one departure of everything waiting at its origin then
 * (`departAll`) — on a later leg, only what the leg before has delivered by
 * now. A later leg added "departed" before anything reached its origin has no
 * departure: depart it with `departAll` once the goods are there.
 */
export function addLeg(
  db: Store,
  cycle: Row,
  sequence: number,
  opts: { departedOn?: string | null; amountEgp?: number } = {},
) {
  const provider = { id: randomUUID(), name: `Gulf Freight ${sequence}` };
  db.providers.push(provider);
  const leg = {
    providerId: provider.id,
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
  if (opts.departedOn !== null) {
    const departed = departAll(db, leg, opts.departedOn ?? '2026-09-01');
    if (!departed) {
      leg.departedOn = null;
      leg.status = 'PENDING';
    }
  }
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
