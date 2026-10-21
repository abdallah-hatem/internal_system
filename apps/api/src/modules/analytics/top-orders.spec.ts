import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { HttpException, type ExecutionContext } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

/**
 * The Sales tab's summary (owner 2026-10-18: "the order with the most revenue
 * and the largest order"). Realised sales only, net of returns, ties never
 * decided by the database's order, nothing when nothing has sold.
 */

const D = (v: number) => new Prisma.Decimal(v);

/** A realised order: its total, [qty, returned][] per line, and refunds. */
function order(
  orderNo: string,
  total: number,
  lines: [number, number?][],
  refunds: number[] = [],
) {
  return {
    id: `id-${orderNo}`,
    orderNo,
    orderedAt: new Date('2026-10-01T10:00:00Z'),
    total: D(total),
    customer: { id: 'c1', displayName: 'Delta Motors', isWalkIn: false },
    returns: refunds.map((r) => ({ refundEgp: D(r) })),
    items: lines.map(([qty, returned]) => ({
      quantity: D(qty),
      returnItems: returned ? [{ qty: D(returned) }] : [],
    })),
  };
}

type Row = ReturnType<typeof order>;
const wheres: unknown[] = [];
const service = (rows: Row[]) =>
  new AnalyticsService({
    saleOrder: {
      findMany: (args: { where: unknown }) => {
        wheres.push(args.where);
        return Promise.resolve(rows);
      },
    },
  } as never);

const top = async (rows: Row[]) => (await service(rows).getTopOrders()).data;

describe('top orders, for the Sales summary', () => {
  beforeEach(() => (wheres.length = 0));

  it('the most revenue and the most units can be two different sales', async () => {
    const r = await top([
      order('SO-1', 50000, [[2], [3]]),
      order('SO-2', 12000, [[40], [20], [5]]),
      order('SO-3', 8000, [[10]]),
    ]);
    expect(r.mostRevenue).toMatchObject({
      orderNo: 'SO-1',
      revenueEgp: 50000,
      units: 5,
      lines: 2,
    });
    expect(r.mostUnits).toMatchObject({
      orderNo: 'SO-2',
      revenueEgp: 12000,
      units: 65,
      lines: 3,
    });
  });

  it('reads realised sales only: never a draft, cancelled, returned or samples order', async () => {
    await top([]);
    expect(wheres).toEqual([
      { status: { in: ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'] } },
    ]);
  });

  it('nothing sold is null for both, not a zero-value order', async () => {
    expect(await top([])).toEqual({ mostRevenue: null, mostUnits: null });
  });

  it('refunds come off revenue: 30,000 with 25,000 refunded loses to 10,000', async () => {
    const r = await top([
      order('SO-BIG', 30000, [[30, 25]], [25000]),
      order('SO-KEPT', 10000, [[10]]),
    ]);
    expect(r.mostRevenue?.orderNo).toBe('SO-KEPT');
    expect(r.mostUnits?.orderNo).toBe('SO-KEPT');
    // And the returned order's own figures are net.
    const alone = await top([order('SO-BIG', 30000, [[30, 25]], [25000])]);
    expect(alone.mostUnits).toMatchObject({ units: 5, revenueEgp: 5000 });
  });

  it('a sale with everything returned is not a candidate at all', async () => {
    const r = await top([order('SO-GONE', 9000, [[9, 9]], [9000])]);
    expect(r).toEqual({ mostRevenue: null, mostUnits: null });
  });

  it('a zero-total sale (all discounted) never takes "most revenue"', async () => {
    const r = await top([order('SO-FREE', 0, [[100]])]);
    expect(r.mostRevenue).toBeNull();
    expect(r.mostUnits).toBeNull();
  });

  it('a tie in revenue falls to units, then the order number — whatever order the rows come in', async () => {
    const rows = [
      order('SO-B', 1000, [[5]]),
      order('SO-A', 1000, [[5]]),
      order('SO-C', 1000, [[7]]),
    ];
    for (const list of [rows, [...rows].reverse()]) {
      const r = await top(list);
      expect(r.mostRevenue?.orderNo).toBe('SO-C');
      expect(r.mostUnits?.orderNo).toBe('SO-C');
    }
    const even = [order('SO-B', 1000, [[5]]), order('SO-A', 1000, [[5]])];
    for (const list of [even, [...even].reverse()]) {
      const r = await top(list);
      expect(r.mostRevenue?.orderNo).toBe('SO-A');
      expect(r.mostUnits?.orderNo).toBe('SO-A');
    }
  });

  it('a tie in units falls to revenue', async () => {
    const r = await top([
      order('SO-A', 1000, [[10]]),
      order('SO-B', 4000, [[10]]),
    ]);
    expect(r.mostUnits?.orderNo).toBe('SO-B');
  });

  it('fractional quantities and money keep their precision', async () => {
    const r = await top([order('SO-1', 100.1 + 0.2, [[0.1], [0.2]])]);
    expect(r.mostUnits?.units).toBe(0.3);
    expect(r.mostRevenue?.revenueEgp).toBe(100.3);
  });
});

describe('GET /analytics/top-orders — who may read it (rule 12)', () => {
  const guard = new RolesGuard(new Reflector());
  const h = Object.getOwnPropertyDescriptor(
    AnalyticsController.prototype,
    'getTopOrders',
  )!.value as object;
  const as = (role: string | undefined) =>
    ({
      getHandler: () => h,
      getClass: () => AnalyticsController,
      switchToHttp: () => ({
        getRequest: () => ({ user: role ? { role } : undefined }),
      }),
    }) as unknown as ExecutionContext;

  it.each(['TEMP_INVESTOR', 'SHOP_OWNER_PORTAL', undefined])(
    '%s is refused with 403 ROLE_NOT_ALLOWED',
    (role) => {
      let e: unknown;
      try {
        guard.canActivate(as(role));
      } catch (err) {
        e = err;
      }
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(403);
      expect((e as HttpException).getResponse()).toMatchObject({
        code: 'ROLE_NOT_ALLOWED',
      });
    },
  );

  it.each(['CORE_PARTNER', 'ADMIN_SUPPORT'])('%s is let through', (role) => {
    expect(guard.canActivate(as(role))).toBe(true);
  });

  it('the route carries the RolesGuard', () => {
    const guards = Reflect.getMetadata('__guards__', h) as unknown[];
    expect(guards).toContain(RolesGuard);
  });
});
