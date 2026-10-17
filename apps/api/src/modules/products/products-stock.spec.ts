/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- the fake database's rows are untyped records, as Prisma's argument objects are */
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { ProductsService } from './products.service';
import type { ScopeViewer } from '../../common/investor-scope';

/**
 * How many of each product are in stock, on the office's products list (owner,
 * 2026-10-17): every unit still on the shelf across its batches — the same
 * stock on hand the low-stock rule counts — and nothing for an investor.
 */

const ROWS = [
  {
    id: 'p1',
    sku: 'Y20',
    inventoryBatches: [{ remainingQty: '2' }, { remainingQty: '0' }],
  },
  {
    id: 'p2',
    sku: 'Q58',
    inventoryBatches: [{ remainingQty: '28' }, { remainingQty: '3.5' }],
  },
  { id: 'p3', sku: 'NEW', inventoryBatches: [] },
];

function service() {
  const findMany = jest.fn(({ include }: any) =>
    Promise.resolve(
      ROWS.map(({ inventoryBatches, ...p }) => ({
        ...p,
        ...(include?.inventoryBatches ? { inventoryBatches } : {}),
      })),
    ),
  );
  const svc = new ProductsService(
    { product: { findMany } } as unknown as PrismaService,
    { log: jest.fn() } as unknown as AuditService,
    {} as NotificationsService,
  );
  return { svc, findMany };
}

describe('stock on the products list', () => {
  it('each product carries its units in stock, summed over its batches; one never received has 0', async () => {
    const { svc } = service();
    const { data } = await svc.findAll({});
    expect(data.map((p: any) => [p.sku, p.onHand])).toEqual([
      ['Y20', 2],
      ['Q58', 31.5],
      ['NEW', 0],
    ]);
  });

  it('the batches themselves are not sent, only the count', async () => {
    const { svc } = service();
    const { data } = await svc.findAll({});
    expect(data.every((p: any) => !('inventoryBatches' in p))).toBe(true);
  });

  it('an investor sees the catalogue without stock', async () => {
    const { svc, findMany } = service();
    const investor = {
      role: 'TEMPORARY_INVESTOR',
      cycleIds: [],
    } as unknown as ScopeViewer;
    const { data } = await svc.findAll({}, investor);
    expect(findMany.mock.calls[0][0].include.inventoryBatches).toBeUndefined();
    expect(data.every((p: any) => p.onHand === undefined)).toBe(true);
  });
});
