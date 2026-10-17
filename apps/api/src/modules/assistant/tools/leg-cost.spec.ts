/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the fake database's rows are untyped records, as Prisma's argument objects are */
import { randomUUID } from 'node:crypto';
import type { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the fake's unique violation is Prisma's own error, as the confirmation service expects
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { CostingService } from '../../costing/costing.service';
import { CyclesService } from '../../cycles/cycles.service';
import { InventoryService } from '../../inventory/inventory.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PaymentsService } from '../../payments/payments.service';
import { SalesService } from '../../sales/sales.service';
import { DeliveriesService } from '../../shipping/deliveries.service';
import { ShippingService } from '../../shipping/shipping.service';
import {
  addLeg,
  cycleWithOrder,
  D,
  emptyStore,
  fakePrisma,
  receive as receiveUnbooked,
  type Row,
  type Store,
} from '../../shipping/shipment-fake-spec';
import { AssistantServer } from '../assistant-server';
import { ConfirmationService } from '../confirmation.service';
import type { AssistantUser } from '../tool-kit';

/**
 * update_leg_cost — correcting a leg's cost from the assistant (owner
 * 2026-10-17: "did we add it to the assistant as well?"; BUSINESS_LOGIC §2,
 * §16).
 *
 * Driven as Claude drives it — the SDK's client over a real McpServer — into
 * the real shipping, deliveries, inventory, sales and costing services, on the
 * in-memory fake that rolls a failed transaction back. The preview is
 * `ShippingService.updateLeg` itself, re-cost included, rolled back; so a
 * preview that kept anything would show in the "nothing written" checks, and
 * a preview that disagreed with the commit would show in the figures.
 *
 * Every state is built the way the business builds it (CLAUDE.md rule 4): an
 * order, a departed leg, a delivery, a verified receipt, a confirmed sale.
 */

const NOW = new Date('2026-10-17T09:00:00Z');
beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    now: NOW,
  });
});
afterEach(() => jest.useRealTimers());

const partner: AssistantUser = {
  id: randomUUID(),
  email: 'a@motoparts.test',
  role: 'CORE_PARTNER',
  partner: null,
};

let db: Store;
let assistant: AssistantServer;
let client: Client;
let deliveries: DeliveriesService;
let inventory: InventoryService;
let sales: SalesService;
let shipping: ShippingService;

async function connectAs(user: AssistantUser) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await assistant.create(user).connect(serverSide);
  const c = new Client({ name: 'test', version: '1.0.0' });
  await c.connect(clientSide);
  return c;
}

beforeEach(async () => {
  db = emptyStore();
  const prisma = fakePrisma(db) as unknown as Row;
  const nonces = new Set<string>();
  prisma.usedNonce = {
    create: ({ data }: Row) => {
      if (nonces.has(data.jti)) {
        return Promise.reject(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        );
      }
      nonces.add(data.jti);
      return Promise.resolve(data);
    },
    findUnique: ({ where }: Row) =>
      Promise.resolve(nonces.has(where.jti) ? { jti: where.jti } : null),
  };
  // Only what update_leg_cost reads to name a cycle by its code.
  const findUnique = prisma.importCycle.findUnique;
  prisma.importCycle.findUnique = (args: Row) =>
    args.where.code !== undefined
      ? Promise.resolve(
          db.cycles.find((c) => c.code === args.where.code) ?? null,
        )
      : findUnique(args);
  const findMany = prisma.importCycle.findMany;
  prisma.importCycle.findMany = (args: Row = {}) =>
    args.where?.code?.mode === 'insensitive'
      ? Promise.resolve(
          db.cycles.filter(
            (c) =>
              c.code.toLowerCase() === args.where.code.equals.toLowerCase(),
          ),
        )
      : findMany(args);
  const p = prisma as unknown as PrismaService;

  const audit = { log: jest.fn() } as unknown as AuditService;
  const notify = {
    createForMultipleUsers: jest.fn(),
    create: jest.fn(),
  } as unknown as NotificationsService;
  const costing = new CostingService(p);
  const cycles = new CyclesService(p, audit, notify);
  deliveries = new DeliveriesService(p, audit, notify, costing, cycles);
  shipping = new ShippingService(p, audit, costing, deliveries);
  inventory = new InventoryService(p, audit, notify, costing, cycles);
  sales = new SalesService(p, audit, new PaymentsService(p, audit), {
    createForMultipleUsers: () => Promise.resolve({ count: 0 }),
  });

  const byType = new Map<unknown, unknown>([
    [PrismaService, p],
    [AuditService, audit],
    [NotificationsService, notify],
    [CostingService, costing],
    [CyclesService, cycles],
    [DeliveriesService, deliveries],
    [ShippingService, shipping],
    [InventoryService, inventory],
  ]);
  assistant = new AssistantServer(
    new ConfirmationService(
      new JwtService({ secret: 'a-test-secret-that-is-long-enough-to-pass' }),
      p,
    ),
    { get: (type: unknown) => byType.get(type) } as unknown as ModuleRef,
  );
  client = await connectAs(partner);
});

afterEach(async () => {
  await client.close();
});

// ─── Calling the tool ────────────────────────────────────────────────────

async function call(
  args: Record<string, unknown>,
  as: Client = client,
): Promise<CallToolResult> {
  return (await as.callTool({
    name: 'update_leg_cost',
    arguments: args,
  })) as CallToolResult;
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

async function preview(args: Record<string, unknown>) {
  const r = await call(args);
  expect(r.isError ? textOf(r) : '').toBe('');
  expect(structured(r).status).toBe('preview');
  return r;
}

const commitWith = (args: Record<string, unknown>, shown: CallToolResult) =>
  call({ ...args, confirmationToken: structured(shown).confirmationToken });

/** Everything a re-cost could touch. */
const snapshot = () =>
  JSON.stringify({
    legs: db.legs,
    batches: db.batches,
    ledger: db.ledger,
    allocations: db.allocations,
    cycles: db.cycles,
    deliveries: db.deliveries,
  });

// ─── Building states the business recognises (CLAUDE.md rule 4) ──────────

/**
 * A UAE-direct cycle in Egypt: 40 brake pads at 100 (goods 4,000) on one
 * departed Dubai → Cairo leg costing 400 FLAT, so a unit lands at 110.00.
 */
function arrived(status = 'ARRIVED_EGYPT') {
  const { cycle, items } = cycleWithOrder(db, { status });
  const leg = addLeg(db, cycle, 1, { departedOn: '2026-09-01' });
  return { cycle, item: items[0], leg };
}

async function deliver(leg: Row, item: Row, qty: number) {
  const { data } = await deliveries.recordDelivery(
    leg.id,
    { arrivedOn: '2026-09-20', lines: [{ purchaseOrderItemId: item.id, qty }] },
    partner.id,
  );
  return data as Row;
}

/** Counted in at the receive dialog, booked at the computed landed cost. */
const receive = (
  cycle: Row,
  delivery: Row,
  qty: number,
  extra: Record<string, unknown> = {},
) =>
  inventory.verifyStock(
    cycle.id,
    {
      deliveryId: delivery.id,
      items: [
        { deliveryLineId: delivery.lines[0].id, receivedQty: qty, ...extra },
      ],
    },
    partner.id,
  );

/** A shop, and a confirmed sale of `qty` brake pads at 200. */
async function sell(productId: string, qty: number) {
  if (db.customers.length === 0) {
    db.customers.push({
      id: randomUUID(),
      displayName: 'Nile Motors',
      type: 'B2B',
      verificationStatus: 'VERIFIED',
    });
  }
  await sales.create(
    {
      customerId: db.customers[0].id,
      channel: 'B2B',
      currency: 'EGP',
      items: [{ productId, quantity: qty, unitPrice: 200, discount: 0 }],
      confirm: true,
    },
    partner.id,
  );
}

/** All 40 delivered and received, 10 of them sold. */
async function receivedAndSold() {
  const world = arrived();
  const delivery = await deliver(world.leg, world.item, 40);
  await receive(world.cycle, delivery, 40);
  await sell(world.item.productId, 10);
  return world;
}

const batch = () => db.batches[0];
const purchaseRow = () =>
  db.ledger.find(
    (t) =>
      t.type === 'PURCHASE_COST' && t.relatedType === 'PURCHASE_ORDER_ITEM',
  )!;

// ─── The preview and the commit ──────────────────────────────────────────

describe('update_leg_cost after goods were received and sold', () => {
  it('the preview shows the leg before → after and each product before → after with its sold units, and writes nothing', async () => {
    const { cycle, item } = await receivedAndSold();
    expect(batch().landedUnitCostEgp.toFixed(2)).toBe('110.00');
    const before = snapshot();

    const shown = await preview({
      cycle: cycle.code,
      sequence: 1,
      amount: 800,
    });

    expect(snapshot()).toBe(before);
    const text = textOf(shown);
    expect(text).toContain(
      `Correct the cost of leg 1 of ${cycle.code} (Dubai, UAE → Cairo, Egypt):`,
    );
    expect(text).toContain('400.00 EGP FLAT → 800.00 EGP FLAT.');
    expect(text).toContain(
      `Goods of ${cycle.code} were already received (40 units), so this re-costs the whole cycle`,
    );
    expect(text).toContain(
      '- Brake pad: 110.0000 → 120.0000 EGP; 40 received are re-costed, 10 of them already sold',
    );
    expect(structured(shown).data).toMatchObject({
      cycle: cycle.code,
      leg: 1,
      recostsCycle: true,
      before: { amountEgp: '400' },
      after: { amountEgp: '800' },
      products: [
        {
          purchaseOrderItemId: item.id,
          unitBefore: '110.0000',
          unitAfter: '120.0000',
          received: '40',
          sold: '10',
        },
      ],
    });
  });

  it('the commit with the token applies exactly what the preview showed — leg, stock, purchase entry, sold units', async () => {
    const { cycle, leg } = await receivedAndSold();
    const args = { cycle: cycle.code, sequence: 1, amount: 800 };
    const shown = await preview(args);

    const done = await commitWith(args, shown);

    expect(done.isError ? textOf(done) : '').toBe('');
    expect(structured(done).status).toBe('committed');
    expect(textOf(done)).toContain(
      `Leg 1 of ${cycle.code} (Dubai, UAE → Cairo, Egypt) now costs 800.00 EGP FLAT.`,
    );
    const row = db.legs.find((l) => l.id === leg.id)!;
    expect(row.amountEgp.toFixed(2)).toBe('800.00');
    expect(batch().landedUnitCostEgp.toFixed(4)).toBe(
      structured(shown).data.products[0].unitAfter,
    );
    expect(purchaseRow().amount.toFixed(2)).toBe('4800.00');
    expect(db.allocations).toHaveLength(1);
    expect(D(db.allocations[0].unitCostEgp).toFixed(2)).toBe('120.00');
    expect(D(db.allocations[0].cogsEgp).toFixed(2)).toBe('1200.00');
  });

  it('a second correction after the first works, and starts from the first one', async () => {
    const { cycle } = await receivedAndSold();
    const first = { cycle: cycle.code, sequence: 1, amount: 800 };
    await commitWith(first, await preview(first));

    const second = { cycle: cycle.code, sequence: 1, amount: 600 };
    const shown = await preview(second);
    expect(textOf(shown)).toContain('800.00 EGP FLAT → 600.00 EGP FLAT.');
    expect(textOf(shown)).toContain('- Brake pad: 120.0000 → 115.0000 EGP');
    const done = await commitWith(second, shown);

    expect(done.isError ? textOf(done) : '').toBe('');
    expect(batch().landedUnitCostEgp.toFixed(2)).toBe('115.00');
    expect(purchaseRow().amount.toFixed(2)).toBe('4600.00');
  });

  it('a USD per-piece cost: the preview shows it in USD and in EGP', async () => {
    const { leg } = await receivedAndSold();
    const shown = await preview({
      legId: leg.id,
      costBasis: 'PER_PIECE',
      ratePerUnit: 0.5,
      chargeablePieces: 40,
      currency: 'USD',
      fxRateToEgp: 50,
    });
    expect(textOf(shown)).toContain(
      '400.00 EGP FLAT → 20.00 USD (0.50 × 40 pieces) PER_PIECE × 50 = 1,000.00 EGP.',
    );
    expect(textOf(shown)).toContain('- Brake pad: 110.0000 → 125.0000 EGP');
  });
});

describe('update_leg_cost before anything was received', () => {
  it('says nothing booked changes, and the commit moves the cost', async () => {
    const { cycle, leg } = arrived('IN_TRANSIT');
    const args = { cycle: cycle.code.toLowerCase(), sequence: 1, amount: 500 };
    const shown = await preview(args);
    expect(textOf(shown)).toContain(
      `Nothing of ${cycle.code} has been received yet, so nothing already booked changes`,
    );
    expect(textOf(shown)).toContain('- Brake pad: 110.0000 → 112.5000 EGP');
    expect(structured(shown).data.recostsCycle).toBe(false);

    const done = await commitWith(args, shown);
    expect(done.isError ? textOf(done) : '').toBe('');
    expect(db.legs.find((l) => l.id === leg.id)!.amountEgp.toFixed(2)).toBe(
      '500.00',
    );
  });

  it('delivered but not yet received: the preview says those will be received at the new cost', async () => {
    const { cycle, item, leg } = arrived();
    await deliver(leg, item, 40);
    const shown = await preview({
      cycle: cycle.code,
      sequence: 1,
      amount: 500,
    });
    expect(textOf(shown)).toContain(
      '40 units delivered to Egypt and not yet received will be received at the new cost.',
    );
  });
});

// ─── Nothing to change ───────────────────────────────────────────────────

describe('update_leg_cost to what the leg already costs', () => {
  it.each([
    ['the same amount', { amount: 400 }],
    ['no cost field at all', {}],
  ])('%s → LEG_COST_UNCHANGED, no token, nothing written', async (_, cost) => {
    const { cycle } = await receivedAndSold();
    const before = snapshot();
    const r = await call({ cycle: cycle.code, sequence: 1, ...cost });
    expect(codeOf(r)).toBe('LEG_COST_UNCHANGED');
    expect(structured(r).confirmationToken).toBeUndefined();
    expect(textOf(r)).toContain('nothing would change');
    expect(snapshot()).toBe(before);
  });
});

// ─── Locked costs ────────────────────────────────────────────────────────

describe('a cost that can no longer change comes back as the refusal, with no token', () => {
  const cases: [string, () => Promise<Row>][] = [
    [
      'LEG_COST_LOCKED_SETTLEMENT',
      async () => {
        const w = await receivedAndSold();
        db.settlements.push({
          id: randomUUID(),
          cycleId: w.cycle.id,
          status: 'DRAFT',
        });
        return w;
      },
    ],
    [
      'LEG_COST_LOCKED_LOSSES',
      async () => {
        const w = arrived();
        await deliveries.recordLoss(
          w.leg.id,
          { lines: [{ purchaseOrderItemId: w.item.id, qty: 1 }] },
          partner.id,
        );
        return w;
      },
    ],
    [
      'LEG_COST_LOCKED_TRANSFERS',
      async () => {
        const w = await receivedAndSold();
        const other = cycleWithOrder(db, { status: 'SELLING' }).cycle;
        db.transfers.push({
          id: randomUUID(),
          status: 'ACTIVE',
          fromCycleId: w.cycle.id,
          toCycleId: other.id,
          createdAt: new Date(),
          createdBy: null,
          reversedBy: null,
        });
        return w;
      },
    ],
    [
      'LEG_COST_LOCKED_OVERRIDE',
      async () => {
        const w = arrived();
        const delivery = await deliver(w.leg, w.item, 40);
        await receive(w.cycle, delivery, 40, { landedUnitCostEgp: 150 });
        return w;
      },
    ],
    [
      'LEG_COST_LOCKED_LEDGER',
      async () => {
        // A batch with no purchase entry beside it.
        const w = arrived();
        const delivery = await deliver(w.leg, w.item, 40);
        receiveUnbooked(db, w.cycle, delivery.lines[0], 40);
        return w;
      },
    ],
    [
      'LEG_COST_LOCKED',
      async () => {
        // Stock in the cycle that came from none of its order lines.
        const w = await receivedAndSold();
        db.batches.push({
          ...batch(),
          id: randomUUID(),
          sourcePoItemId: null,
        });
        return w;
      },
    ],
  ];

  it.each(cases)('%s', async (code, build) => {
    const { cycle, leg } = await build();
    const before = snapshot();
    const r = await call({ cycle: cycle.code, sequence: 1, amount: 900 });
    expect(codeOf(r)).toBe(code);
    expect(textOf(r)).toContain(`${code}: `);
    expect(textOf(r)).toContain('Dubai, UAE → Cairo, Egypt');
    expect(structured(r).confirmationToken).toBeUndefined();
    expect(snapshot()).toBe(before);
    expect(db.legs.find((l) => l.id === leg.id)!.amountEgp.toFixed(2)).toBe(
      '400.00',
    );
  });
});

// ─── The second time: someone else changed it in between ─────────────────

describe('a preview overtaken before the confirm', () => {
  it('the leg corrected in the office app in between → PREVIEW_CHANGED, the office figure kept', async () => {
    const { cycle, leg } = await receivedAndSold();
    const args = { cycle: cycle.code, sequence: 1, amount: 800 };
    const shown = await preview(args);

    await shipping.updateLeg(leg.id, { amount: 600 }, randomUUID());
    const before = snapshot();

    const r = await commitWith(args, shown);
    expect(codeOf(r)).toBe('PREVIEW_CHANGED');
    expect(snapshot()).toBe(before);
    expect(batch().landedUnitCostEgp.toFixed(2)).toBe('115.00');
  });

  it('another sale in between, so more sold units would be re-costed → PREVIEW_CHANGED', async () => {
    const { cycle, item } = await receivedAndSold();
    const args = { cycle: cycle.code, sequence: 1, amount: 800 };
    const shown = await preview(args);

    await sell(item.productId, 5);

    const r = await commitWith(args, shown);
    expect(codeOf(r)).toBe('PREVIEW_CHANGED');
    expect(batch().landedUnitCostEgp.toFixed(2)).toBe('110.00');
  });

  it('the token for one amount cannot commit another', async () => {
    const { cycle } = await receivedAndSold();
    const shown = await preview({
      cycle: cycle.code,
      sequence: 1,
      amount: 800,
    });
    const r = await commitWith(
      { cycle: cycle.code, sequence: 1, amount: 9000 },
      shown,
    );
    expect(r.isError).toBe(true);
    expect(batch().landedUnitCostEgp.toFixed(2)).toBe('110.00');
  });
});

// ─── Roles (CLAUDE.md §12) ───────────────────────────────────────────────

describe("update_leg_cost — roles are PUT /shipping/legs/:id's", () => {
  it.each(['TEMP_INVESTOR', 'ADMIN_SUPPORT'] as const)(
    'a role the endpoint refuses (%s) is refused here too, nothing written',
    async (role) => {
      const { cycle } = await receivedAndSold();
      const other = await connectAs({ ...partner, role });
      const before = snapshot();
      const r = await call(
        { cycle: cycle.code, sequence: 1, amount: 800 },
        other,
      );
      await other.close();
      expect(codeOf(r)).toBe('ROLE_NOT_ALLOWED');
      expect(snapshot()).toBe(before);
    },
  );

  it('a core partner, whom the endpoint allows, is allowed', async () => {
    const { cycle } = await receivedAndSold();
    await preview({ cycle: cycle.code, sequence: 1, amount: 800 });
  });
});

// ─── Things that do not exist, and the wrong context ─────────────────────

describe('a leg that cannot be found → a coded refusal, never a 500', () => {
  it('an unknown cycle code → NOT_FOUND', async () => {
    arrived();
    const r = await call({ cycle: 'CYC-2099-0001', sequence: 1, amount: 500 });
    expect(codeOf(r)).toBe('NOT_FOUND');
    expect(structured(r).error?.params).toMatchObject({ entity: 'cycle' });
  });

  it('a sequence the cycle has no leg for → NOT_FOUND shippingLeg', async () => {
    const { cycle } = arrived();
    const r = await call({ cycle: cycle.code, sequence: 2, amount: 500 });
    expect(codeOf(r)).toBe('NOT_FOUND');
    expect(structured(r).error?.params).toMatchObject({
      entity: 'shippingLeg',
    });
  });

  it.each(['leg-1', randomUUID()])(
    'a leg id that is no leg (%s) → NOT_FOUND',
    async (legId) => {
      const r = await call({ legId, amount: 500 });
      expect(codeOf(r)).toBe('NOT_FOUND');
    },
  );

  it("one cycle's leg named with another cycle's code → NOT_FOUND, nothing written", async () => {
    const a = arrived('IN_TRANSIT');
    const b = arrived('IN_TRANSIT');
    const before = snapshot();
    const r = await call({ legId: a.leg.id, cycle: b.cycle.code, amount: 500 });
    expect(codeOf(r)).toBe('NOT_FOUND');
    expect(snapshot()).toBe(before);
  });

  it('neither a leg id nor a cycle and sequence → VALIDATION_FAILED', async () => {
    arrived();
    const r = await call({ amount: 500 });
    expect(codeOf(r)).toBe('VALIDATION_FAILED');
  });
});

// ─── The limits ──────────────────────────────────────────────────────────

describe('a cost that is never a cost is refused, nothing written', () => {
  it.each([
    ['a negative amount', { amount: -100 }],
    [
      'a negative rate',
      { costBasis: 'PER_PIECE', ratePerUnit: -1, chargeablePieces: 40 },
    ],
    ['a rate to EGP of zero', { currency: 'USD', amount: 10, fxRateToEgp: 0 }],
    ['a currency that is not a code', { currency: 'dollars', amount: 10 }],
  ])('%s', async (_, cost) => {
    const { cycle } = await receivedAndSold();
    const before = snapshot();
    const r = await call({ cycle: cycle.code, sequence: 1, ...cost });
    expect(r.isError).toBe(true);
    expect(structured(r)?.confirmationToken).toBeUndefined();
    expect(snapshot()).toBe(before);
  });

  it('PER_PIECE without a piece count → PER_PIECE_FIELDS_REQUIRED, the service refusing', async () => {
    const { cycle } = await receivedAndSold();
    const r = await call({
      cycle: cycle.code,
      sequence: 1,
      costBasis: 'PER_PIECE',
      ratePerUnit: 10,
    });
    expect(codeOf(r)).toBe('PER_PIECE_FIELDS_REQUIRED');
  });
});
