import type { HttpException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import type { AuditService } from '../audit/audit.service';
import type { CostingService } from '../costing/costing.service';
import { CurrencyRatesService } from '../currency-rates/currency-rates.service';
import { CustomersService } from '../customers/customers.service';
import { CyclesService } from '../cycles/cycles.service';
import { InventoryService } from '../inventory/inventory.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { PaymentPlansService } from '../payment-plans/payment-plans.service';
import { PaymentsService } from '../payments/payments.service';
import { ProductsService } from '../products/products.service';
import { SalesService } from '../sales/sales.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { AssistantServer } from './assistant-server';
import { ConfirmationService } from './confirmation.service';
import { writeTool, type AssistantUser } from './tool-kit';

/**
 * The read tools, driven through the real McpServer and the SDK's client —
 * the path Claude takes — against the real services over a fake database.
 *
 * The services are real on purpose. The claim these tools make is that they
 * answer with the office app's figures, and that can only be tested by asking
 * the office app's code the same question and comparing.
 */

const partner: AssistantUser = {
  id: 'partner-a',
  email: 'a@motoparts.test',
  role: 'CORE_PARTNER',
  partner: null,
};

const CYCLE_ID = '0b8f0c9e-5d1c-4a3e-9d5e-1f2a3b4c5d6e';
const OTHER_CYCLE_ID = '1c9a1d0f-6e2d-4b4f-8e6f-2a3b4c5d6e7f';
const CUSTOMER_ID = '2d0b2e1a-7f3e-4c5a-9f7a-3b4c5d6e7f80';
const PRODUCT_ID = '3e1c3f2b-8a4f-4d6b-8a8b-4c5d6e7f8091';
const UNKNOWN_ID = '9f9f9f9f-9f9f-4f9f-9f9f-9f9f9f9f9f9f';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** `{ contains, mode }` as Postgres reads it — case only ignored when asked. */
function contains(value: unknown, filter: { contains: string; mode?: string }) {
  if (typeof value !== 'string') return false;
  return filter.mode === 'insensitive'
    ? value.toLowerCase().includes(filter.contains.toLowerCase())
    : value.includes(filter.contains);
}

/** The slice of Prisma's `where` these services use, evaluated honestly. */
function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('contains' in c)
        return contains(value, c as { contains: string; mode?: string });
      if ('equals' in c) {
        return c.mode === 'insensitive'
          ? String(value).toLowerCase() === String(c.equals).toLowerCase()
          : value === c.equals;
      }
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('not' in c) return value !== c.not;
      const t = (value as Date).getTime();
      if ('gte' in c && t < (c.gte as Date).getTime()) return false;
      if ('lt' in c && t >= (c.lt as Date).getTime()) return false;
      if ('lte' in c && t > (c.lte as Date).getTime()) return false;
      return true;
    }
    return value === cond;
  });
}

interface Db {
  cycles: Row[];
  products: Row[];
  batches: Row[];
  customers: Row[];
  orders: Row[];
  suppliers: Row[];
}

function emptyCycle(id: string, code: string): Row {
  return {
    id,
    code,
    status: 'SELLING',
    originType: 'CHINA',
    currency: 'CNY',
    startedOn: new Date('2026-07-01T00:00:00Z'),
    closedOn: null,
    participants: [],
    purchaseOrders: [],
    shippingLegs: [],
    inventoryBatches: [],
    settlements: [],
  };
}

function fakePrisma(db: Db) {
  const findMany = (rows: () => Row[]) =>
    jest.fn((args: { where?: Where; take?: number } = {}) =>
      Promise.resolve(
        rows()
          .filter((r) => matches(r, args.where))
          .slice(0, args.take ?? Infinity),
      ),
    );
  const findUnique = (rows: () => Row[]) =>
    jest.fn((args: { where: Where }) =>
      Promise.resolve(rows().find((r) => matches(r, args.where)) ?? null),
    );

  return {
    importCycle: {
      findUnique: findUnique(() => db.cycles),
      findMany: findMany(() => db.cycles),
    },
    product: { findMany: findMany(() => db.products) },
    inventoryBatch: { findMany: findMany(() => db.batches) },
    supplier: { findMany: findMany(() => db.suppliers) },
    customer: {
      findUnique: findUnique(() => db.customers),
      findMany: findMany(() => db.customers),
    },
    saleOrder: {
      findMany: findMany(() => db.orders),
      aggregate: jest.fn((args: { where: Where }) => {
        const sum = db.orders
          .filter((o) => matches(o, args.where))
          .reduce((s, o) => s + Number(o.outstanding), 0);
        return Promise.resolve({ _sum: { outstanding: sum } });
      }),
    },
    payment: { findMany: findMany(() => []) },
    paymentPlan: { findMany: findMany(() => []) },
  };
}

function harness(db: Db) {
  const prisma = fakePrisma(db);
  const p = prisma as unknown as PrismaService;
  const audit = {} as AuditService;
  const notifications = {} as NotificationsService;
  const services = new Map<unknown, unknown>([
    [SuppliersService, new SuppliersService(p, audit)],
    [ProductsService, new ProductsService(p, audit, notifications)],
    [CyclesService, new CyclesService(p, audit, notifications)],
    [
      InventoryService,
      new InventoryService(p, audit, notifications, {} as CostingService),
    ],
    [SalesService, new SalesService(p, audit)],
    [CustomersService, new CustomersService(p, audit)],
    [PaymentsService, new PaymentsService(p, audit)],
    [PaymentPlansService, new PaymentPlansService(p, audit, notifications)],
    [AnalyticsService, new AnalyticsService(p)],
    [CurrencyRatesService, new CurrencyRatesService(p, audit)],
  ]);
  const assistant = new AssistantServer(
    new ConfirmationService(
      new JwtService({ secret: 'a-test-secret-that-is-long-enough' }),
      p,
    ),
    { get: (type: unknown) => services.get(type) } as unknown as ModuleRef,
  );
  return { prisma, services, assistant };
}

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

async function call(
  assistant: AssistantServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const client = await connect(assistant.create(partner));
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

/** The facts a tool answered with. */
function dataOf<T = unknown>(res: CallToolResult): T {
  expect(res.isError).toBeFalsy();
  return (res.structuredContent as { data: T }).data;
}

function errorOf(res: CallToolResult) {
  expect(res.isError).toBe(true);
  return (
    res.structuredContent as {
      error: { code: string; params?: Record<string, string> };
    }
  ).error;
}

function emptyDb(): Db {
  return {
    cycles: [],
    products: [],
    batches: [],
    customers: [],
    orders: [],
    suppliers: [],
  };
}

// ─────────────────────────────────────────────────────────────── get_cycle

describe('get_cycle', () => {
  function db(): Db {
    const d = emptyDb();
    d.cycles.push(
      emptyCycle(CYCLE_ID, 'CYC-2026-0001'),
      emptyCycle(OTHER_CYCLE_ID, 'CYC-2026-0002'),
    );
    return d;
  }

  it('get_cycle by code and by id → the same cycle', async () => {
    const { assistant } = harness(db());

    const byCode = dataOf<{ id: string; code: string }>(
      await call(assistant, 'get_cycle', { cycle: 'CYC-2026-0001' }),
    );
    const byId = dataOf<{ id: string; code: string }>(
      await call(assistant, 'get_cycle', { cycle: CYCLE_ID }),
    );

    expect(byCode.id).toBe(CYCLE_ID);
    expect(byId).toEqual(byCode);
  });

  it('get_cycle unknown → tool error NOT_FOUND', async () => {
    const { assistant } = harness(db());

    for (const cycle of ['CYC-2099-0999', UNKNOWN_ID]) {
      const error = errorOf(await call(assistant, 'get_cycle', { cycle }));
      expect(error.code).toBe('NOT_FOUND');
      expect(error.params).toEqual({ entity: 'cycle' });
    }
  });

  it('get_cycle with a code in another case → that cycle', async () => {
    const { assistant } = harness(db());

    const res = dataOf<{ id: string }>(
      await call(assistant, 'get_cycle', { cycle: '  cyc-2026-0002 ' }),
    );

    expect(res.id).toBe(OTHER_CYCLE_ID);
  });

  it('get_cycle with codes that differ only in case → the exact one, or CYCLE_CODE_AMBIGUOUS, never a guess', async () => {
    const d = emptyDb();
    d.cycles.push(
      emptyCycle(CYCLE_ID, 'CYC-7'),
      emptyCycle(OTHER_CYCLE_ID, 'cyc-7'),
    );
    const { assistant } = harness(d);

    expect(
      dataOf<{ id: string }>(
        await call(assistant, 'get_cycle', { cycle: 'cyc-7' }),
      ).id,
    ).toBe(OTHER_CYCLE_ID);
    const error = errorOf(
      await call(assistant, 'get_cycle', { cycle: 'Cyc-7' }),
    );
    expect(error.code).toBe('CYCLE_CODE_AMBIGUOUS');
  });

  it('get_cycle with an id that is not a uuid → NOT_FOUND, and never reaches Postgres as an id', async () => {
    const { assistant, prisma } = harness(db());

    for (const cycle of ['not-a-uuid', '', '   ', "1' OR '1'='1"]) {
      expect(errorOf(await call(assistant, 'get_cycle', { cycle })).code).toBe(
        'NOT_FOUND',
      );
    }
    const idLookups = prisma.importCycle.findUnique.mock.calls
      .map(([args]) => args.where.id)
      .filter((id) => id !== undefined);
    expect(idLookups).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────── get_stock

describe('get_stock', () => {
  const leg1 = new Date('2026-08-01T10:00:00Z'); // landed in the UAE
  const leg2 = new Date('2026-08-22T09:00:00Z'); // landed in Egypt
  const received = new Date('2026-08-27T12:30:00Z');

  function db(): Db {
    const d = emptyDb();
    d.batches.push({
      id: 'batch-1',
      cycleId: CYCLE_ID,
      productId: PRODUCT_ID,
      receivedQty: 10,
      remainingQty: 8,
      reservedQty: 1,
      saleableQty: 7,
      landedUnitCostEgp: 55.5,
      createdAt: received,
      product: { name: 'Brake pad' },
      cycle: {
        code: 'CYC-2026-0001',
        // A CHINA cycle: leg 1 arriving is a box in Dubai, not stock in Cairo.
        shippingLegs: [
          { sequence: 1, arrivedOn: leg1 },
          { sequence: 2, arrivedOn: leg2 },
        ],
      },
    });
    return d;
  }

  it("get_stock arrival and receipt dates equal /inventory's", async () => {
    const { assistant, services } = harness(db());

    const tool = dataOf<
      Array<{ batches: Array<{ arrivedOn: string; receivedAt: string }> }>
    >(await call(assistant, 'get_stock'));
    const office = (
      await (services.get(InventoryService) as InventoryService).getStock({})
    ).data as Array<{
      batches: Array<{ arrivedOn: Date; receivedAt: Date }>;
    }>;

    expect(tool[0].batches[0].arrivedOn).toBe(
      office[0].batches[0].arrivedOn.toISOString(),
    );
    expect(tool[0].batches[0].receivedAt).toBe(
      office[0].batches[0].receivedAt.toISOString(),
    );
    // And they are the §14 dates, not merely equal to each other: the last
    // leg, and the moment it was booked in.
    expect(tool[0].batches[0]).toMatchObject({
      arrivedOn: leg2.toISOString(),
      receivedAt: received.toISOString(),
    });
  });

  it('get_stock with a product id that is not a uuid → NOT_FOUND, nothing queried', async () => {
    const { assistant, prisma } = harness(db());

    const error = errorOf(
      await call(assistant, 'get_stock', { productId: 'brake-pad' }),
    );

    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      params: { entity: 'product' },
    });
    expect(prisma.inventoryBatch.findMany).not.toHaveBeenCalled();
  });

  it('get_stock for an unknown cycle code → NOT_FOUND, not every batch', async () => {
    const { assistant } = harness(db());

    const error = errorOf(
      await call(assistant, 'get_stock', { cycle: 'CYC-1999-0001' }),
    );

    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      params: { entity: 'cycle' },
    });
  });
});

// ─────────────────────────────────────────────────────────── get_customer

describe('get_customer', () => {
  function db(): Db {
    const d = emptyDb();
    const customer = {
      id: CUSTOMER_ID,
      type: 'B2B',
      displayName: 'Nile Motors',
      phone: '0100',
      email: null,
      verificationStatus: 'VERIFIED',
    };
    const order = (
      id: string,
      status: string,
      outstanding: number,
      day: string,
    ) => ({
      id,
      orderNo: id.toUpperCase(),
      customerId: CUSTOMER_ID,
      channel: 'B2B',
      status,
      currency: 'EGP',
      total: outstanding + 100,
      discount: 0,
      outstanding,
      orderedAt: new Date(`${day}T10:00:00Z`),
      customer,
      items: [],
    });
    // The draft and the cancelled order carry an "outstanding" too. Neither is
    // owed: a draft is not a sale yet, and a cancelled one is not a sale any
    // more. A balance summed over every order would be 1,800, not 500.
    d.orders.push(
      order('so-1', 'CONFIRMED', 300, '2026-08-01'),
      order('so-2', 'PARTIALLY_PAID', 200, '2026-08-05'),
      order('so-3', 'DRAFT', 1000, '2026-08-09'),
      order('so-4', 'CANCELLED', 300, '2026-08-10'),
      order('so-5', 'PAID', 0, '2026-08-11'),
    );
    d.customers.push({
      ...customer,
      saleOrders: d.orders.slice().reverse(),
      payments: [],
      _count: { saleOrders: 5, payments: 0 },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    d.customers.push({
      id: '4f2d4a3c-9b5a-4e7c-9b9c-5d6e7f8091a2',
      type: 'B2B',
      displayName: 'Nile Parts',
      phone: '0101',
      email: null,
      verificationStatus: 'VERIFIED',
      saleOrders: [],
      payments: [],
    });
    return d;
  }

  it("get_customer balance equals the office app's for the same customer", async () => {
    const { assistant, services } = harness(db());

    const tool = dataOf<{
      balance: string;
      openOrders: Array<{ orderNo: string }>;
    }>(await call(assistant, 'get_customer', { customer: CUSTOMER_ID }));

    // The office app's figure, both as the customer page receives it and as
    // the server enforces it when a payment is taken.
    const page = (
      await (services.get(CustomersService) as CustomersService).findById(
        CUSTOMER_ID,
      )
    ).data;
    const refusal = await (services.get(PaymentsService) as PaymentsService)
      .create(
        { customerId: CUSTOMER_ID, amount: 1_000_000, currency: 'EGP' },
        partner.id,
      )
      .then(
        () => null,
        (e: HttpException) =>
          e.getResponse() as { code: string; params: { owed: string } },
      );

    expect(refusal?.code).toBe('PAYMENT_EXCEEDS_OWED');
    expect(tool.balance).toBe(page.outstandingBalance);
    expect(tool.balance).toBe(refusal?.params.owed);
    expect(tool.balance).toBe('500.00');
    expect(tool.openOrders.map((o) => o.orderNo)).toEqual(['SO-1', 'SO-2']);
  });

  it('get_customer by name → that customer; by a name several share → the candidates, not a guess', async () => {
    const { assistant } = harness(db());

    const one = dataOf<{ id: string }>(
      await call(assistant, 'get_customer', { customer: 'nile motors' }),
    );
    expect(one.id).toBe(CUSTOMER_ID);

    const several = dataOf<{ candidates: Array<{ name: string }> }>(
      await call(assistant, 'get_customer', { customer: 'Nile' }),
    );
    expect(several.candidates.map((c) => c.name).sort()).toEqual([
      'Nile Motors',
      'Nile Parts',
    ]);
  });

  it('get_customer unknown, empty, or an unknown uuid → NOT_FOUND', async () => {
    const { assistant } = harness(db());

    for (const customer of ['Nobody Motors', '', '   ', UNKNOWN_ID]) {
      const error = errorOf(
        await call(assistant, 'get_customer', { customer }),
      );
      expect(error).toMatchObject({
        code: 'NOT_FOUND',
        params: { entity: 'customer' },
      });
    }
  });
});

// ─────────────────────────────────────────────────────────── find_products

describe('find_products', () => {
  function db(): Db {
    const d = emptyDb();
    const product = (id: string, sku: string, name: string) => ({
      id,
      sku,
      name,
      status: 'ACTIVE',
      category: { name: 'Brakes' },
      suppliers: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      prices: [
        { channel: 'B2B', amount: 90, effectiveTo: null },
        {
          channel: 'B2B',
          amount: 80,
          effectiveTo: new Date('2026-06-01T00:00:00Z'),
        },
        { channel: 'B2C', amount: 120, effectiveTo: null },
      ],
    });
    d.products.push(
      product(PRODUCT_ID, 'PRD-000012', 'Brake Pad Front'),
      product(
        '5a3e5b4d-0c6b-4f8d-8c0d-6e7f8091a2b3',
        'PRD-000013',
        'Chain Kit',
      ),
    );
    d.batches.push({
      id: 'b1',
      productId: PRODUCT_ID,
      remainingQty: 8,
      reservedQty: 1,
      saleableQty: 7,
      createdAt: new Date(),
      product: { name: 'Brake Pad Front' },
      cycle: { code: 'C', shippingLegs: [] },
    });
    return d;
  }

  it('find_products is case-insensitive and matches part of a SKU', async () => {
    const { assistant } = harness(db());

    const byName = dataOf<Array<{ sku: string }>>(
      await call(assistant, 'find_products', { search: 'bRAKE pad' }),
    );
    const bySku = dataOf<Array<{ sku: string }>>(
      await call(assistant, 'find_products', { search: 'prd-00001' }),
    );
    const byTail = dataOf<Array<{ sku: string }>>(
      await call(assistant, 'find_products', { search: '0013' }),
    );

    expect(byName.map((p) => p.sku)).toEqual(['PRD-000012']);
    expect(bySku.map((p) => p.sku).sort()).toEqual([
      'PRD-000012',
      'PRD-000013',
    ]);
    expect(byTail.map((p) => p.sku)).toEqual(['PRD-000013']);
  });

  it("find_products gives the current price, not a closed one, and the inventory's stock", async () => {
    const { assistant } = harness(db());

    const [pad] = dataOf<Array<{ prices: object; stock: object }>>(
      await call(assistant, 'find_products', { search: 'PRD-000012' }),
    );

    expect(pad.prices).toEqual({ B2B: '90', B2C: '120' });
    expect(pad.stock).toEqual({ total: 8, reserved: 1, available: 7 });
  });

  it('find_products with an empty or blank search → the first page, unfiltered', async () => {
    const { assistant, prisma } = harness(db());

    for (const search of ['', '   ']) {
      expect(
        dataOf<unknown[]>(await call(assistant, 'find_products', { search })),
      ).toHaveLength(2);
    }
    for (const [args] of prisma.product.findMany.mock.calls) {
      expect(args?.where).toEqual({});
    }
  });
});

// ────────────────────────────────────────────────────────────── list_sales

describe('list_sales', () => {
  it('list_sales with from after to → tool error', async () => {
    const { assistant, prisma } = harness(emptyDb());

    const error = errorOf(
      await call(assistant, 'list_sales', {
        from: '2026-09-10',
        to: '2026-09-01',
      }),
    );

    expect(error.code).toBe('DATE_RANGE_REVERSED');
    expect(prisma.saleOrder.findMany).not.toHaveBeenCalled();
  });

  it('list_sales with a date that does not exist → BAD_DATE, not a 500', async () => {
    const { assistant } = harness(emptyDb());

    for (const from of ['2026-02-30', 'yesterday', '2026-9-1']) {
      expect(errorOf(await call(assistant, 'list_sales', { from })).code).toBe(
        'BAD_DATE',
      );
    }
  });

  it('list_sales counts days in Cairo: a sale at 00:30 Cairo time is on that day, not the one before', async () => {
    const d = emptyDb();
    const customer = { displayName: 'Nile Motors' };
    const sale = (id: string, at: string) => ({
      id,
      orderNo: id,
      customerId: CUSTOMER_ID,
      channel: 'B2B',
      status: 'CONFIRMED',
      currency: 'EGP',
      total: 1,
      discount: 0,
      outstanding: 1,
      orderedAt: new Date(at),
      customer,
      items: [],
    });
    // 00:30 on 1 September in Cairo (UTC+3 in summer) is 21:30 UTC on 31 August.
    d.orders.push(
      sale('early-sep-1', '2026-08-31T21:30:00Z'),
      sale('late-aug-31', '2026-08-31T20:30:00Z'),
    );
    const { assistant } = harness(d);

    const sept = dataOf<Array<{ orderNo: string }>>(
      await call(assistant, 'list_sales', {
        from: '2026-09-01',
        to: '2026-09-01',
      }),
    );
    const aug = dataOf<Array<{ orderNo: string }>>(
      await call(assistant, 'list_sales', {
        from: '2026-08-31',
        to: '2026-08-31',
      }),
    );

    expect(sept.map((o) => o.orderNo)).toEqual(['early-sep-1']);
    expect(aug.map((o) => o.orderNo)).toEqual(['late-aug-31']);
  });

  it('list_sales with a limit of 0 or a huge one → the default, or capped at 50', async () => {
    const { assistant, prisma } = harness(emptyDb());

    await call(assistant, 'list_sales', { limit: 0 });
    await call(assistant, 'list_sales', { limit: 1_000_000 });
    await call(assistant, 'list_sales', { limit: -5 });

    // The service asks for one more than it returns, to know if there is more.
    expect(prisma.saleOrder.findMany.mock.calls.map(([a]) => a?.take)).toEqual([
      21, 51, 21,
    ]);
  });

  it('list_sales for a customer id that is not a uuid → NOT_FOUND, never a 500', async () => {
    const { assistant, prisma } = harness(emptyDb());

    const error = errorOf(
      await call(assistant, 'list_sales', { customerId: 'Nile Motors' }),
    );

    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      params: { entity: 'customer' },
    });
    expect(prisma.saleOrder.findMany).not.toHaveBeenCalled();
  });
});

describe('list_payments', () => {
  it('list_payments with from after to → tool error', async () => {
    const { assistant } = harness(emptyDb());

    const error = errorOf(
      await call(assistant, 'list_payments', {
        from: '2026-09-10',
        to: '2026-09-01',
      }),
    );

    expect(error.code).toBe('DATE_RANGE_REVERSED');
  });
});

describe('find_suppliers', () => {
  it('find_suppliers with a huge limit is capped, and a blank search does not filter', async () => {
    const { assistant, prisma } = harness(emptyDb());

    await call(assistant, 'find_suppliers', { search: '  ', limit: 500 });

    const [args] = prisma.supplier.findMany.mock.calls[0];
    expect(args).toMatchObject({ where: {}, take: 51 });
  });
});

// ────────────────────────────────────────────────── what the assistant offers

/**
 * BUSINESS_LOGIC §16: the assistant may change the intake path and nothing
 * else. Reading sales and payments is allowed; writing them is not.
 */
const INTAKE_WRITES = new Set([
  'create_supplier',
  'create_product',
  'create_purchase_order',
  'create_cycle',
  'add_shipping_leg',
  'transition_cycle',
  'verify_stock',
]);
const OFFICE_ONLY =
  /sale|payment|instal|settle|return|refund|ledger|transaction|allocat/i;

async function toolsOf(server: McpServer): Promise<Tool[]> {
  const client = await connect(server);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

function forbiddenWrites(tools: Tool[]): string[] {
  return tools
    .filter((t) => t.annotations?.readOnlyHint !== true)
    .filter((t) => !INTAKE_WRITES.has(t.name) || OFFICE_ONLY.test(t.name))
    .map((t) => t.name);
}

describe('What the assistant offers', () => {
  it('tools/list offers no tool that writes sales, payments, instalments, settlements, returns or the ledger', async () => {
    const { assistant } = harness(emptyDb());

    const tools = await toolsOf(assistant.create(partner));

    expect(forbiddenWrites(tools)).toEqual([]);
    // The read tools are all there, and all say they only read.
    const reads = [
      'find_suppliers',
      'find_products',
      'list_cycles',
      'get_cycle',
      'get_stock',
      'list_sales',
      'get_customer',
      'list_payments',
      'get_dashboard',
      'get_fx_rates',
    ];
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of reads) {
      expect(byName.get(name)?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('the check finds a write tool outside the intake path when one is there', async () => {
    // Without this the test above would pass on a filter that looks at nothing.
    const { assistant } = harness(emptyDb());
    const server = assistant.create(partner);
    const handlers = {
      preview: () => Promise.resolve({ summary: '' }),
      commit: () => Promise.resolve({ summary: '' }),
    };
    const ctx = assistant.contextFor(partner);
    writeTool(
      server,
      ctx,
      'record_payment',
      { title: 'x', description: 'x', inputSchema: { amount: z.number() } },
      handlers,
    );
    writeTool(
      server,
      ctx,
      'reverse_ledger_entry',
      { title: 'x', description: 'x', inputSchema: {} },
      handlers,
    );

    expect(forbiddenWrites(await toolsOf(server)).sort()).toEqual([
      'record_payment',
      'reverse_ledger_entry',
    ]);
  });
});
