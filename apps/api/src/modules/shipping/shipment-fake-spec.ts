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

  const prisma: Row = {
    importCycle: {
      findUnique: ({ where, select, include }: Row) => {
        const c = db.cycles.find((x) => x.id === where.id);
        if (!c) return after(null);
        return after(select || include ? fullCycle(c) : c);
      },
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
        const legIds = new Set(
          db.legs
            .filter((l) => l.cycleId === where.leg.cycleId)
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
    const tx: Row = {
      ...prisma,
      $queryRaw: async (_sql: TemplateStringsArray, cycleId: string) => {
        while (locks.has(cycleId)) await locks.get(cycleId);
        let release!: () => void;
        locks.set(cycleId, new Promise<void>((r) => (release = r)));
        db.locksTaken += 1;
        held.push(() => {
          locks.delete(cycleId);
          release();
        });
        return [];
      },
    };
    try {
      return await fn(tx);
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
