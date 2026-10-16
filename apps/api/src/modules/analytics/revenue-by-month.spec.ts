// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import { instantOfDay } from '../../common/dates';
import { AnalyticsService } from './analytics.service';

/**
 * Revenue by month counts a sale in the month of its own day in Cairo
 * (BUSINESS_LOGIC §4, 2026-10-16).
 *
 * A sale can now be dated in the past, so the month it lands in is the month
 * of the day it was made — not the day it was typed in — and that day is
 * Cairo's. The buckets used to be cut from UTC: at 00:30 on the 1st in Cairo it
 * is still the previous month in UTC, so a sale made then was charted a month
 * early and the current month was missing from the chart altogether.
 */

const D = (v: number) => new Prisma.Decimal(v);

type Sale = { orderedAt: Date; total: Prisma.Decimal };

function service(sales: Sale[]) {
  const prisma = {
    saleOrder: {
      findMany: ({ where }: { where: { orderedAt: { gte: Date } } }) =>
        Promise.resolve(
          sales.filter((s) => s.orderedAt >= where.orderedAt.gte),
        ),
    },
    saleReturn: { findMany: () => Promise.resolve([]) },
  };
  return new AnalyticsService(prisma as never);
}

describe('revenue by month, with sales dated in the past (§4, 2026-10-16)', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
  });
  afterEach(() => jest.useRealTimers());

  it('a back-dated sale is counted in the month of its own day, not the month it was entered', async () => {
    jest.setSystemTime(new Date('2026-12-15T10:00:00Z'));
    const { data } = await service([
      { orderedAt: instantOfDay('2026-09-01'), total: D(1000) },
      { orderedAt: instantOfDay('2026-11-30'), total: D(250) },
      { orderedAt: new Date(), total: D(40) },
    ]).getRevenueByMonth(4);

    expect(data).toEqual([
      { month: '2026-09', revenue: 1000 },
      { month: '2026-10', revenue: 0 },
      { month: '2026-11', revenue: 250 },
      { month: '2026-12', revenue: 40 },
    ]);
  });

  it('at 00:30 on the 1st in Cairo the chart ends with the new month, and a sale made then is in it', async () => {
    // 1 December 00:30 in Cairo is 30 November 22:30 UTC.
    jest.setSystemTime(new Date('2026-11-30T22:30:00Z'));
    const { data } = await service([
      { orderedAt: new Date(), total: D(500) },
    ]).getRevenueByMonth(2);

    expect(data).toEqual([
      { month: '2026-11', revenue: 0 },
      { month: '2026-12', revenue: 500 },
    ]);
  });

  it('a sale at 00:30 on the 1st of October (summer time, UTC+3) is October’s', async () => {
    jest.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    const { data } = await service([
      // 1 October 00:30 in Cairo is 30 September 21:30 UTC.
      { orderedAt: new Date('2026-09-30T21:30:00Z'), total: D(70) },
    ]).getRevenueByMonth(2);

    expect(data).toEqual([
      { month: '2026-09', revenue: 0 },
      { month: '2026-10', revenue: 70 },
    ]);
  });

  it('the earliest month starts at midnight in Cairo: a sale in its first hour is not dropped', async () => {
    jest.setSystemTime(new Date('2026-12-15T10:00:00Z'));
    const { data } = await service([
      // 1 November 00:10 in Cairo is 31 October 22:10 UTC.
      { orderedAt: new Date('2026-10-31T22:10:00Z'), total: D(30) },
    ]).getRevenueByMonth(2);

    expect(data).toEqual([
      { month: '2026-11', revenue: 30 },
      { month: '2026-12', revenue: 0 },
    ]);
  });
});
