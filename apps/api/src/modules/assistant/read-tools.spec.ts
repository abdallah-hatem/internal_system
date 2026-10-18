import type { HttpException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { arabicSearchKey } from '../../common/arabic-names';
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
      if ('gt' in c && !(value instanceof Date))
        return Number(value) > Number(c.gt);
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
  /** Active payment plans, with customer and instalments, as PLAN_INCLUDE reads them. */
  plans?: Row[];
  /** What each customer has paid since their plan was agreed. */
  paid?: Record<string, number>;
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
    // Samples at shops (§4): none in these worlds.
    saleItemAllocation: { findMany: findMany(() => []) },
    // The shipment read says whether a leg's cost can change (§2,
    // 2026-10-17): nothing is settled or moved in these worlds.
    settlement: { findFirst: jest.fn(() => Promise.resolve(null)) },
    stockTransfer: { findMany: findMany(() => []) },
    inventoryMovement: { findMany: findMany(() => []) },
    financialTransaction: { findMany: findMany(() => []) },
    // B5: the shipment read asks for refunds per loss; this fixture has none.
    supplierRefund: { findMany: findMany(() => []) },
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
      // The customers list asks for every row's balance in one grouped query.
      groupBy: jest.fn((args: { where: Where }) => {
        const sums = new Map<string, number>();
        for (const o of db.orders.filter((o) => matches(o, args.where))) {
          const id = o.customerId as string;
          sums.set(id, (sums.get(id) ?? 0) + Number(o.outstanding));
        }
        return Promise.resolve(
          [...sums].map(([customerId, outstanding]) => ({
            customerId,
            _sum: { outstanding },
          })),
        );
      }),
    },
    payment: {
      findMany: findMany(() => []),
      aggregate: jest.fn((args: { where: Where }) =>
        Promise.resolve({
          _sum: {
            amount: db.paid?.[args.where.customerId as string] ?? 0,
          },
        }),
      ),
    },
    paymentPlan: { findMany: findMany(() => db.plans ?? []) },
  };
}

function harness(db: Db) {
  const prisma = fakePrisma(db);
  const p = prisma as unknown as PrismaService;
  const audit = {} as AuditService;
  const notifications = {} as NotificationsService;
  const plans = new PaymentPlansService(p, audit, notifications);
  const services = new Map<unknown, unknown>([
    [SuppliersService, new SuppliersService(p, audit)],
    [ProductsService, new ProductsService(p, audit, notifications)],
    [CyclesService, new CyclesService(p, audit, notifications)],
    [
      InventoryService,
      new InventoryService(
        p,
        audit,
        notifications,
        {} as CostingService,
        {} as CyclesService,
      ),
    ],
    [
      SalesService,
      new SalesService(p, audit, new PaymentsService(p, audit), {
        createForMultipleUsers: () => Promise.resolve({ count: 0 }),
      }),
    ],
    [CustomersService, new CustomersService(p, audit, plans)],
    [PaymentsService, new PaymentsService(p, audit)],
    [PaymentPlansService, plans],
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

  it("get_cycle returns the shipment position — per leg status, deliveries, on the way, waiting, lost — as the office's shipment panel reads it", async () => {
    // 40 ordered. Leg 1 (China → UAE) delivered 30 and 4 were marked lost;
    // leg 2 (UAE → Egypt) delivered 20, of which 15 were received.
    const d = emptyDb();
    const c = emptyCycle(CYCLE_ID, 'CYC-2026-0001');
    const item = {
      id: 'item-1',
      orderedQty: 40,
      productId: PRODUCT_ID,
      unitPrice: 10,
      discount: 0,
      lineTotal: 400,
      receivedQty: 15,
      product: { name: 'Brake pad', sku: 'PRD-000001' },
    };
    c.purchaseOrders = [
      {
        id: 'po-1',
        reference: 'PO-1',
        supplier: { name: 'Yiwu' },
        status: 'CONFIRMED',
        currency: 'EGP',
        items: [item],
      },
    ];
    c.shippingLegs = [
      {
        id: 'leg-1',
        sequence: 1,
        origin: 'Guangzhou, CN',
        destination: 'Dubai, UAE',
        departedOn: new Date('2026-09-01T00:00:00Z'),
        arrivedOn: null,
        status: 'PARTLY_ARRIVED',
        departures: [
          {
            id: 'dep-1',
            legId: 'leg-1',
            departedOn: new Date('2026-09-01T00:00:00Z'),
            lines: [{ id: 'depl-1', purchaseOrderItemId: 'item-1', qty: 40 }],
          },
        ],
        deliveries: [
          {
            id: 'del-1',
            legId: 'leg-1',
            arrivedOn: new Date('2026-09-10T00:00:00Z'),
            lines: [{ id: 'dl-1', purchaseOrderItemId: 'item-1', qty: 30 }],
          },
        ],
        // The full loss row the shipment loader reads since B5 (refunds per loss).
        losses: [
          {
            id: 'loss-1',
            legId: 'leg-1',
            purchaseOrderItemId: 'item-1',
            qty: 4,
            unitCostEgp: 110,
            costEgp: 440,
            reason: null,
            createdAt: new Date('2026-09-11T00:00:00Z'),
          },
        ],
      },
      {
        id: 'leg-2',
        sequence: 2,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        departedOn: new Date('2026-09-12T00:00:00Z'),
        arrivedOn: null,
        status: 'PARTLY_ARRIVED',
        // L8: 25 of the 30 that reached Dubai left; 5 are still there.
        departures: [
          {
            id: 'dep-2',
            legId: 'leg-2',
            departedOn: new Date('2026-09-12T00:00:00Z'),
            lines: [{ id: 'depl-2', purchaseOrderItemId: 'item-1', qty: 25 }],
          },
        ],
        deliveries: [
          {
            id: 'del-2',
            legId: 'leg-2',
            arrivedOn: new Date('2026-09-20T00:00:00Z'),
            lines: [{ id: 'dl-2', purchaseOrderItemId: 'item-1', qty: 20 }],
          },
        ],
        losses: [],
      },
    ];
    c.inventoryBatches = [
      {
        sourcePoItemId: 'item-1',
        sourceDeliveryLineId: 'dl-2',
        receivedQty: 15,
      },
    ];
    d.cycles.push(c);
    const { assistant, services } = harness(d);

    const got = dataOf<{
      purchaseOrders: { lines: { id: string }[] }[];
      shippingLegs: { id: string }[];
      shipment: {
        totals: unknown;
        products: Record<string, unknown>[];
        legs: (Record<string, unknown> & { deliveries: unknown[] })[];
      };
    }>(await call(assistant, 'get_cycle', { cycle: 'CYC-2026-0001' }));
    const office = (
      await (services.get(CyclesService) as CyclesService).getShipment(CYCLE_ID)
    ).data;

    // The ids the delivery tools take are there.
    expect(got.purchaseOrders[0].lines[0].id).toBe('item-1');
    expect(got.shippingLegs.map((l) => l.id)).toEqual(['leg-1', 'leg-2']);
    // The figures are the shipment panel's, not worked out again.
    expect(got.shipment.totals).toEqual(office.totals);
    expect(got.shipment.products[0]).toMatchObject({
      product: 'Brake pad',
      ordered: 40,
      received: 15,
      lost: 4,
      onTheWay: 11, // 6 on leg 1, 5 on leg 2
      notLeftYet: 5, // reached Dubai, not on leg 2 yet (L8)
      waiting: 5,
    });
    const [leg1, leg2] = got.shipment.legs;
    expect(leg1).toMatchObject({
      legId: 'leg-1',
      status: 'PARTLY_ARRIVED',
      delivered: 30,
      lost: 4,
      onTheWay: 6,
      waiting: null,
      endsInEgypt: false,
    });
    expect(leg2).toMatchObject({
      legId: 'leg-2',
      status: 'PARTLY_ARRIVED',
      entered: 30,
      waitingAtOrigin: 5,
      departed: 25,
      onTheWay: 5,
      received: 15,
      waiting: 5,
      endsInEgypt: true,
    });
    expect(leg2.deliveries).toEqual([
      {
        deliveryId: 'del-2',
        arrivedOn: '2026-09-20',
        lines: [
          {
            deliveryLineId: 'dl-2',
            purchaseOrderItemId: 'item-1',
            product: 'Brake pad',
            qty: 20,
            received: 15,
          },
        ],
      },
    ]);
    expect(leg2).toMatchObject(
      Object.fromEntries(
        ['status', 'onTheWay', 'waiting', 'lost', 'delivered'].map((k) => [
          k,
          office.legs[1][k as keyof (typeof office.legs)[number]],
        ]),
      ),
    );
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

  it("get_stock: Arrived is the batch's own delivery date, not the cycle's last leg (§14, 2026-10-10)", async () => {
    // The delivery that brought this batch reached Egypt before the leg's
    // last date: the batch shows its own day, not the leg's.
    const d = db();
    const ownDay = new Date('2026-08-15T00:00:00Z');
    d.batches[0].arrivedOn = ownDay;
    const { assistant, services } = harness(d);

    const tool = dataOf<Array<{ batches: Array<{ arrivedOn: string }> }>>(
      await call(assistant, 'get_stock'),
    );
    const office = (
      await (services.get(InventoryService) as InventoryService).getStock({})
    ).data as Array<{ batches: Array<{ arrivedOn: Date }> }>;

    expect(tool[0].batches[0].arrivedOn).toBe(ownDay.toISOString());
    expect(tool[0].batches[0].arrivedOn).toBe(
      office[0].batches[0].arrivedOn.toISOString(),
    );
    expect(tool[0].batches[0].arrivedOn).not.toBe(leg2.toISOString());
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
      isWalkIn: false,
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
      isWalkIn: false,
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

  it('find_products matches the Arabic name and returns both names (§3, 2026-10-14)', async () => {
    const d = db();
    // As the products service stores it: the name and its search key.
    Object.assign(d.products[0], {
      nameAr: 'تيل فرامل أمامي',
      nameArSearch: arabicSearchKey('تيل فرامل أمامي'),
      category: { name: 'Brakes', nameAr: 'فرامل' },
    });
    const { assistant } = harness(d);

    const found = dataOf<
      Array<{
        sku: string;
        name: string;
        nameAr: string | null;
        categoryAr: string | null;
      }>
    >(await call(assistant, 'find_products', { search: 'تيل' }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      sku: 'PRD-000012',
      name: 'Brake Pad Front',
      nameAr: 'تيل فرامل أمامي',
      categoryAr: 'فرامل',
    });

    // Spelled the other way — أ as ا, ي as ى — it is still found (2026-10-15).
    const variant = dataOf<Array<{ sku: string }>>(
      await call(assistant, 'find_products', { search: 'امامى' }),
    );
    expect(variant.map((p) => p.sku)).toEqual(['PRD-000012']);

    // A product with no Arabic name says so with null, not with a guess.
    const [chain] = dataOf<
      Array<{ nameAr: string | null; categoryAr: string | null }>
    >(await call(assistant, 'find_products', { search: 'chain' }));
    expect(chain.nameAr).toBeNull();
    expect(chain.categoryAr).toBeNull();
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

describe('list_receivables', () => {
  const A = '4a1c0de0-0000-4000-8000-00000000000a';
  const B = '4a1c0de0-0000-4000-8000-00000000000b';
  const C = '4a1c0de0-0000-4000-8000-00000000000c';
  const W = '4a1c0de0-0000-4000-8000-0000000000ff';
  const shop = (id: string, name: string, isWalkIn = false) => ({
    id,
    displayName: name,
    phone: null,
    isWalkIn,
  });
  const o = (
    customerId: string,
    status: string,
    outstanding: number,
    at: string,
    name: string,
    isWalkIn = false,
  ) => ({
    id: `${customerId}-${at}`,
    customerId,
    status,
    outstanding,
    orderedAt: new Date(at),
    customer: shop(customerId, name, isWalkIn),
  });
  /** A day `n` days from today, as an instalment's due date comes back. */
  const due = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const iso = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
    return new Date(`${iso}T00:00:00Z`);
  };

  function db(): Db {
    const d = emptyDb();
    d.orders.push(
      o(A, 'CONFIRMED', 3000, '2026-09-10T08:00:00Z', 'Abbasiya Motors'),
      o(A, 'PARTIALLY_PAID', 2000, '2026-08-01T08:00:00Z', 'Abbasiya Motors'),
      o(B, 'CONFIRMED', 9000, '2026-09-20T08:00:00Z', 'Bulaq Bikes'),
      // Not owed: a draft, paid, cancelled; and the walk-in never owes.
      o(C, 'DRAFT', 50000, '2026-09-01T08:00:00Z', 'Corniche Parts'),
      o(C, 'PAID', 0, '2026-09-01T08:00:00Z', 'Corniche Parts'),
      o(C, 'CANCELLED', 7000, '2026-09-01T08:00:00Z', 'Corniche Parts'),
      o(W, 'CONFIRMED', 100, '2026-09-01T08:00:00Z', 'Walk-in', true),
    );
    // Abbasiya promised 2,500 by a week ago and has paid 500 since: 2,000 behind.
    d.plans = [
      {
        id: 'plan-a',
        reference: 'PLAN-2026-0001',
        customerId: A,
        agreedOn: due(-30),
        status: 'ACTIVE',
        customer: { id: A, displayName: 'Abbasiya Motors', phone: null },
        instalments: [
          { id: 'i1', sequence: 1, dueOn: due(-7), amount: 2500, note: null },
          { id: 'i2', sequence: 2, dueOn: due(7), amount: 2500, note: null },
        ],
      },
    ];
    d.paid = { [A]: 500 };
    return d;
  }

  it('every customer who owes, largest balance first, with overdue and the oldest unpaid day', async () => {
    const { assistant } = harness(db());

    const rows = dataOf<Array<Record<string, unknown>>>(
      await call(assistant, 'list_receivables'),
    );

    expect(rows).toEqual([
      {
        customerId: B,
        customer: 'Bulaq Bikes',
        phone: null,
        outstanding: '9000.00',
        overdue: '0.00',
        openOrders: 1,
        oldestUnpaidOn: '2026-09-20',
      },
      {
        customerId: A,
        customer: 'Abbasiya Motors',
        phone: null,
        outstanding: '5000.00',
        overdue: '2000.00',
        openOrders: 2,
        oldestUnpaidOn: '2026-08-01',
      },
    ]);
  });

  it('each balance is the one get_customer gives for the same shop (one rule, CLAUDE.md 11)', async () => {
    const d = db();
    d.customers.push({ ...shop(A, 'Abbasiya Motors'), type: 'B2B' });
    const { assistant } = harness(d);

    const rows = dataOf<Array<{ customerId: string; outstanding: string }>>(
      await call(assistant, 'list_receivables'),
    );
    const one = dataOf<{ balance: string }>(
      await call(assistant, 'get_customer', { customer: A }),
    );

    expect(rows.find((r) => r.customerId === A)!.outstanding).toBe(one.balance);
  });

  it('overdueOnly → only those behind on a plan', async () => {
    const { assistant } = harness(db());

    const rows = dataOf<Array<{ customerId: string }>>(
      await call(assistant, 'list_receivables', { overdueOnly: true }),
    );

    expect(rows.map((r) => r.customerId)).toEqual([A]);
  });

  it('nobody owing → an empty list that says so, not an error', async () => {
    const { assistant } = harness(emptyDb());

    const res = await call(assistant, 'list_receivables');

    expect(dataOf(res)).toEqual([]);
    expect((res.content[0] as { text: string }).text).toContain(
      'Nobody owes anything.',
    );
  });

  it('a limit of 1 shows the largest and says there are more; 0 or a huge one → the default or the cap', async () => {
    const { assistant } = harness(db());

    const one = await call(assistant, 'list_receivables', { limit: 1 });
    expect(dataOf<unknown[]>(one)).toHaveLength(1);
    expect((one.content[0] as { text: string }).text).toContain(
      'showing the first 1',
    );
    expect(
      dataOf<unknown[]>(
        await call(assistant, 'list_receivables', { limit: 0 }),
      ),
    ).toHaveLength(2);
    expect(
      dataOf<unknown[]>(
        await call(assistant, 'list_receivables', { limit: 1_000_000 }),
      ),
    ).toHaveLength(2);
  });

  it('overdueOnly that is not true or false → refused by the schema, nothing read', async () => {
    const { assistant, prisma } = harness(db());

    const res = await call(assistant, 'list_receivables', {
      overdueOnly: 'yes',
    });

    expect(res.isError).toBe(true);
    expect(prisma.saleOrder.findMany).not.toHaveBeenCalled();
  });

  it('reading who owes notifies nobody: the fake has no notification or user table, so trying would fail the call', async () => {
    const { assistant, prisma } = harness(db());
    expect('notification' in prisma || 'user' in prisma).toBe(false);

    const res = await call(assistant, 'list_receivables', {
      overdueOnly: true,
    });

    expect(res.isError).toBeFalsy();
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
  // §16, 2026-10-10: recording a delivery is intake; marking goods lost is not.
  'record_delivery',
  // L8, 2026-10-12: goods leave in parts too, and a later part is intake.
  'record_departure',
  'verify_stock',
  // §2/§16, 2026-10-17: correcting a leg's cost, which re-costs the cycle.
  'update_leg_cost',
  // §16, 2026-10-15: the owner asked for categories, the catalogue beside create_product.
  'create_category',
]);
const OFFICE_ONLY =
  /sale|payment|instal|settle|return|refund|ledger|transaction|allocat|loss|lost/i;

async function toolsOf(server: McpServer): Promise<Tool[]> {
  const client = await connect(server);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

/**
 * §16, 2026-10-11: the assistant can record a sale and, approved by the owner
 * the same day, a payment a shop made — those two tools, and no reversal,
 * allocation, return or settlement besides.
 */
const SALE_WRITES = new Set(['record_sale', 'record_payment']);

/**
 * §16 and §18, 2026-10-11 (L2): what a friend paid a supplier for us, and our
 * repayments to him — through LendersService, every guard the office has.
 */
const LENDER_WRITES = new Set([
  'record_lender_financing',
  'record_lender_repayment',
]);

function forbiddenWrites(tools: Tool[]): string[] {
  return tools
    .filter((t) => t.annotations?.readOnlyHint !== true)
    .filter((t) => !SALE_WRITES.has(t.name))
    .filter((t) => !LENDER_WRITES.has(t.name))
    .filter((t) => !INTAKE_WRITES.has(t.name) || OFFICE_ONLY.test(t.name))
    .map((t) => t.name);
}

describe('What the assistant offers', () => {
  it('tools/list offers no tool that writes instalments, settlements, returns or the ledger, and no sale or payment tool but record_sale, record_payment and the two lender writes', async () => {
    const { assistant } = harness(emptyDb());

    const tools = await toolsOf(assistant.create(partner));

    expect(forbiddenWrites(tools)).toEqual([]);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'record_sale',
        'record_payment',
        'record_lender_financing',
        'record_lender_repayment',
      ]),
    );
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
      'list_receivables',
      'get_dashboard',
      'get_fx_rates',
      'list_lenders',
      'get_lender',
      'list_categories',
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
      'reverse_payment',
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
    writeTool(
      server,
      ctx,
      'mark_goods_lost',
      { title: 'x', description: 'x', inputSchema: {} },
      handlers,
    );

    expect(forbiddenWrites(await toolsOf(server)).sort()).toEqual([
      'mark_goods_lost',
      'reverse_ledger_entry',
      'reverse_payment',
    ]);
  });

  it('tools/list has no tool for marking goods lost or refunding them (§16: office app only)', async () => {
    const { assistant } = harness(emptyDb());

    const tools = await toolsOf(assistant.create(partner));
    const names = tools.map((t) => t.name);

    expect(names).toContain('record_delivery');
    expect(names.filter((n) => /los[st]|refund|write_?off/i.test(n))).toEqual(
      [],
    );
    // No tool takes a loss in through a side door either: nothing writes
    // with a field named for one.
    const lossFields = tools.flatMap((t) =>
      Object.keys(t.inputSchema.properties ?? {})
        .filter((k) => /los[st]/i.test(k))
        .map((k) => `${t.name}.${k}`),
    );
    expect(lossFields).toEqual([]);
  });
});
