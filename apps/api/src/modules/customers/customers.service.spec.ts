import { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { CustomersService } from './customers.service';

/**
 * The balance on the customers list.
 *
 * `findAll` never returned `outstandingBalance`, so the list showed 0 for every
 * shop while the shop's own page showed what it owed. The fake database below
 * evaluates the statuses honestly — a fake that summed every order would pass
 * the draft case whatever rule the service used.
 */

const OWING = '11111111-1111-4111-8111-111111111111';
const DRAFT_ONLY = '22222222-2222-4222-8222-222222222222';
const MIXED = '33333333-3333-4333-8333-333333333333';
const NO_ORDERS = '44444444-4444-4444-8444-444444444444';

type Order = { customerId: string; status: string; outstanding: Prisma.Decimal };

function customer(id: string, displayName: string, createdAt: string) {
  return {
    id,
    type: 'B2B',
    displayName,
    phone: null,
    email: null,
    verificationStatus: 'VERIFIED',
    createdAt: new Date(createdAt),
  };
}

function fakeDb(orders: Order[]) {
  const customers = [
    customer(OWING, 'Nile Motors', '2026-01-04T00:00:00Z'),
    customer(DRAFT_ONLY, 'Delta Spares', '2026-01-03T00:00:00Z'),
    customer(MIXED, 'Cairo Bikes', '2026-01-02T00:00:00Z'),
    customer(NO_ORDERS, 'Giza Parts', '2026-01-01T00:00:00Z'),
  ];
  const owedRows = (where: { customerId: unknown; status: { in: string[] } }) =>
    orders.filter(
      (o) =>
        (typeof where.customerId === 'string'
          ? o.customerId === where.customerId
          : (where.customerId as { in: string[] }).in.includes(o.customerId)) &&
        where.status.in.includes(o.status),
    );
  const sum = (rows: Order[]) =>
    rows.length
      ? rows.reduce((t, o) => t.plus(o.outstanding), new Prisma.Decimal(0))
      : null;

  const calls = { groupBy: 0, aggregate: 0 };
  const prisma = {
    customer: {
      findMany: jest.fn(async () => customers.map((c) => ({ ...c, _count: { saleOrders: 0, payments: 0 } }))),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const c = customers.find((x) => x.id === where.id);
        return c ? { ...c, saleOrders: [], payments: [] } : null;
      }),
    },
    saleOrder: {
      groupBy: jest.fn(async ({ where }: { where: any }) => {
        calls.groupBy++;
        const rows = owedRows(where);
        const ids = [...new Set(rows.map((o) => o.customerId))];
        return ids.map((customerId) => ({
          customerId,
          _sum: { outstanding: sum(rows.filter((o) => o.customerId === customerId)) },
        }));
      }),
      aggregate: jest.fn(async ({ where }: { where: any }) => {
        calls.aggregate++;
        return { _sum: { outstanding: sum(owedRows(where)) } };
      }),
    },
  };
  const service = new CustomersService(
    prisma as unknown as PrismaService,
    { log: jest.fn() } as unknown as AuditService,
  );
  return { service, calls };
}

const D = (v: string) => new Prisma.Decimal(v);

const ORDERS: Order[] = [
  { customerId: OWING, status: 'CONFIRMED', outstanding: D('500.00') },
  { customerId: DRAFT_ONLY, status: 'DRAFT', outstanding: D('900.00') },
  { customerId: MIXED, status: 'CONFIRMED', outstanding: D('120.50') },
  { customerId: MIXED, status: 'PARTIALLY_PAID', outstanding: D('79.50') },
  { customerId: MIXED, status: 'DRAFT', outstanding: D('1000.00') },
  { customerId: MIXED, status: 'PAID', outstanding: D('0.00') },
  { customerId: MIXED, status: 'CANCELLED', outstanding: D('300.00') },
];

describe('CustomersService.findAll — outstanding balance', () => {
  async function balances(orders = ORDERS) {
    const { service, calls } = fakeDb(orders);
    const { data } = await service.findAll({ limit: 20 } as any);
    return {
      byId: new Map(data.map((c: any) => [c.id, c.outstandingBalance])),
      calls,
      service,
    };
  }

  it('a customer with a confirmed unpaid order shows that balance', async () => {
    const { byId } = await balances();
    expect(byId.get(OWING)).toBe('500.00');
  });

  it('a customer whose only order is a draft shows 0.00 — a draft owes nothing', async () => {
    const { byId } = await balances();
    expect(byId.get(DRAFT_ONLY)).toBe('0.00');
  });

  it('a customer with no orders at all shows 0.00, not a missing field', async () => {
    const { byId } = await balances();
    expect(byId.has(NO_ORDERS)).toBe(true);
    expect(byId.get(NO_ORDERS)).toBe('0.00');
  });

  it('counts CONFIRMED and PARTIALLY_PAID only — not draft, paid or cancelled', async () => {
    const { byId } = await balances();
    expect(byId.get(MIXED)).toBe('200.00');
  });

  it("every row matches the customer's own page, which uses the shared owedBy", async () => {
    const { byId, service } = await balances();
    for (const id of [OWING, DRAFT_ONLY, MIXED, NO_ORDERS]) {
      const page = (await service.findById(id)).data;
      expect(byId.get(id)).toBe(page.outstandingBalance);
    }
  });

  it('asks the database once for the whole page, not once per row', async () => {
    const { calls } = await balances();
    expect(calls.groupBy).toBe(1);
    expect(calls.aggregate).toBe(0);
  });

  it('nobody owing anything → every row 0.00', async () => {
    const { byId } = await balances([]);
    expect([...byId.values()]).toEqual(['0.00', '0.00', '0.00', '0.00']);
  });
});
