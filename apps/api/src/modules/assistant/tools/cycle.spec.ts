/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- an in-memory stand-in for Prisma answers loosely-shaped query objects; the rows it hands the real services are what they would get from the database */
import { randomUUID } from 'node:crypto';
import type { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
// Money in the fake database is Prisma's own Decimal, as the services expect.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the fake store holds real Decimals
import { Prisma } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { businessToday } from '../../../common/dates';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuditService } from '../../audit/audit.service';
import { CostingService } from '../../costing/costing.service';
import { CyclesService } from '../../cycles/cycles.service';
import { InventoryService } from '../../inventory/inventory.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import { ShippingService } from '../../shipping/shipping.service';
import { AssistantServer } from '../assistant-server';
import { ConfirmationService } from '../confirmation.service';
import type { AssistantUser } from '../tool-kit';

/**
 * The cycle tools, driven the way Claude drives them: through a real McpServer
 * and the SDK's client, into the real CyclesService, ShippingService,
 * InventoryService and CostingService. Only the database is fake — an
 * in-memory store answering the queries those services make — so every
 * refusal below is the service's own, and every figure the real arithmetic.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

type Row = Record<string, any>;

interface Store {
  users: Row[];
  cycles: Row[];
  participants: Row[];
  legs: Row[];
  suppliers: Row[];
  products: Row[];
  orders: Row[];
  items: Row[];
  batches: Row[];
  movements: Row[];
  ledger: Row[];
  nonces: Set<string>;
}

let db: Store;

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['jti'] },
  });
}

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'startsWith' in v) {
      return String(row[k]).startsWith(String(v.startsWith));
    }
    return row[k] === v;
  });

function legsOf(cycleId: string) {
  return db.legs
    .filter((l) => l.cycleId === cycleId)
    .sort((a, b) => a.sequence - b.sequence);
}

/** Only the queries the four services make, answered from `db`. */
function fakePrisma() {
  const prisma: Row = {
    importCycle: {
      findUnique: ({ where, include }: Row) => {
        const c = db.cycles.find((x) => x.id === where.id);
        if (!c) return Promise.resolve(null);
        if (!include) return Promise.resolve({ ...c });
        return Promise.resolve({
          ...c,
          shippingLegs: legsOf(c.id),
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
        });
      },
      findFirst: ({ where }: Row) =>
        Promise.resolve(
          db.cycles
            .filter((c) => matches(c, where))
            .sort((a, b) => (a.code < b.code ? 1 : -1))[0] ?? null,
        ),
      create: ({ data }: Row) => {
        const row = { id: randomUUID(), createdAt: new Date(), ...data };
        db.cycles.push(row);
        return Promise.resolve({ ...row });
      },
      update: ({ where, data }: Row) => {
        const c = db.cycles.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data))
          if (v !== undefined) c[k] = v;
        return Promise.resolve({ ...c });
      },
    },
    user: {
      findMany: ({ where }: Row) =>
        Promise.resolve(db.users.filter((u) => matches(u, where))),
    },
    cycleParticipant: {
      create: ({ data }: Row) => {
        const row = { id: randomUUID(), ...data };
        db.participants.push(row);
        return Promise.resolve(row);
      },
      findMany: ({ where }: Row) =>
        Promise.resolve(db.participants.filter((p) => matches(p, where))),
    },
    shippingLeg: {
      findMany: ({ where }: Row) => Promise.resolve(legsOf(where.cycleId)),
      findUnique: ({ where }: Row) =>
        Promise.resolve(
          db.legs.find(
            (l) =>
              l.cycleId === where.cycleId_sequence.cycleId &&
              l.sequence === where.cycleId_sequence.sequence,
          ) ?? null,
        ),
      create: ({ data }: Row) => {
        const row = { id: randomUUID(), ...data };
        db.legs.push(row);
        return Promise.resolve({ ...row });
      },
    },
    purchaseOrder: {
      findMany: ({ where }: Row) =>
        Promise.resolve(
          db.orders
            .filter((o) => matches(o, where))
            .map((o) => ({
              ...o,
              _count: {
                items: db.items.filter((i) => i.purchaseOrderId === o.id)
                  .length,
              },
              supplier: db.suppliers.find((s) => s.id === o.supplierId),
            })),
        ),
      updateMany: ({ where, data }: Row) => {
        const hit = db.orders.filter((o) => matches(o, where));
        for (const o of hit) Object.assign(o, data);
        return Promise.resolve({ count: hit.length });
      },
    },
    purchaseOrderItem: {
      findUnique: ({ where }: Row) => {
        const i = db.items.find((x) => x.id === where.id);
        if (!i) return Promise.resolve(null);
        return Promise.resolve({
          ...i,
          purchaseOrder: db.orders.find((o) => o.id === i.purchaseOrderId),
          product: db.products.find((p) => p.id === i.productId),
        });
      },
      update: ({ where, data }: Row) => {
        const i = db.items.find((x) => x.id === where.id)!;
        Object.assign(i, data);
        return Promise.resolve({ ...i });
      },
    },
    inventoryBatch: {
      findUnique: ({ where }: Row) =>
        Promise.resolve(
          db.batches.find((b) => b.sourcePoItemId === where.sourcePoItemId) ??
            null,
        ),
      create: ({ data }: Row) => {
        // The unique index on the batch's source line.
        if (db.batches.some((b) => b.sourcePoItemId === data.sourcePoItemId)) {
          return Promise.reject(uniqueViolation());
        }
        const row = { id: randomUUID(), createdAt: new Date(), ...data };
        db.batches.push(row);
        return Promise.resolve({ ...row });
      },
      aggregate: ({ where }: Row) =>
        Promise.resolve({
          _sum: {
            saleableQty: db.batches
              .filter((b) => b.productId === where.productId)
              .reduce((s, b) => s.add(b.saleableQty), D(0)),
          },
        }),
    },
    inventoryMovement: {
      create: ({ data }: Row) => {
        db.movements.push(data);
        return Promise.resolve(data);
      },
    },
    financialTransaction: {
      create: ({ data }: Row) => {
        db.ledger.push(data);
        return Promise.resolve(data);
      },
    },
    product: {
      findUnique: ({ where }: Row) =>
        Promise.resolve(db.products.find((p) => p.id === where.id) ?? null),
    },
    usedNonce: {
      create: ({ data }: Row) => {
        if (db.nonces.has(data.jti)) return Promise.reject(uniqueViolation());
        db.nonces.add(data.jti);
        return Promise.resolve(data);
      },
      findUnique: ({ where }: Row) =>
        Promise.resolve(db.nonces.has(where.jti) ? { jti: where.jti } : null),
    },
  };
  prisma.$transaction = (fn: (tx: Row) => Promise<unknown>) => fn(prisma);
  return prisma as unknown as PrismaService;
}

// ─── Fixtures ────────────────────────────────────────────────────────────

const PARTNER_A = randomUUID();
const PARTNER_B = randomUUID();
const SUPPLIER = randomUUID();
const PAD = randomUUID();
const CHAIN = randomUUID();

const partner: AssistantUser = {
  id: PARTNER_A,
  email: 'a@motoparts.test',
  role: 'CORE_PARTNER',
  partner: null,
};

function daysFromToday(n: number): string {
  const d = new Date(`${businessToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function freshStore(): Store {
  return {
    users: [
      {
        id: PARTNER_A,
        email: 'a@motoparts.test',
        role: 'CORE_PARTNER',
        status: 'ACTIVE',
        partner: { displayName: 'Ahmed' },
      },
      {
        id: PARTNER_B,
        email: 'b@motoparts.test',
        role: 'CORE_PARTNER',
        status: 'ACTIVE',
        partner: { displayName: 'Bassem' },
      },
    ],
    cycles: [],
    participants: [],
    legs: [],
    suppliers: [{ id: SUPPLIER, name: 'Yiwu Parts' }],
    products: [
      { id: PAD, name: 'Brake pad', unitWeightKg: null, minStock: null },
      { id: CHAIN, name: 'Chain kit', unitWeightKg: null, minStock: null },
    ],
    orders: [],
    items: [],
    batches: [],
    movements: [],
    ledger: [],
    nonces: new Set(),
  };
}

function cycle(
  status: string,
  originType: 'CHINA' | 'UAE_DIRECT' = 'UAE_DIRECT',
): Row {
  const row = {
    id: randomUUID(),
    code: `CYC-2026-${String(db.cycles.length + 1).padStart(4, '0')}`,
    originType,
    currency: 'EGP',
    status,
    startedOn: new Date(),
  };
  db.cycles.push(row);
  return row;
}

function leg(
  c: Row,
  sequence: number,
  dates: { departedOn?: string; arrivedOn?: string },
  amountEgp = 0,
) {
  db.legs.push({
    id: randomUUID(),
    cycleId: c.id,
    sequence,
    origin:
      sequence === 1 && c.originType === 'CHINA'
        ? 'Guangzhou, CN'
        : 'Dubai, UAE',
    destination:
      sequence === 1 && c.originType === 'CHINA'
        ? 'Dubai, UAE'
        : 'Cairo, Egypt',
    departedOn: dates.departedOn ? new Date(dates.departedOn) : null,
    arrivedOn: dates.arrivedOn ? new Date(dates.arrivedOn) : null,
    status: dates.arrivedOn
      ? 'ARRIVED'
      : dates.departedOn
        ? 'IN_TRANSIT'
        : 'PENDING',
    costBasis: 'FLAT',
    ratePerUnit: null,
    chargeablePieces: null,
    chargeableWeightKg: null,
    amount: D(amountEgp),
    fxRateToEgp: D(1),
    currency: 'EGP',
    amountEgp: D(amountEgp),
  });
}

/** An order with its lines: `[product, orderedQty, unitPrice]`. */
function order(
  c: Row,
  reference: string,
  status: string,
  lines: Array<[string, number, number]>,
  fxRateToEgp = 1,
): Row[] {
  const po = {
    id: randomUUID(),
    cycleId: c.id,
    supplierId: SUPPLIER,
    reference,
    status,
    currency: fxRateToEgp === 1 ? 'EGP' : 'USD',
    fxRateToEgp: D(fxRateToEgp),
  };
  db.orders.push(po);
  return lines.map(([productId, qty, price]) => {
    const item = {
      id: randomUUID(),
      purchaseOrderId: po.id,
      productId,
      orderedQty: D(qty),
      receivedQty: null,
      unitPrice: D(price),
      discount: D(0),
      lineTotal: D(qty).mul(price),
    };
    db.items.push(item);
    return item;
  });
}

// ─── The server, as Claude reaches it ────────────────────────────────────

let client: Client;
let services: {
  cycles: CyclesService;
  shipping: ShippingService;
  inventory: InventoryService;
};

beforeEach(async () => {
  db = freshStore();
  const prisma = fakePrisma();
  const audit = { log: jest.fn() } as unknown as AuditService;
  const notifications = {
    create: jest.fn(),
    createForMultipleUsers: jest.fn(),
  } as unknown as NotificationsService;
  const costing = new CostingService(prisma);
  services = {
    cycles: new CyclesService(prisma, audit, notifications),
    shipping: new ShippingService(prisma, audit, notifications, costing),
    inventory: new InventoryService(prisma, audit, notifications, costing),
  };
  const byType = new Map<unknown, unknown>([
    [CyclesService, services.cycles],
    [ShippingService, services.shipping],
    [InventoryService, services.inventory],
  ]);
  const assistant = new AssistantServer(
    new ConfirmationService(
      new JwtService({ secret: 'a-test-secret-that-is-long-enough-to-pass' }),
      prisma,
    ),
    { get: (type: unknown) => byType.get(type) } as unknown as ModuleRef,
  );

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await assistant.create(partner).connect(serverSide);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
});

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const structured = (r: CallToolResult) =>
  r.structuredContent as {
    status?: string;
    confirmationToken?: string;
    data?: any;
    error?: { code: string; message: string; params?: Record<string, unknown> };
  };
const codeOf = (r: CallToolResult) => structured(r)?.error?.code;
const textOf = (r: CallToolResult) =>
  (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');

/** Preview, then commit with the token the preview handed back. */
async function confirm(name: string, args: Record<string, unknown>) {
  const preview = await call(name, args);
  expect(preview.isError).toBeFalsy();
  const token = structured(preview).confirmationToken!;
  return {
    preview,
    commit: await call(name, { ...args, confirmationToken: token }),
    token,
  };
}

/** Everything a write could touch, for "nothing was written" assertions. */
const snapshot = () =>
  JSON.stringify({
    cycles: db.cycles,
    participants: db.participants,
    legs: db.legs,
    orders: db.orders,
    items: db.items,
    batches: db.batches,
    ledger: db.ledger,
  });

// ─── The plan's edge cases ───────────────────────────────────────────────

describe('create_cycle', () => {
  it.each([
    ['CHINA', 2, ['Guangzhou, CN → Dubai, UAE', 'Dubai, UAE → Cairo, Egypt']],
    ['UAE_DIRECT', 1, ['Dubai, UAE → Cairo, Egypt']],
  ])(
    'create_cycle for %s → created with the right number of legs expected (%i)',
    async (route, legs, routes) => {
      const before = snapshot();
      const preview = await call('create_cycle', { route });

      expect(preview.isError).toBeFalsy();
      expect(snapshot()).toBe(before);
      expect(textOf(preview)).toContain(`ships in ${legs} leg`);
      for (const r of routes) expect(textOf(preview)).toContain(r);
      expect(structured(preview).data.expectedLegs).toHaveLength(legs);

      const commit = await call('create_cycle', {
        route,
        confirmationToken: structured(preview).confirmationToken,
      });

      expect(commit.isError).toBeFalsy();
      expect(structured(commit).data.expectedLegs).toHaveLength(legs);
      expect(db.cycles).toHaveLength(1);
      expect(db.cycles[0]).toMatchObject({
        originType: route,
        status: 'PLANNING',
        code: structured(preview).data.code,
      });
      // The active partners join by default, as in the office app.
      expect(db.participants.map((p) => p.partnerUserId).sort()).toEqual(
        [PARTNER_A, PARTNER_B].sort(),
      );
    },
  );

  it('create_cycle dated in the future → DATE_IN_FUTURE, nothing created', async () => {
    const r = await call('create_cycle', {
      route: 'CHINA',
      startedOn: daysFromToday(3),
    });
    expect(codeOf(r)).toBe('DATE_IN_FUTURE');
    expect(db.cycles).toHaveLength(0);
  });
});

describe('transition_cycle', () => {
  it("transition that skips a status → the service's refusal, surfaced", async () => {
    const c = cycle('PLANNING');
    const r = await call('transition_cycle', {
      cycleId: c.id,
      fromStatus: 'PLANNING',
      status: 'PURCHASING',
    });

    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe('BAD_STATUS_TRANSITION');
    expect(structured(r).error?.params).toMatchObject({
      from: 'PLANNING',
      to: 'PURCHASING',
    });
    expect(c.status).toBe('PLANNING');
  });

  it('transition to an arrival with the leg undated → LEG_NOT_ARRIVED, surfaced', async () => {
    const c = cycle('IN_TRANSIT', 'CHINA');
    leg(c, 1, { departedOn: daysFromToday(-10) }); // left, never dated in

    const r = await call('transition_cycle', {
      cycleId: c.id,
      fromStatus: 'IN_TRANSIT',
      status: 'ARRIVED_UAE',
    });

    expect(codeOf(r)).toBe('LEG_NOT_ARRIVED');
    expect(structured(r).error?.params).toMatchObject({
      leg: 'Guangzhou, CN → Dubai, UAE',
    });
    expect(c.status).toBe('IN_TRANSIT');
  });

  it('preview of a transition past PURCHASING says which orders it will confirm and lock (§15)', async () => {
    const c = cycle('PURCHASING');
    order(c, 'PO-2026-0001', 'DRAFT', [
      [PAD, 10, 4],
      [CHAIN, 5, 9],
    ]);
    order(c, 'PO-2026-0002', 'DRAFT', [[PAD, 3, 4]]);
    const elsewhere = cycle('PURCHASING');
    order(elsewhere, 'PO-2026-0003', 'DRAFT', [[PAD, 1, 4]]);
    const before = snapshot();

    const args = {
      cycleId: c.id,
      fromStatus: 'PURCHASING',
      status: 'ARRIVED_UAE',
    };
    const preview = await call('transition_cycle', args);
    const text = textOf(preview);

    expect(text).toMatch(/confirms and locks 2 purchase orders/);
    expect(text).toContain('PO-2026-0001 (Yiwu Parts), 2 lines');
    expect(text).toContain('PO-2026-0002 (Yiwu Parts), 1 line');
    expect(text).not.toContain('PO-2026-0003');
    expect(
      structured(preview).data.ordersToConfirm.map(
        (o: { reference: string }) => o.reference,
      ),
    ).toEqual(['PO-2026-0001', 'PO-2026-0002']);
    // A preview writes nothing: still purchasing, still drafts.
    expect(snapshot()).toBe(before);

    const commit = await call('transition_cycle', {
      ...args,
      confirmationToken: structured(preview).confirmationToken,
    });
    expect(commit.isError).toBeFalsy();
    expect(c.status).toBe('ARRIVED_UAE');
    expect(
      db.orders.filter((o) => o.cycleId === c.id).map((o) => o.status),
    ).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(db.orders.find((o) => o.cycleId === elsewhere.id)?.status).toBe(
      'DRAFT',
    );
  });

  it('preview of a cancel says it is final', async () => {
    const c = cycle('PURCHASING');
    order(c, 'PO-2026-0001', 'DRAFT', [[PAD, 10, 4]]);

    const args = {
      cycleId: c.id,
      fromStatus: 'PURCHASING',
      status: 'CANCELLED',
    };
    const preview = await call('transition_cycle', args);

    expect(textOf(preview)).toMatch(/Cancelling is final/);
    expect(textOf(preview)).toMatch(/cannot be reopened/);
    expect(structured(preview).data.final).toBe(true);
    // §15: a cancelled cycle ordered nothing, so nothing is confirmed.
    expect(structured(preview).data.ordersToConfirm).toEqual([]);
    expect(textOf(preview)).not.toContain('confirms and locks');

    await call('transition_cycle', {
      ...args,
      confirmationToken: structured(preview).confirmationToken,
    });
    expect(c.status).toBe('CANCELLED');
    expect(db.orders[0].status).toBe('DRAFT');

    // And it is: nothing moves a cancelled cycle.
    const reopen = await call('transition_cycle', {
      cycleId: c.id,
      fromStatus: 'CANCELLED',
      status: 'PLANNING',
    });
    expect(codeOf(reopen)).toBe('BAD_STATUS_TRANSITION');
  });

  it('a transition past PURCHASING with an empty draft order is refused before anything is locked', async () => {
    const c = cycle('PURCHASING');
    order(c, 'PO-2026-0001', 'DRAFT', [[PAD, 10, 4]]);
    order(c, 'PO-2026-0002', 'DRAFT', []);
    const r = await call('transition_cycle', {
      cycleId: c.id,
      fromStatus: 'PURCHASING',
      status: 'ARRIVED_UAE',
    });
    expect(codeOf(r)).toBe('PO_HAS_NO_ITEMS');
    expect(db.orders.map((o) => o.status)).toEqual(['DRAFT', 'DRAFT']);
  });

  it('the same confirmation used after the cycle changed status between preview and commit → CYCLE_STATUS_CHANGED, nothing changed', async () => {
    const c = cycle('FUNDING');
    const args = { cycleId: c.id, fromStatus: 'FUNDING', status: 'CANCELLED' };
    const preview = await call('transition_cycle', args);
    expect(preview.isError).toBeFalsy();

    // Another partner moves it on in the office app in the meantime.
    await services.cycles.transition(c.id, 'PURCHASING', PARTNER_B);

    // PURCHASING → CANCELLED is itself allowed, so only the status the partner
    // confirmed against stands between this "yes" and a cycle they never saw.
    const commit = await call('transition_cycle', {
      ...args,
      confirmationToken: structured(preview).confirmationToken,
    });
    expect(codeOf(commit)).toBe('CYCLE_STATUS_CHANGED');
    expect(structured(commit).error?.params).toMatchObject({
      status: 'PURCHASING',
      expected: 'FUNDING',
    });
    expect(c.status).toBe('PURCHASING');
  });

  it('a draft order created between preview and commit → PREVIEW_CHANGED, nothing locked unseen', async () => {
    const c = cycle('PURCHASING');
    order(c, 'PO-2026-0001', 'DRAFT', [[PAD, 10, 4]]);
    const args = {
      cycleId: c.id,
      fromStatus: 'PURCHASING',
      status: 'ARRIVED_UAE',
    };
    const preview = await call('transition_cycle', args);
    expect(textOf(preview)).not.toContain('PO-2026-0002');

    // Someone records another receipt on the cycle in the meantime.
    order(c, 'PO-2026-0002', 'DRAFT', [[CHAIN, 5, 9]]);
    const token = structured(preview).confirmationToken;

    const commit = await call('transition_cycle', {
      ...args,
      confirmationToken: token,
    });
    expect(codeOf(commit)).toBe('PREVIEW_CHANGED');
    expect(c.status).toBe('PURCHASING');
    expect(db.orders.map((o) => o.status)).toEqual(['DRAFT', 'DRAFT']);

    // The refusal did not spend the partner's "yes" on nothing: a new preview
    // names both orders, and confirming that one goes through.
    const again = await call('transition_cycle', args);
    expect(textOf(again)).toContain('PO-2026-0002');
    const done = await call('transition_cycle', {
      ...args,
      confirmationToken: structured(again).confirmationToken,
    });
    expect(done.isError).toBeFalsy();
    expect(db.orders.map((o) => o.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
  });

  it('a line added to a previewed draft before commit → PREVIEW_CHANGED', async () => {
    const c = cycle('PURCHASING');
    const [pad] = order(c, 'PO-2026-0001', 'DRAFT', [[PAD, 10, 4]]);
    const args = {
      cycleId: c.id,
      fromStatus: 'PURCHASING',
      status: 'ARRIVED_UAE',
    };
    const preview = await call('transition_cycle', args);

    // Someone adds a line to that draft in the office app.
    db.items.push({
      ...pad,
      id: randomUUID(),
      productId: CHAIN,
      orderedQty: D(5),
      unitPrice: D(9),
      lineTotal: D(45),
    });

    const commit = await call('transition_cycle', {
      ...args,
      confirmationToken: structured(preview).confirmationToken,
    });
    expect(codeOf(commit)).toBe('PREVIEW_CHANGED');
    expect(db.orders[0].status).toBe('DRAFT');
  });

  it('settling or closing a cycle is not offered to the assistant (§16: intake only)', async () => {
    const c = cycle('SELLING');
    const r = await call('transition_cycle', {
      cycleId: c.id,
      fromStatus: 'SELLING',
      status: 'SETTLEMENT',
    });
    expect(r.isError).toBe(true);
    expect(c.status).toBe('SELLING');

    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === 'transition_cycle')!
      .inputSchema as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.status.enum).not.toContain('SETTLEMENT');
    expect(schema.properties.status.enum).not.toContain('CLOSED');
  });
});

describe('add_shipping_leg', () => {
  it('add_shipping_leg with arrivedOn in the future → refused', async () => {
    const c = cycle('PURCHASING');
    const r = await call('add_shipping_leg', {
      cycleId: c.id,
      sequence: 1,
      departedOn: daysFromToday(-2),
      arrivedOn: daysFromToday(2),
      amount: 1000,
    });

    expect(codeOf(r)).toBe('DATE_IN_FUTURE');
    expect(db.legs).toHaveLength(0);
  });

  it('add_shipping_leg with departedOn in the future → refused', async () => {
    const c = cycle('PURCHASING');
    const r = await call('add_shipping_leg', {
      cycleId: c.id,
      sequence: 1,
      departedOn: daysFromToday(1),
      amount: 1000,
    });
    expect(codeOf(r)).toBe('DATE_IN_FUTURE');
    expect(db.legs).toHaveLength(0);
  });

  it('previews the cost in EGP and the status the dates give, then saves exactly that', async () => {
    const c = cycle('PURCHASING', 'CHINA');
    const args = {
      cycleId: c.id,
      sequence: 2,
      departedOn: daysFromToday(-3),
      costBasis: 'PER_PIECE',
      ratePerUnit: 1.5,
      chargeablePieces: 40,
      currency: 'USD',
      fxRateToEgp: 48.5,
    };
    const { preview, commit } = await confirm('add_shipping_leg', args);

    expect(textOf(preview)).toContain('Dubai, UAE → Cairo, Egypt');
    expect(textOf(preview)).toContain('IN_TRANSIT');
    expect(textOf(preview)).toContain('60.00 USD × 48.5 = 2,910.00 EGP');
    expect(commit.isError).toBeFalsy();
    expect(db.legs).toHaveLength(1);
    expect(db.legs[0].amountEgp.toFixed(2)).toBe(
      structured(preview).data.amountEgp,
    );
    expect(db.legs[0].status).toBe('IN_TRANSIT');
  });

  it('a leg on a closed or cancelled cycle → CYCLE_FINAL_NO_LEGS', async () => {
    for (const status of ['CLOSED', 'CANCELLED']) {
      const c = cycle(status);
      const r = await call('add_shipping_leg', {
        cycleId: c.id,
        sequence: 1,
        amount: 500,
      });
      expect(codeOf(r)).toBe('CYCLE_FINAL_NO_LEGS');
    }
    expect(db.legs).toHaveLength(0);
  });

  it('a leg on a cycle that does not exist → NOT_FOUND, never a 500', async () => {
    const r = await call('add_shipping_leg', {
      cycleId: randomUUID(),
      sequence: 1,
      amount: 500,
    });
    expect(codeOf(r)).toBe('NOT_FOUND');
  });

  it('a third leg on a China cycle, or a second on a UAE-direct one → refused by the route', async () => {
    const china = cycle('PURCHASING', 'CHINA');
    const uae = cycle('PURCHASING', 'UAE_DIRECT');
    expect(
      codeOf(
        await call('add_shipping_leg', { cycleId: china.id, sequence: 3 }),
      ),
    ).toBe('CHINA_TWO_LEGS');
    expect(
      codeOf(await call('add_shipping_leg', { cycleId: uae.id, sequence: 2 })),
    ).toBe('UAE_DIRECT_ONE_LEG');
  });

  it('the same leg twice → LEG_SEQUENCE_TAKEN on the second', async () => {
    const c = cycle('PURCHASING');
    const args = { cycleId: c.id, sequence: 1, amount: 500 };
    const { commit } = await confirm('add_shipping_leg', args);
    expect(commit.isError).toBeFalsy();
    expect(codeOf(await call('add_shipping_leg', args))).toBe(
      'LEG_SEQUENCE_TAKEN',
    );
    expect(db.legs).toHaveLength(1);
  });
});

describe('verify_stock', () => {
  /** A UAE-direct cycle in verification, its goods landed, its leg dated. */
  function landedCycle(legAmountEgp = 400) {
    const c = cycle('VERIFICATION');
    leg(
      c,
      1,
      { departedOn: daysFromToday(-12), arrivedOn: daysFromToday(-4) },
      legAmountEgp,
    );
    const [pad, chain] = order(
      c,
      'PO-2026-0001',
      'CONFIRMED',
      [
        [PAD, 10, 4], // 40 USD → 100.00 EGP
        [CHAIN, 30, 2], // 60 USD → 150.00 EGP
      ],
      2.5,
    );
    return { c, pad, chain };
  }

  it('verify_stock preview shows the landed unit cost per line before anything is written (money)', async () => {
    const { c, pad, chain } = landedCycle();
    const before = snapshot();

    // 25 of the 30 chain kits arrived. The 400 EGP leg spreads over the 35
    // pieces that came: 114.29 to the pads, 285.71 to the chains.
    const args = {
      cycleId: c.id,
      items: [
        { purchaseOrderItemId: pad.id, receivedQty: 10 },
        { purchaseOrderItemId: chain.id, receivedQty: 25 },
      ],
    };
    const preview = await call('verify_stock', args);
    const text = textOf(preview);

    expect(preview.isError).toBeFalsy();
    expect(text).toContain(
      'Brake pad: 10 of 10 ordered, landed 21.4290 EGP/unit = 214.29 EGP',
    );
    expect(text).toContain(
      'Chain kit: 25 of 30 ordered, landed 17.4284 EGP/unit = 435.71 EGP',
    );
    expect(text).toContain('Total booked to the cycle: 650.00 EGP');
    expect(structured(preview).data.lines).toEqual([
      expect.objectContaining({
        landedUnitCostEgp: '21.4290',
        lineCostEgp: '214.29',
      }),
      expect.objectContaining({
        landedUnitCostEgp: '17.4284',
        lineCostEgp: '435.71',
      }),
    ]);
    // Before anything is written.
    expect(snapshot()).toBe(before);

    const commit = await call('verify_stock', {
      ...args,
      confirmationToken: structured(preview).confirmationToken,
    });
    expect(commit.isError).toBeFalsy();
    // What was shown is what was booked — on the batch and on the ledger.
    expect(
      db.batches.map((b) => [b.productId, b.landedUnitCostEgp.toFixed(4)]),
    ).toEqual([
      [PAD, '21.4290'],
      [CHAIN, '17.4284'],
    ]);
    expect(db.ledger.map((t) => t.amount.toFixed(2))).toEqual([
      '214.29',
      '435.71',
    ]);
  });

  it('a leg cost corrected between preview and commit → PREVIEW_CHANGED, nothing booked at an unseen cost', async () => {
    const { c, pad, chain } = landedCycle();
    const args = {
      cycleId: c.id,
      items: [
        { purchaseOrderItemId: pad.id, receivedQty: 10 },
        { purchaseOrderItemId: chain.id, receivedQty: 25 },
      ],
    };
    const preview = await call('verify_stock', args);
    expect(preview.isError).toBeFalsy();

    // The shipping invoice is corrected in the office app: 400 → 700 EGP.
    db.legs[0].amount = D(700);

    const commit = await call('verify_stock', {
      ...args,
      confirmationToken: structured(preview).confirmationToken,
    });
    expect(codeOf(commit)).toBe('PREVIEW_CHANGED');
    expect(db.batches).toHaveLength(0);
    expect(db.ledger).toHaveLength(0);
  });

  it('verify_stock twice for one order line → STOCK_ALREADY_VERIFIED, surfaced', async () => {
    const { c, pad } = landedCycle();
    const args = {
      cycleId: c.id,
      items: [{ purchaseOrderItemId: pad.id, receivedQty: 10 }],
    };
    const { commit } = await confirm('verify_stock', args);
    expect(commit.isError).toBeFalsy();

    const again = await call('verify_stock', args);
    expect(again.isError).toBe(true);
    expect(codeOf(again)).toBe('STOCK_ALREADY_VERIFIED');
    expect(db.batches).toHaveLength(1);
    expect(db.ledger).toHaveLength(1);
  });

  it('verifying more than was ordered → RECEIVED_EXCEEDS_ORDERED, nothing written', async () => {
    const { c, pad } = landedCycle();
    const r = await call('verify_stock', {
      cycleId: c.id,
      items: [{ purchaseOrderItemId: pad.id, receivedQty: 11 }],
    });
    expect(codeOf(r)).toBe('RECEIVED_EXCEEDS_ORDERED');
    expect(structured(r).error?.params).toMatchObject({
      product: 'Brake pad',
      received: '11',
      ordered: '10',
    });
    expect(db.batches).toHaveLength(0);
  });

  it.each([0, -3])(
    'verifying a quantity of %i → QTY_NOT_POSITIVE, nothing written',
    async (qty) => {
      const { c, pad } = landedCycle();
      const r = await call('verify_stock', {
        cycleId: c.id,
        items: [{ purchaseOrderItemId: pad.id, receivedQty: qty }],
      });
      expect(codeOf(r)).toBe('QTY_NOT_POSITIVE');
      expect(db.batches).toHaveLength(0);
    },
  );

  it('a negative landed cost typed by hand → VALIDATION_FAILED', async () => {
    const { c, pad } = landedCycle();
    const r = await call('verify_stock', {
      cycleId: c.id,
      items: [
        { purchaseOrderItemId: pad.id, receivedQty: 10, landedUnitCostEgp: -1 },
      ],
    });
    expect(codeOf(r)).toBe('VALIDATION_FAILED');
    expect(db.batches).toHaveLength(0);
  });

  it('the same line listed twice in one receipt → VALIDATION_FAILED, not a 500', async () => {
    const { c, pad } = landedCycle();
    const r = await call('verify_stock', {
      cycleId: c.id,
      items: [
        { purchaseOrderItemId: pad.id, receivedQty: 4 },
        { purchaseOrderItemId: pad.id, receivedQty: 4 },
      ],
    });
    expect(codeOf(r)).toBe('VALIDATION_FAILED');
    expect(db.batches).toHaveLength(0);
  });

  it("another cycle's order line → PO_ITEM_NOT_IN_CYCLE", async () => {
    const { c } = landedCycle();
    const other = landedCycle();
    const r = await call('verify_stock', {
      cycleId: c.id,
      items: [{ purchaseOrderItemId: other.pad.id, receivedQty: 1 }],
    });
    expect(codeOf(r)).toBe('PO_ITEM_NOT_IN_CYCLE');
  });

  it('a cycle not in verification → CYCLE_NOT_IN_VERIFICATION', async () => {
    const { c, pad } = landedCycle();
    c.status = 'ARRIVED_EGYPT';
    const r = await call('verify_stock', {
      cycleId: c.id,
      items: [{ purchaseOrderItemId: pad.id, receivedQty: 10 }],
    });
    expect(codeOf(r)).toBe('CYCLE_NOT_IN_VERIFICATION');
  });

  it('an empty receipt → VALIDATION_FAILED', async () => {
    const { c } = landedCycle();
    const r = await call('verify_stock', { cycleId: c.id, items: [] });
    expect(codeOf(r)).toBe('VALIDATION_FAILED');
  });

  it('a confirmation replayed after the stock was booked books nothing more', async () => {
    const { c, pad } = landedCycle();
    const args = {
      cycleId: c.id,
      items: [{ purchaseOrderItemId: pad.id, receivedQty: 10 }],
    };
    const { token } = await confirm('verify_stock', args);
    const replay = await call('verify_stock', {
      ...args,
      confirmationToken: token,
    });
    expect(codeOf(replay)).toBe('CONFIRMATION_USED');
    expect(db.batches).toHaveLength(1);
  });
});

describe('an id that is not a UUID', () => {
  it.each([
    ['transition_cycle', { fromStatus: 'PLANNING', status: 'FUNDING' }],
    ['add_shipping_leg', { sequence: 1, amount: 10 }],
    ['verify_stock', { items: [] }],
  ])(
    '%s with cycleId "CYC-2026-0001" → VALIDATION_FAILED, never INTERNAL_SERVER_ERROR',
    async (tool, rest) => {
      const r = await call(tool, { cycleId: 'CYC-2026-0001', ...rest });
      expect(codeOf(r)).toBe('VALIDATION_FAILED');
      expect(structured(r).error?.params).toMatchObject({ fields: 'cycleId' });
    },
  );

  it('verify_stock with an order line id that is not a UUID → VALIDATION_FAILED', async () => {
    const c = cycle('VERIFICATION');
    const r = await call('verify_stock', {
      cycleId: c.id,
      items: [{ purchaseOrderItemId: 'line-1', receivedQty: 1 }],
    });
    expect(codeOf(r)).toBe('VALIDATION_FAILED');
  });
});
