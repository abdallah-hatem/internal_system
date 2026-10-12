/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the fake database's rows are untyped records, as Prisma's argument objects are */
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector, type ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the fake's unique violation is Prisma's own error, as the confirmation service expects
import { Prisma } from '@prisma/client';

import { SurfaceGuard } from '../../../common/guards/surface.guard';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { AuthService } from '../../auth/auth.service';
import { CostingService } from '../../costing/costing.service';
import { CyclesService } from '../../cycles/cycles.service';
import { InventoryController } from '../../inventory/inventory.controller';
import { InventoryService } from '../../inventory/inventory.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { DeliveriesService } from '../../shipping/deliveries.service';
import { ShippingController } from '../../shipping/shipping.controller';
import { ShippingService } from '../../shipping/shipping.service';
import {
  addLeg,
  cycleWithOrder,
  D,
  emptyStore,
  fakePrisma,
  type Row,
  type Store,
} from '../../shipping/shipment-fake-spec';
import { AssistantServer } from '../assistant-server';
import { ConfirmationService } from '../confirmation.service';
import { McpController } from '../mcp.controller';
import type { AssistantUser } from '../tool-kit';

/**
 * B4 — the assistant learns deliveries (plan 2026-10-10; BUSINESS_LOGIC §1 §3
 * §16). One test per edge case in the plan, named after it, plus the refusals
 * a delivery can meet on the way.
 *
 * Driven as Claude drives it — the SDK's client over a real McpServer — into
 * the real deliveries, shipping, inventory, cycles and costing services. The
 * database is B2's in-memory fake, which models the cycle lock and rolls a
 * failed transaction back, so a preview made by rolling a write back
 * (`dry-run.ts`) is tested for real: if the rollback did not happen, the
 * "nothing written" assertions below would see the delivery.
 *
 * e2e for the same cases: apps/web/tests/83-assistant-deliveries.spec.ts.
 */

// 12:00 in Cairo on 2026-10-10. Only the clock is faked: the fake database
// yields with setImmediate, which must keep running.
const NOW = new Date('2026-10-10T09:00:00Z');
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
let client: Client;
let deliveries: DeliveriesService;
let inventory: InventoryService;
let notifications: { createForMultipleUsers: jest.Mock; create: jest.Mock };

beforeEach(async () => {
  db = emptyStore();
  const prisma = fakePrisma(db) as unknown as Row;
  // Spent confirmations: the primary key is what makes a token single-use.
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
  const p = prisma as unknown as PrismaService;

  const audit = { log: jest.fn() } as unknown as AuditService;
  notifications = { createForMultipleUsers: jest.fn(), create: jest.fn() };
  const notify = notifications as unknown as NotificationsService;
  const costing = new CostingService(p);
  const cycles = new CyclesService(p, audit, notify);
  deliveries = new DeliveriesService(p, audit, notify, costing, cycles);
  const shipping = new ShippingService(p, audit, costing, deliveries);
  inventory = new InventoryService(p, audit, notify, costing, cycles);

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
  const assistant = new AssistantServer(
    new ConfirmationService(
      new JwtService({ secret: 'a-test-secret-that-is-long-enough-to-pass' }),
      p,
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

// ─── Calling the tools ───────────────────────────────────────────────────

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

async function preview(name: string, args: Record<string, unknown>) {
  const r = await call(name, args);
  expect(r.isError ? textOf(r) : '').toBe('');
  return r;
}

const commitWith = (
  name: string,
  args: Record<string, unknown>,
  shown: CallToolResult,
) =>
  call(name, {
    ...args,
    confirmationToken: structured(shown).confirmationToken,
  });

/** Everything a delivery or a receipt could touch. */
const snapshot = () =>
  JSON.stringify({
    cycles: db.cycles,
    legs: db.legs,
    departures: db.departures,
    deliveries: db.deliveries,
    losses: db.losses,
    batches: db.batches,
    items: db.items,
    ledger: db.ledger,
    movements: db.movements,
  });

// ─── Building states the business recognises (CLAUDE.md rule 4) ──────────

/**
 * A UAE-direct cycle in transit: 40 brake pads at 100 (goods 4,000) on one
 * departed leg costing 400, so a unit lands at 110.00.
 */
function inTransit(status = 'IN_TRANSIT') {
  const { cycle, items } = cycleWithOrder(db, { status });
  const leg = addLeg(db, cycle, 1, { departedOn: '2026-09-01' });
  return { cycle, item: items[0], leg };
}

/** A China cycle, both legs departed: China → UAE, then UAE → Egypt. */
function chinaInTransit() {
  const { cycle, items } = cycleWithOrder(db, {
    status: 'IN_TRANSIT_TO_EGYPT',
    originType: 'CHINA',
  });
  const leg1 = addLeg(db, cycle, 1, { departedOn: '2026-09-01' });
  return { cycle, item: items[0], leg1 };
}

/** A delivery recorded in the office app, through the same service. */
async function officeDelivers(
  leg: Row,
  item: Row,
  qty: number,
  day = '2026-09-20',
) {
  const { data } = await deliveries.recordDelivery(
    leg.id,
    { arrivedOn: day, lines: [{ purchaseOrderItemId: item.id, qty }] },
    randomUUID(),
  );
  return data as Row;
}

const deliveryArgs = (
  leg: Row,
  item: Row,
  qty: number,
  day = '2026-09-20',
) => ({
  legId: leg.id,
  arrivedOn: day,
  lines: [{ purchaseOrderItemId: item.id, qty }],
});

// ─── record_delivery ─────────────────────────────────────────────────────

describe('record_delivery', () => {
  it('record_delivery preview writes nothing; confirm writes exactly the previewed delivery', async () => {
    const { cycle, item, leg } = inTransit();
    const args = { ...deliveryArgs(leg, item, 15), note: 'first pallet' };
    const before = snapshot();

    const shown = await preview('record_delivery', args);

    // Nothing written — though the service's own write ran and was rolled
    // back — and nobody told the goods arrived.
    expect(snapshot()).toBe(before);
    expect(notifications.createForMultipleUsers).not.toHaveBeenCalled();
    expect(textOf(shown)).toContain(
      `Record a delivery on ${cycle.code}, leg 1 (Dubai, UAE → Cairo, Egypt), arrived 2026-09-20:`,
    );
    expect(textOf(shown)).toContain(
      'Brake pad: 15 arrived; 40 were on the way, 25 will still be on the way.',
    );
    expect(structured(shown).data).toMatchObject({
      legStatusAfter: 'PARTLY_ARRIVED',
      lines: [
        {
          purchaseOrderItemId: item.id,
          qty: '15',
          onTheWayBefore: '40',
          onTheWayAfter: '25',
        },
      ],
    });

    const commit = await commitWith('record_delivery', args, shown);

    expect(commit.isError).toBeFalsy();
    expect(db.deliveries).toHaveLength(1);
    const [delivery] = db.deliveries;
    expect(delivery).toMatchObject({
      legId: leg.id,
      note: 'first pallet',
      createdBy: partner.id,
    });
    expect(delivery.arrivedOn.toISOString().slice(0, 10)).toBe('2026-09-20');
    expect(
      delivery.lines.map((l: Row) => [l.purchaseOrderItemId, Number(l.qty)]),
    ).toEqual([[item.id, 15]]);
    expect(leg.status).toBe('PARTLY_ARRIVED');
    expect(structured(commit).data).toMatchObject({
      deliveryId: delivery.id,
      lines: [{ deliveryLineId: delivery.lines[0].id, qty: '15' }],
    });
  });

  describe("A delivery recorded by someone else between preview and confirm, so the preview's quantity no longer fits → PREVIEW_CHANGED or DELIVERY_EXCEEDS_IN_TRANSIT, nothing written", () => {
    it('still fits, but would leave less on the way than the preview said → PREVIEW_CHANGED', async () => {
      const { item, leg } = inTransit();
      const args = deliveryArgs(leg, item, 15);
      const shown = await preview('record_delivery', args); // 25 left after

      await officeDelivers(leg, item, 10); // now 15 left after the same 15
      const before = snapshot();

      const commit = await commitWith('record_delivery', args, shown);

      expect(codeOf(commit)).toBe('PREVIEW_CHANGED');
      expect(snapshot()).toBe(before);
      expect(db.deliveries).toHaveLength(1);
    });

    it('no longer fits → DELIVERY_EXCEEDS_IN_TRANSIT, the service refusing', async () => {
      const { item, leg } = inTransit();
      const args = deliveryArgs(leg, item, 30);
      const shown = await preview('record_delivery', args);

      await officeDelivers(leg, item, 20); // 20 left; 30 no longer fits
      const before = snapshot();

      const commit = await commitWith('record_delivery', args, shown);

      expect(codeOf(commit)).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
      expect(structured(commit).error?.params).toMatchObject({
        onTheWay: 20,
        asked: 30,
      });
      expect(snapshot()).toBe(before);
    });
  });

  it('a confirmation replayed after the delivery was recorded → CONFIRMATION_USED, recorded once', async () => {
    const { item, leg } = inTransit();
    const args = deliveryArgs(leg, item, 15);
    const shown = await preview('record_delivery', args);
    expect(
      (await commitWith('record_delivery', args, shown)).isError,
    ).toBeFalsy();

    const replay = await commitWith('record_delivery', args, shown);

    expect(codeOf(replay)).toBe('CONFIRMATION_USED');
    expect(db.deliveries).toHaveLength(1);
  });

  it('a changed quantity at confirm → CONFIRMATION_MISMATCH, nothing written', async () => {
    const { item, leg } = inTransit();
    const shown = await preview('record_delivery', deliveryArgs(leg, item, 15));

    const commit = await commitWith(
      'record_delivery',
      deliveryArgs(leg, item, 16),
      shown,
    );

    expect(codeOf(commit)).toBe('CONFIRMATION_MISMATCH');
    expect(db.deliveries).toHaveLength(0);
  });

  it("the service's refusals reach the preview, coded, and nothing is written", async () => {
    const { cycle, item, leg } = inTransit();
    const other = inTransit();
    const before = snapshot();

    const cases: [Record<string, unknown>, string][] = [
      [deliveryArgs(leg, item, 41), 'DELIVERY_EXCEEDS_IN_TRANSIT'],
      [deliveryArgs(leg, item, 0), 'QTY_NOT_POSITIVE'],
      [deliveryArgs(leg, item, -5), 'QTY_NOT_POSITIVE'],
      [deliveryArgs(leg, item, 5, '2026-10-11'), 'DATE_IN_FUTURE'],
      [deliveryArgs(leg, item, 5, '2026-08-31'), 'DELIVERY_BEFORE_DEPARTURE'],
      // Someone else's order line is no line of this cycle.
      [deliveryArgs(leg, other.item, 5), 'NOT_FOUND'],
      [{ ...deliveryArgs(leg, item, 5), legId: randomUUID() }, 'NOT_FOUND'],
      [{ ...deliveryArgs(leg, item, 5), legId: 'leg-1' }, 'NOT_FOUND'],
      [
        {
          ...deliveryArgs(leg, item, 5),
          lines: [
            { purchaseOrderItemId: item.id, qty: 2 },
            { purchaseOrderItemId: item.id, qty: 3 },
          ],
        },
        'VALIDATION_FAILED',
      ],
      [{ ...deliveryArgs(leg, item, 5), lines: [] }, 'VALIDATION_FAILED'],
    ];
    for (const [args, code] of cases) {
      expect([
        JSON.stringify(args),
        codeOf(await call('record_delivery', args)),
      ]).toEqual([JSON.stringify(args), code]);
    }

    // A leg that has not left, and a cycle being settled.
    const departures = db.departures.splice(0);
    expect(
      codeOf(await call('record_delivery', deliveryArgs(leg, item, 5))),
    ).toBe('LEG_NOT_DEPARTED');
    db.departures.push(...departures);
    cycle.status = 'SETTLEMENT';
    expect(
      codeOf(await call('record_delivery', deliveryArgs(leg, item, 5))),
    ).toBe('CYCLE_SETTLING');
    cycle.status = 'IN_TRANSIT';

    expect(snapshot()).toBe(before);
  });

  it('a delivery that completes the leg: the preview says ARRIVED and tells nobody; the commit tells the participants', async () => {
    const { cycle, item, leg } = inTransit();
    db.participants.push({
      id: randomUUID(),
      cycleId: cycle.id,
      partnerUserId: partner.id,
      investorUserId: null,
    });
    const args = deliveryArgs(leg, item, 40);

    const shown = await preview('record_delivery', args);
    expect(structured(shown).data.legStatusAfter).toBe('ARRIVED');
    expect(notifications.createForMultipleUsers).not.toHaveBeenCalled();

    await commitWith('record_delivery', args, shown);
    expect(leg.status).toBe('ARRIVED');
    expect(notifications.createForMultipleUsers).toHaveBeenCalledTimes(1);
  });

  it("leg 2 can only deliver what leg 1 delivered: the preview counts from leg 1's deliveries", async () => {
    const { item, leg1 } = chinaInTransit();
    await officeDelivers(leg1, item, 15, '2026-09-05');
    const { cycle } = { cycle: db.cycles[0] };
    const leg2 = addLeg(db, cycle, 2, { departedOn: '2026-09-10' });

    expect(
      codeOf(await call('record_delivery', deliveryArgs(leg2, item, 16))),
    ).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
    const shown = await preview(
      'record_delivery',
      deliveryArgs(leg2, item, 15),
    );
    expect(structured(shown).data.lines[0]).toMatchObject({
      onTheWayBefore: '15',
      onTheWayAfter: '0',
    });
    expect(textOf(shown)).toContain('ends in Egypt');
  });
});

// ─── verify_stock ────────────────────────────────────────────────────────

describe('verify_stock', () => {
  it('verify_stock with a delivery: preview shows the unit cost; confirm books it; replay → CONFIRMATION_USED', async () => {
    const { cycle, item, leg } = inTransit('ARRIVED_EGYPT');
    const delivery = await officeDelivers(leg, item, 15);
    const args = {
      deliveryId: delivery.id,
      items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: 15 }],
    };
    const before = snapshot();

    const shown = await preview('verify_stock', args);

    expect(snapshot()).toBe(before);
    // 4,000 of goods and a 400 leg over 40 ordered: 110 a unit, whichever
    // delivery brings it (§2).
    expect(textOf(shown)).toContain(
      'Brake pad: 15 counted in (40 ordered), landed 110.0000 EGP/unit = 1,650.00 EGP',
    );
    expect(textOf(shown)).toContain(
      `moves ${cycle.code} from ARRIVED_EGYPT to SELLING`,
    );

    const commit = await commitWith('verify_stock', args, shown);
    expect(commit.isError).toBeFalsy();
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toMatchObject({
      sourceDeliveryLineId: delivery.lines[0].id,
    });
    expect(db.batches[0].landedUnitCostEgp.toFixed(4)).toBe('110.0000');
    expect(db.ledger.map((t) => t.amount.toFixed(2))).toEqual(['1650.00']);
    expect(cycle.status).toBe('SELLING');

    const replay = await commitWith('verify_stock', args, shown);
    expect(codeOf(replay)).toBe('CONFIRMATION_USED');
    expect(db.batches).toHaveLength(1);
    expect(db.ledger).toHaveLength(1);
  });

  it('verify_stock on a second delivery while SELLING → works (it used to be CYCLE_NOT_IN_VERIFICATION)', async () => {
    const { cycle, item, leg } = inTransit('ARRIVED_EGYPT');
    const first = await officeDelivers(leg, item, 15, '2026-09-20');
    await inventory.verifyStock(
      cycle.id,
      {
        deliveryId: first.id,
        items: [{ deliveryLineId: first.lines[0].id, receivedQty: 15 }],
      },
      randomUUID(),
    );
    expect(cycle.status).toBe('SELLING');

    // The second delivery is recorded and received through the assistant.
    const recorded = await call(
      'record_delivery',
      deliveryArgs(leg, item, 10, '2026-10-01'),
    );
    const made = await commitWith(
      'record_delivery',
      deliveryArgs(leg, item, 10, '2026-10-01'),
      recorded,
    );
    const second = structured(made).data;
    const args = {
      deliveryId: second.deliveryId,
      items: [
        { deliveryLineId: second.lines[0].deliveryLineId, receivedQty: 10 },
      ],
    };
    const shown = await preview('verify_stock', args);
    expect(textOf(shown)).toContain(`${cycle.code} stays SELLING.`);
    const commit = await commitWith('verify_stock', args, shown);

    expect(commit.isError).toBeFalsy();
    expect(cycle.status).toBe('SELLING');
    // Two batches, the same unit cost, each with its own arrival (§2, §14).
    expect(
      db.batches.map((b) => [
        Number(b.receivedQty),
        b.landedUnitCostEgp.toFixed(4),
        b.arrivedOn.toISOString().slice(0, 10),
      ]),
    ).toEqual([
      [15, '110.0000', '2026-09-20'],
      [10, '110.0000', '2026-10-01'],
    ]);
  });

  it('verify_stock after the landed cost changed since the preview → PREVIEW_CHANGED', async () => {
    const { item, leg } = inTransit('ARRIVED_EGYPT');
    const delivery = await officeDelivers(leg, item, 15);
    const args = {
      deliveryId: delivery.id,
      items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: 15 }],
    };
    const shown = await preview('verify_stock', args);

    // The freight invoice is corrected in the office before anything was
    // received (the cost lock only starts at the first receipt): 400 → 800.
    leg.amount = D(800);
    leg.amountEgp = D(800);
    const before = snapshot();

    const commit = await commitWith('verify_stock', args, shown);

    expect(codeOf(commit)).toBe('PREVIEW_CHANGED');
    expect(snapshot()).toBe(before);
    // The token was not spent: the partner can look again and confirm that.
    const again = await preview('verify_stock', args);
    expect(structured(again).data.lines[0].landedUnitCostEgp).toBe('120.0000');
  });

  it('verify_stock on a delivery that reached the UAE, not Egypt → NOT_LAST_LEG_DELIVERY', async () => {
    const { item, leg1 } = chinaInTransit();
    db.cycles[0].status = 'ARRIVED_EGYPT';
    const delivery = await officeDelivers(leg1, item, 15, '2026-09-05');
    addLeg(db, db.cycles[0], 2, { departedOn: '2026-09-10' });

    const r = await call('verify_stock', {
      deliveryId: delivery.id,
      items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: 15 }],
    });
    expect(codeOf(r)).toBe('NOT_LAST_LEG_DELIVERY');
    expect(db.batches).toHaveLength(0);
  });

  it('verify_stock of fewer than the delivery brought leaves the rest waiting, received in a later call', async () => {
    const { item, leg } = inTransit('ARRIVED_EGYPT');
    const delivery = await officeDelivers(leg, item, 15);
    const line = delivery.lines[0].id;
    const receive = async (qty: number) => {
      const args = {
        deliveryId: delivery.id,
        items: [{ deliveryLineId: line, receivedQty: qty }],
      };
      return commitWith('verify_stock', args, await call('verify_stock', args));
    };

    expect((await receive(14)).isError).toBeFalsy();
    expect(
      codeOf(
        await call('verify_stock', {
          deliveryId: delivery.id,
          items: [{ deliveryLineId: line, receivedQty: 2 }],
        }),
      ),
    ).toBe('RECEIVED_EXCEEDS_DELIVERED');
    expect((await receive(1)).isError).toBeFalsy();
    expect(db.batches.map((b) => Number(b.receivedQty))).toEqual([14, 1]);
  });
});

// ─── add_shipping_leg ────────────────────────────────────────────────────

describe('add_shipping_leg', () => {
  it('add_shipping_leg with an arrival date → the preview lists the units it will deliver', async () => {
    // Leg 1 delivered 15 of the 40 to the UAE; leg 2 can carry only those.
    const { cycle, item, leg1 } = chinaInTransit();
    await officeDelivers(leg1, item, 15, '2026-09-05');
    const args = {
      cycleId: cycle.id,
      sequence: 2,
      departedOn: '2026-09-10',
      arrivedOn: '2026-09-25',
      amount: 300,
    };
    const before = snapshot();

    const shown = await preview('add_shipping_leg', args);

    expect(snapshot()).toBe(before);
    expect(textOf(shown)).toContain(
      'The arrival on 2026-09-25 is recorded as one delivery of everything on the way on this leg:',
    );
    expect(textOf(shown)).toContain('- Brake pad: 15');
    expect(textOf(shown)).toContain('Status ARRIVED');
    expect(structured(shown).data.delivers).toEqual([
      { purchaseOrderItemId: item.id, product: 'Brake pad', qty: '15' },
    ]);

    const commit = await commitWith('add_shipping_leg', args, shown);

    expect(commit.isError).toBeFalsy();
    const leg2 = db.legs.find((l) => l.sequence === 2)!;
    const made = db.deliveries.filter((d) => d.legId === leg2.id);
    expect(made).toHaveLength(1);
    expect(
      made[0].lines.map((l: Row) => [l.purchaseOrderItemId, Number(l.qty)]),
    ).toEqual([[item.id, 15]]);
  });

  it('add_shipping_leg with an arrival date, after leg 1 delivered more since the preview → PREVIEW_CHANGED, no leg', async () => {
    const { cycle, item, leg1 } = chinaInTransit();
    await officeDelivers(leg1, item, 15, '2026-09-05');
    const args = {
      cycleId: cycle.id,
      sequence: 2,
      departedOn: '2026-09-10',
      arrivedOn: '2026-09-25',
      amount: 300,
    };
    const shown = await preview('add_shipping_leg', args);

    await officeDelivers(leg1, item, 10, '2026-09-08');
    const before = snapshot();

    const commit = await commitWith('add_shipping_leg', args, shown);

    expect(codeOf(commit)).toBe('PREVIEW_CHANGED');
    expect(snapshot()).toBe(before);
  });

  it('add_shipping_leg departing leg 2 before anything reached Dubai → DEPARTURE_NOTHING_WAITING, nothing written (L8)', async () => {
    // Leg 1 has delivered nothing yet, so nothing waits at leg 2's origin.
    // Before L8 this previewed "delivers nothing" and saved a departed leg.
    const { cycle } = chinaInTransit();
    const before = snapshot();
    const r = await call('add_shipping_leg', {
      cycleId: cycle.id,
      sequence: 2,
      departedOn: '2026-09-10',
      arrivedOn: '2026-09-25',
      amount: 300,
    });
    expect(codeOf(r)).toBe('DEPARTURE_NOTHING_WAITING');
    expect(snapshot()).toBe(before);
  });
});

// ─── record_departure (L8) ───────────────────────────────────────────────

describe('record_departure — goods leave in parts (L8)', () => {
  /** A UAE-direct cycle in purchasing, its 40 pads still with the supplier. */
  function notLeft(status = 'PURCHASING') {
    const { cycle, items } = cycleWithOrder(db, { status });
    const leg = addLeg(db, cycle, 1, { departedOn: null });
    return { cycle, item: items[0], leg };
  }
  const departArgs = (
    leg: Row,
    item: Row | null,
    qty: number,
    day = '2026-09-05',
  ) => ({
    legId: leg.id,
    departedOn: day,
    ...(item ? { lines: [{ purchaseOrderItemId: item.id, qty }] } : {}),
  });

  it('the preview writes nothing and says what leaves, what stays, and where the cycle lands; the confirm writes exactly that', async () => {
    const { cycle, item, leg } = notLeft();
    const before = snapshot();
    const shown = await preview('record_departure', departArgs(leg, item, 25));
    expect(snapshot()).toBe(before);
    expect(textOf(shown)).toContain(
      'Brake pad: 25 leave; 15 will still wait at Dubai, UAE, 25 will be on the way.',
    );
    expect(textOf(shown)).toContain(
      'Afterwards the leg reads PARTLY_DEPARTED.',
    );
    expect(textOf(shown)).toContain(
      `This moves ${cycle.code} from PURCHASING to IN_TRANSIT_TO_EGYPT`,
    );
    expect(structured(shown).data.cycleStatus).toMatchObject({
      from: 'PURCHASING',
      to: 'IN_TRANSIT_TO_EGYPT',
    });

    const commit = await commitWith(
      'record_departure',
      departArgs(leg, item, 25),
      shown,
    );
    expect(commit.isError).toBeFalsy();
    expect(db.departures).toHaveLength(1);
    expect(db.departures[0].lines[0].qty.toString()).toBe('25');
    expect(cycle.status).toBe('IN_TRANSIT_TO_EGYPT');
  });

  it('a later departure: the preview says the cycle does not move, and it does not', async () => {
    const { cycle, item, leg } = notLeft();
    await deliveries.recordDeparture(
      leg.id,
      {
        departedOn: '2026-09-02',
        lines: [{ purchaseOrderItemId: item.id, qty: 25 }],
      },
      partner.id,
    );
    cycle.status = 'PURCHASING'; // kept back by hand
    const shown = await preview(
      'record_departure',
      departArgs(leg, item, 15, '2026-09-06'),
    );
    expect(textOf(shown)).toContain(
      `not the leg's first departure, so ${cycle.code} stays PURCHASING`,
    );
    await commitWith(
      'record_departure',
      departArgs(leg, item, 15, '2026-09-06'),
      shown,
    );
    expect(cycle.status).toBe('PURCHASING');
    expect(db.departures).toHaveLength(2);
  });

  it('no lines → everything waiting leaves', async () => {
    const { item, leg } = notLeft();
    const shown = await preview('record_departure', departArgs(leg, null, 0));
    expect(structured(shown).data.lines).toEqual([
      expect.objectContaining({
        purchaseOrderItemId: item.id,
        qty: '40',
        stillWaiting: '0',
      }),
    ]);
  });

  it('binding: a departure recorded in the office between the preview and the yes → PREVIEW_CHANGED, nothing more written', async () => {
    // The leg has left already, so the status move is the same either way:
    // only what still waits differs, and that alone must refuse.
    const { item, leg } = notLeft('IN_TRANSIT_TO_EGYPT');
    await deliveries.recordDeparture(
      leg.id,
      {
        departedOn: '2026-09-01',
        lines: [{ purchaseOrderItemId: item.id, qty: 5 }],
      },
      partner.id,
    );
    const shown = await preview('record_departure', departArgs(leg, item, 20));
    await deliveries.recordDeparture(
      leg.id,
      {
        departedOn: '2026-09-04',
        lines: [{ purchaseOrderItemId: item.id, qty: 10 }],
      },
      partner.id,
    );
    const before = snapshot();
    const commit = await commitWith(
      'record_departure',
      departArgs(leg, item, 20),
      shown,
    );
    expect(codeOf(commit)).toBe('PREVIEW_CHANGED');
    expect(snapshot()).toBe(before);
  });

  it('binding: a different quantity than previewed → refused', async () => {
    const { item, leg } = notLeft();
    const shown = await preview('record_departure', departArgs(leg, item, 20));
    const commit = await commitWith(
      'record_departure',
      departArgs(leg, item, 21),
      shown,
    );
    expect(commit.isError).toBe(true);
    expect(db.departures).toHaveLength(0);
  });

  it("the service's refusals reach the preview, coded: too many, zero, the future, a frozen cycle, an unknown leg", async () => {
    const { cycle, item, leg } = notLeft();
    const before = snapshot();
    expect(
      codeOf(await call('record_departure', departArgs(leg, item, 41))),
    ).toBe('DEPARTURE_EXCEEDS_WAITING');
    expect(
      codeOf(await call('record_departure', departArgs(leg, item, 0))),
    ).toBe('QTY_NOT_POSITIVE');
    expect(
      codeOf(
        await call('record_departure', departArgs(leg, item, 5, '2026-10-11')),
      ),
    ).toBe('DATE_IN_FUTURE');
    expect(
      codeOf(
        await call('record_departure', {
          ...departArgs(leg, item, 5),
          legId: randomUUID(),
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      codeOf(
        await call('record_departure', {
          ...departArgs(leg, item, 5),
          legId: 'nope',
        }),
      ),
    ).toBe('NOT_FOUND');
    cycle.status = 'SETTLEMENT';
    expect(
      codeOf(await call('record_departure', departArgs(leg, item, 5))),
    ).toBe('CYCLE_SETTLING');
    cycle.status = 'PURCHASING';
    expect(snapshot()).toBe(before);
  });

  it('add_shipping_leg with departureLines: only those leave, and the preview says what still waits', async () => {
    const { cycle, items } = cycleWithOrder(db, { status: 'PURCHASING' });
    const args = {
      cycleId: cycle.id,
      sequence: 1,
      departedOn: '2026-09-05',
      departureLines: [{ purchaseOrderItemId: items[0].id, qty: 30 }],
      amount: 300,
    };
    const shown = await preview('add_shipping_leg', args);
    expect(textOf(shown)).toContain(
      'Brake pad: 30 left; 10 still waiting at Dubai, UAE',
    );
    expect(structured(shown).data.status).toBe('PARTLY_DEPARTED');
    await commitWith('add_shipping_leg', args, shown);
    expect(db.departures).toHaveLength(1);
    expect(db.legs[0].status).toBe('PARTLY_DEPARTED');
  });
});

// ─── What the assistant may not do ───────────────────────────────────────

describe('marking goods lost is office-app only (§16)', () => {
  it('There is no tool for marking goods lost (tools/list)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toEqual(
      expect.arrayContaining(['record_delivery', 'verify_stock']),
    );
    expect(names.filter((n) => /los[st]|refund/i.test(n))).toEqual([]);
    // And no tool reaches the loss endpoints' service by another name.
    const record = tools.find((t) => t.name === 'record_delivery')!;
    expect(record.description).toContain('office app');
  });

  describe('An mcp token on the REST delivery endpoints → WRONG_SURFACE', () => {
    const jwt = new JwtService({ secret: 'surface-test-secret' });
    const users: Record<string, Row> = {
      [partner.id]: {
        id: partner.id,
        email: partner.email,
        role: 'CORE_PARTNER',
        status: 'ACTIVE',
        partner: null,
      },
    };
    const prisma = {
      user: {
        findUnique: ({ where }: Row) =>
          Promise.resolve(users[where.id] ?? null),
      },
    } as unknown as PrismaService;
    const mcpToken = new AuthService(
      {} as PrismaService,
      jwt,
    ).issueAssistantToken({ id: partner.id });

    /** The guard on a real handler, its surface read from its decorators. */
    async function refusal(controller: object, handler: string) {
      const request = { headers: { authorization: `Bearer ${mcpToken}` } };
      const context = {
        getHandler: () => (controller as Row).prototype[handler],
        getClass: () => controller,
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;
      try {
        await new SurfaceGuard(new Reflector(), jwt, prisma).canActivate(
          context,
        );
        return null;
      } catch (e) {
        const err = e as HttpException;
        return {
          status: err.getStatus(),
          code: (err.getResponse() as { code: string }).code,
        };
      }
    }

    it.each([
      [ShippingController, 'recordDelivery'],
      [ShippingController, 'deleteDelivery'],
      [ShippingController, 'recordLoss'],
      [ShippingController, 'takeBackLoss'],
      [ShippingController, 'updateLeg'],
      [InventoryController, 'verifyStock'],
    ] as const)('%p.%s → 403 WRONG_SURFACE', async (controller, handler) => {
      expect(await refusal(controller, handler)).toEqual({
        status: 403,
        code: 'WRONG_SURFACE',
      });
    });

    it('the same token on /mcp is let through — the refusal is the surface, not the token', async () => {
      expect(await refusal(McpController, 'post')).toBeNull();
    });
  });
});

// ─── L3: the preview names the status the record moves the cycle to ─────

describe('L3 — the status a record moves the cycle to (§1, 2026-10-11)', () => {
  it('record_delivery: the preview says the cycle moves to Arrived Egypt and moves nothing; the commit moves it', async () => {
    const { cycle, item, leg } = inTransit('IN_TRANSIT_TO_EGYPT');
    const args = deliveryArgs(leg, item, 15);
    const before = snapshot();

    const shown = await preview('record_delivery', args);
    expect(textOf(shown)).toContain(
      `This moves ${cycle.code} from IN_TRANSIT_TO_EGYPT to ARRIVED_EGYPT, through each step's own checks.`,
    );
    expect(structured(shown).data.cycleStatus).toEqual({
      from: 'IN_TRANSIT_TO_EGYPT',
      to: 'ARRIVED_EGYPT',
      ordersConfirmed: [],
    });
    // The walk ran inside the rolled-back write: nothing kept, nobody told.
    expect(snapshot()).toBe(before);
    expect(notifications.createForMultipleUsers).not.toHaveBeenCalled();

    const done = await commitWith('record_delivery', args, shown);
    expect(done.isError ? textOf(done) : '').toBe('');
    expect(textOf(done)).toContain(
      'The cycle is now ARRIVED_EGYPT (was IN_TRANSIT_TO_EGYPT).',
    );
    expect(structured(done).data.cycleStatus).toMatchObject({
      to: 'ARRIVED_EGYPT',
      moved: true,
    });
    expect(db.cycles.find((c) => c.id === cycle.id)!.status).toBe(
      'ARRIVED_EGYPT',
    );
  });

  it('record_delivery a second time: the preview says the cycle stays where it is', async () => {
    const { cycle, item, leg } = inTransit('IN_TRANSIT_TO_EGYPT');
    await officeDelivers(leg, item, 15, '2026-09-15');
    const shown = await preview('record_delivery', deliveryArgs(leg, item, 10));
    expect(textOf(shown)).toContain(`${cycle.code} stays ARRIVED_EGYPT.`);
    expect(structured(shown).data.cycleStatus).toMatchObject({
      from: 'ARRIVED_EGYPT',
      to: 'ARRIVED_EGYPT',
    });
  });

  it('add_shipping_leg with a departure: the preview names the status and the orders it confirms, and writes nothing', async () => {
    const { cycle, po } = cycleWithOrder(db, {
      status: 'PURCHASING',
      originType: 'UAE_DIRECT',
    });
    const order: Row = po;
    order.status = 'DRAFT';
    const args = {
      cycleId: cycle.id,
      sequence: 1,
      departedOn: '2026-09-01',
      costBasis: 'FLAT',
      amount: 400,
    };
    const state = () =>
      JSON.stringify({ cycles: db.cycles, legs: db.legs, orders: db.orders });
    const before = state();

    const shown = await preview('add_shipping_leg', args);
    expect(textOf(shown)).toContain(
      `This moves ${cycle.code} from PURCHASING to IN_TRANSIT_TO_EGYPT, through each step's own checks.`,
    );
    expect(textOf(shown)).toContain(
      `Leaving PURCHASING confirms and locks ${order.reference}`,
    );
    expect(state()).toBe(before);

    const done = await commitWith('add_shipping_leg', args, shown);
    expect(done.isError ? textOf(done) : '').toBe('');
    expect(db.cycles.find((c) => c.id === cycle.id)!.status).toBe(
      'IN_TRANSIT_TO_EGYPT',
    );
    expect(order.status).toBe('CONFIRMED');
  });

  it('add_shipping_leg with no dates: no status line at all', async () => {
    const { cycle } = cycleWithOrder(db, {
      status: 'PURCHASING',
      originType: 'UAE_DIRECT',
    });
    const shown = await preview('add_shipping_leg', {
      cycleId: cycle.id,
      sequence: 1,
      costBasis: 'FLAT',
      amount: 400,
    });
    expect(textOf(shown)).not.toContain('This moves');
    expect(structured(shown).data.cycleStatus).toBeNull();
  });
});
