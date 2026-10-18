/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment -- an in-memory stand-in for Prisma answers loosely-shaped query objects */
import type { PrismaService } from '../../prisma/prisma.service';
import { AuditController } from './audit.controller';
import { withEntityLabels } from './audit-labels';

/**
 * The audit log names the record a row is about (owner 2026-10-18).
 *
 * It showed `3f2a91c0...` — the database id — which means nothing to the owner.
 * Each row now carries the order number, the cycle code, the shop's name. The
 * fake database below answers `findMany({ where: { id: { in } } })` honestly
 * and counts its calls, so "one query per type" is something the test can see.
 */

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const CUSTOMER = id(900);
const CYCLE = id(901);

function table(rows: any[]) {
  return jest.fn(async (q: any) =>
    rows.filter((r) => (q.where.id.in as string[]).includes(r.id)),
  );
}

function fakeDb() {
  const orders = Array.from({ length: 30 }, (_, i) => ({
    id: id(i + 1),
    orderNo: `ORD-2026-${String(i + 1).padStart(5, '0')}`,
  }));
  return {
    saleOrder: { findMany: table(orders) },
    customer: {
      findMany: table([{ id: CUSTOMER, displayName: 'Nile Motors' }]),
    },
    importCycle: { findMany: table([{ id: CYCLE, code: 'CYC-2026-0001' }]) },
    inventoryBatch: { findMany: table([]) },
    payment: {
      findMany: table([
        {
          id: id(500),
          reference: null,
          amount: '1500.00',
          currency: 'EGP',
          customerId: CUSTOMER,
          customer: { displayName: 'Nile Motors' },
        },
      ]),
    },
    product: {
      findMany: table([
        {
          id: id(600),
          sku: 'PRD-00001',
          name: 'Brake pad',
          nameAr: 'تيل فرامل',
        },
      ]),
    },
    supplier: { findMany: table([{ id: id(700), name: 'Guangzhou Moto' }]) },
  };
}

const row = (entityType: string, entityId: string, extra: object = {}) => ({
  id: `log-${entityType}-${entityId}`,
  entityType,
  entityId,
  ...extra,
});

const run = (db: ReturnType<typeof fakeDb>, rows: any[]) =>
  withEntityLabels(db as unknown as PrismaService, rows);

describe('Audit log — the record by its name, not its id', () => {
  it('a sale order is named by its order number and linked to its page', async () => {
    const db = fakeDb();
    const [r] = await run(db, [row('SaleOrder', id(3))]);
    expect(r.entityLabel).toBe('ORD-2026-00003');
    expect(r.entityHref).toBe(`/sales/${id(3)}/invoice`);
  });

  it('thirty orders on one page are one query, not thirty', async () => {
    const db = fakeDb();
    const rows = Array.from({ length: 30 }, (_, i) =>
      row('SaleOrder', id(i + 1)),
    );
    // The same order twice (created, then confirmed) is asked for once.
    rows.push(row('SaleOrder', id(1), { id: 'second-entry' }));
    const out = await run(db, rows);

    expect(db.saleOrder.findMany).toHaveBeenCalledTimes(1);
    const asked = db.saleOrder.findMany.mock.calls[0][0].where.id
      .in as string[];
    expect(asked).toHaveLength(30);
    expect(out.map((r) => r.entityLabel)).toEqual([
      ...Array.from(
        { length: 30 },
        (_, i) => `ORD-2026-${String(i + 1).padStart(5, '0')}`,
      ),
      'ORD-2026-00001',
    ]);
  });

  it('several types on one page are one query each, and rows keep their order', async () => {
    const db = fakeDb();
    const out = await run(db, [
      row('Customer', CUSTOMER),
      row('SaleOrder', id(2)),
      row('ImportCycle', CYCLE),
      row('SaleOrder', id(4)),
      row('Customer', CUSTOMER, { id: 'again' }),
    ]);
    expect(db.saleOrder.findMany).toHaveBeenCalledTimes(1);
    expect(db.customer.findMany).toHaveBeenCalledTimes(1);
    expect(db.importCycle.findMany).toHaveBeenCalledTimes(1);
    expect(out.map((r) => r.entityLabel)).toEqual([
      'Nile Motors',
      'ORD-2026-00002',
      'CYC-2026-0001',
      'ORD-2026-00004',
      'Nile Motors',
    ]);
    expect(out[0].entityHref).toBe(`/customers/${CUSTOMER}`);
    expect(out[2].entityHref).toBe(`/cycles/${CYCLE}/details`);
  });

  it('a deleted record has no label and no link — never its id', async () => {
    const db = fakeDb();
    const gone = id(999);
    const [r] = await run(db, [row('SaleOrder', gone)]);
    expect(r).toMatchObject({
      entityLabel: null,
      entityLabelAr: null,
      entityHref: null,
      entityAmount: null,
    });
    expect(JSON.stringify([r.entityLabel, r.entityHref])).not.toContain(gone);
  });

  it('a type nobody taught it is left unnamed and costs no query', async () => {
    const db = fakeDb();
    const [r] = await run(db, [row('SomethingNew', id(1))]);
    expect(r.entityLabel).toBeNull();
    expect(r.entityHref).toBeNull();
    for (const model of Object.values(db))
      expect(model.findMany).not.toHaveBeenCalled();
  });

  it('a payment with no reference is named by its shop, with its sum', async () => {
    const db = fakeDb();
    const [r] = await run(db, [row('Payment', id(500))]);
    expect(r.entityLabel).toBe('Nile Motors');
    expect(r.entityAmount).toEqual({ value: '1500.00', currency: 'EGP' });
    expect(r.entityHref).toBe(`/customers/${CUSTOMER}`);
  });

  it('a product carries its Arabic name too', async () => {
    const db = fakeDb();
    const [r] = await run(db, [row('Product', id(600))]);
    expect(r.entityLabel).toBe('Brake pad (PRD-00001)');
    expect(r.entityLabelAr).toBe('تيل فرامل (PRD-00001)');
    expect(r.entityHref).toBe(`/products/${id(600)}`);
  });

  it('a supplier is named but not linked: it has no page of its own', async () => {
    const db = fakeDb();
    const [r] = await run(db, [row('Supplier', id(700))]);
    expect(r.entityLabel).toBe('Guangzhou Moto');
    expect(r.entityHref).toBeNull();
  });

  it("a stock receipt is logged under the cycle's id, and named by the cycle", async () => {
    const db = fakeDb();
    const [r] = await run(db, [row('InventoryBatch', CYCLE)]);
    expect(r.entityLabel).toBe('CYC-2026-0001');
    expect(r.entityHref).toBe(`/cycles/${CYCLE}/details`);
  });

  it('an exchange rate is named by the currency code on the row itself', async () => {
    const db = fakeDb();
    const [r] = await run(db, [
      row('CurrencyRate', id(800), {
        afterJson: { code: 'USD', rateToEgp: '48.5' },
      }),
    ]);
    expect(r.entityLabel).toBe('USD');
    expect(r.entityHref).toBeNull();
  });

  it('an empty page asks the database nothing', async () => {
    const db = fakeDb();
    expect(await run(db, [])).toEqual([]);
    for (const model of Object.values(db))
      expect(model.findMany).not.toHaveBeenCalled();
  });
});

describe('Audit log endpoints return the label', () => {
  const logs = [
    {
      id: 'log-1',
      action: 'CREATE',
      entityType: 'SaleOrder',
      entityId: id(7),
      occurredAt: new Date('2026-10-18T09:00:00Z'),
    },
  ];
  const prisma = () =>
    ({
      ...fakeDb(),
      auditLog: {
        findMany: jest.fn(async () => logs),
        findUnique: jest.fn(async () => logs[0]),
      },
    }) as unknown as PrismaService;

  it('the list', async () => {
    const res = await new AuditController(prisma()).findAll({
      limit: 20,
    });
    expect(res.data[0]).toMatchObject({ entityLabel: 'ORD-2026-00007' });
  });

  it('one entry', async () => {
    const res = await new AuditController(prisma()).findOne('log-1');
    expect(res.data).toMatchObject({ entityLabel: 'ORD-2026-00007' });
  });
});
