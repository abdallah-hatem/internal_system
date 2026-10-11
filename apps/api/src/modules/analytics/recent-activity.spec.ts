/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method -- an in-memory stand-in for Prisma answers loosely-shaped query objects; the route handler is read as a metadata key, never called */
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * The dashboard's "Recent activity".
 *
 * It read the audit log, which the demo seed — and anything else not entered
 * through the services — never writes to, so the panel was empty on a database
 * full of confirmed sales; and which does record a draft being saved, so a
 * draft showed as activity. The feed is now built from the records.
 *
 * The fake database applies the `where` it is handed — status filters, the
 * order and the take — so a service that forgot to filter drafts would see them
 * here, not have them filtered for it.
 */

const SHOP = { id: 'c1', displayName: 'Nile Motors' };
const PART = { id: 'p1', name: 'Brake pad', sku: 'BP-1' };

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([field, cond]) => {
    if (cond && typeof cond === 'object' && 'in' in cond)
      return cond.in.includes(row[field]);
    return row[field] === cond;
  });
}

function sortBy(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  const keys = (
    Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
  ).map((o) => Object.entries(o)[0] as [string, 'asc' | 'desc']);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const d = a[k].getTime() - b[k].getTime();
      if (d) return dir === 'desc' ? -d : d;
    }
    return 0;
  });
}

function table(rows: Row[]) {
  return {
    findMany: async (args: {
      where?: Row;
      orderBy?: Row | Row[];
      take?: number;
    }) =>
      sortBy(
        rows.filter((r) => matches(r, args.where)),
        args.orderBy,
      ).slice(0, args.take ?? rows.length),
  };
}

function db(data: { orders?: Row[]; payments?: Row[]; batches?: Row[] }) {
  return {
    saleOrder: table(data.orders ?? []),
    payment: table(data.payments ?? []),
    inventoryBatch: table(data.batches ?? []),
  } as unknown as PrismaService;
}

const at = (iso: string) => new Date(iso);

function order(id: string, status: string, orderedAt: string, extra: Row = {}) {
  return {
    id,
    orderNo: `SO-${id}`,
    status,
    total: 1200,
    currency: 'EGP',
    orderedAt: at(orderedAt),
    createdAt: at(orderedAt),
    customer: SHOP,
    ...extra,
  };
}

function payment(id: string, status: string, receivedOn: string) {
  return {
    id,
    status,
    amount: 500,
    currency: 'EGP',
    method: 'CASH',
    receivedOn: at(receivedOn),
    createdAt: at(receivedOn),
    customer: SHOP,
  };
}

function batch(id: string, verificationStatus: string, createdAt: string) {
  return {
    id,
    verificationStatus,
    // Stock this cycle received itself; a batch moved in from another cycle
    // (§8, L5) points at its source and is no receipt.
    transferredFromBatchId: null as string | null,
    receivedQty: 40,
    createdAt: at(createdAt),
    cycleId: 'cy1',
    product: PART,
  };
}

const feed = async (data: Parameters<typeof db>[0], limit?: number) =>
  (await new AnalyticsService(db(data)).getRecentActivity(limit)).data;

describe('Recent activity — what it lists', () => {
  it('a confirmed sale appears, with a database that has no audit rows at all', async () => {
    const items = await feed({
      orders: [order('a', 'CONFIRMED', '2026-10-01T10:00:00Z')],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'SALE',
      id: 'a',
      reference: 'SO-a',
      amount: 1200,
      customer: SHOP,
    });
  });

  it('a draft does not appear (a draft counts for nothing, §4)', async () => {
    const items = await feed({
      orders: [order('d', 'DRAFT', '2026-10-05T10:00:00Z')],
    });
    expect(items).toEqual([]);
  });

  it('confirming moves a sale from absent to present', async () => {
    const o = order('x', 'DRAFT', '2026-10-05T10:00:00Z');
    expect(await feed({ orders: [o] })).toEqual([]);
    o.status = 'CONFIRMED';
    expect((await feed({ orders: [o] })).map((i) => i.id)).toEqual(['x']);
  });

  it('a cancelled order does not appear; part-paid and paid ones do', async () => {
    const items = await feed({
      orders: [
        order('c', 'CANCELLED', '2026-10-04T10:00:00Z'),
        order('pp', 'PARTIALLY_PAID', '2026-10-03T10:00:00Z'),
        order('p', 'PAID', '2026-10-02T10:00:00Z'),
      ],
    });
    expect(items.map((i) => i.id)).toEqual(['pp', 'p']);
  });

  it('a reversed payment does not appear; a recorded one does', async () => {
    const items = await feed({
      payments: [
        payment('rev', 'REVERSED', '2026-10-04'),
        payment('ok', 'RECORDED', '2026-10-03'),
      ],
    });
    expect(items.map((i) => [i.kind, i.id])).toEqual([['PAYMENT', 'ok']]);
  });

  it('only verified stock counts as received', async () => {
    const items = await feed({
      batches: [
        batch('pending', 'PENDING', '2026-10-04T00:00:00Z'),
        batch('rejected', 'REJECTED', '2026-10-04T00:00:00Z'),
        batch('in', 'VERIFIED', '2026-10-03T00:00:00Z'),
      ],
    });
    expect(items.map((i) => [i.kind, i.id, i.quantity])).toEqual([
      ['RECEIPT', 'in', 40],
    ]);
  });

  it('leftovers moved in from another cycle are not a receipt (L5)', async () => {
    const items = await feed({
      batches: [
        {
          ...batch('moved', 'VERIFIED', '2026-10-05T00:00:00Z'),
          transferredFromBatchId: 'in',
        },
        batch('in', 'VERIFIED', '2026-10-03T00:00:00Z'),
      ],
    });
    expect(items.map((i) => i.id)).toEqual(['in']);
  });

  it('merges every source newest first', async () => {
    const items = await feed({
      orders: [order('s', 'CONFIRMED', '2026-10-02T09:00:00Z')],
      payments: [payment('pay', 'RECORDED', '2026-10-03')],
      batches: [batch('b', 'VERIFIED', '2026-10-01T09:00:00Z')],
    });
    expect(items.map((i) => i.id)).toEqual(['pay', 's', 'b']);
  });

  it('nothing at all is an empty list, not an error', async () => {
    expect(await feed({})).toEqual([]);
  });
});

describe('Recent activity — the limit', () => {
  const many = Array.from({ length: 70 }, (_, i) =>
    order(
      `o${i}`,
      'CONFIRMED',
      new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
    ),
  );

  it('defaults to 10, the newest', async () => {
    const items = await feed({ orders: many });
    expect(items).toHaveLength(10);
    expect(items[0].id).toBe('o69');
  });

  it('is capped at 50 whatever is asked', async () => {
    expect(await feed({ orders: many }, 10_000)).toHaveLength(50);
  });

  it('zero, negative and nonsense fall back to the default', async () => {
    expect(await feed({ orders: many }, 0)).toHaveLength(10);
    expect(await feed({ orders: many }, -5)).toHaveLength(10);
    expect(await feed({ orders: many }, Number('abc'))).toHaveLength(10);
  });

  it('a busy source does not push the others out of the window', async () => {
    // 70 sales all older than one payment: the payment must still be first.
    const items = await feed(
      { orders: many, payments: [payment('late', 'RECORDED', '2026-06-01')] },
      5,
    );
    expect(items[0].id).toBe('late');
    expect(items).toHaveLength(5);
  });
});

describe('Recent activity — who may read it (rule 12)', () => {
  const guard = new RolesGuard(new Reflector());
  const as = (role: string) =>
    ({
      getHandler: () => AnalyticsController.prototype.getRecentActivity,
      getClass: () => AnalyticsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;

  it.each(['TEMP_INVESTOR', 'SHOP_OWNER_PORTAL'])(
    '%s is refused with a coded error',
    (role) => {
      let thrown: any;
      try {
        guard.canActivate(as(role));
      } catch (e) {
        thrown = e;
      }
      expect(thrown?.getResponse?.()).toMatchObject({
        code: 'ROLE_NOT_ALLOWED',
      });
    },
  );

  it.each(['CORE_PARTNER', 'ADMIN_SUPPORT'])('%s is let through', (role) => {
    expect(guard.canActivate(as(role))).toBe(true);
  });

  it('the guard is actually on the route, not only declared', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      AnalyticsController.prototype.getRecentActivity,
    );
    expect(guards).toContain(RolesGuard);
  });
});
