/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the fake database's rows are untyped records, as Prisma's argument objects are */
import { randomUUID } from 'crypto';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard';
import { badRequest } from '../../common/api-error';
import { loadShipment } from '../../common/shipment-load';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CostingService, lineEventCost } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { PurchasesService } from '../purchases/purchases.service';
import { SalesService } from '../sales/sales.service';
import { PaymentsService } from '../payments/payments.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { ShippingService } from '../shipping/shipping.service';
import {
  addLeg,
  departAll,
  cycleWithOrder,
  D,
  emptyStore,
  fakePrisma,
  type Row,
  type Store,
} from '../shipping/shipment-fake-spec';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/**
 * B3 — receiving per delivery, the fixed unit cost, and the settlement gate
 * (plan 2026-10-10; BUSINESS_LOGIC §2 §3 §8 §9 §14). One test per edge case in
 * the plan, named after it. The database is the in-memory fake B2 built
 * (`shipment-fake-spec.ts`, which models the cycle lock and rolls back a
 * failed transaction); the services, the costing, the position arithmetic,
 * FIFO and the settlement maths are the real ones. e2e for the same cases:
 * apps/web/tests/82-receiving-deliveries.spec.ts.
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

const ACTOR = randomUUID();

let db: Store;
let inventory: InventoryService;
let deliveries: DeliveriesService;
let shipping: ShippingService;
let cycles: CyclesService;
let settlements: SettlementsService;
let analytics: AnalyticsService;
let sales: SalesService;

beforeEach(() => {
  db = emptyStore();
  const prisma = fakePrisma(db);
  const audit = { log: jest.fn() } as unknown as AuditService;
  const notifications = {
    createForMultipleUsers: jest.fn(),
  } as unknown as NotificationsService;
  const costing = new CostingService(prisma);
  cycles = new CyclesService(prisma, audit, notifications);
  deliveries = new DeliveriesService(
    prisma,
    audit,
    notifications,
    costing,
    cycles,
  );
  shipping = new ShippingService(prisma, audit, costing, deliveries);
  inventory = new InventoryService(
    prisma,
    audit,
    notifications,
    costing,
    cycles,
  );
  settlements = new SettlementsService(prisma, audit);
  analytics = new AnalyticsService(prisma);
  sales = new SalesService(prisma, audit, new PaymentsService(prisma, audit), {
    createForMultipleUsers: () => Promise.resolve({ count: 0 }),
  });
});

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    const body = e.getResponse() as Record<string, any>;
    return { status: e.getStatus(), code: body.code, params: body.params };
  }
  throw new Error('expected a refusal');
}

// ─── Building states the business recognises (CLAUDE.md rule 4) ──────────

/**
 * A UAE-direct cycle with one departed leg: by default 40 brake pads at 100
 * (goods 4,000) and a 400 leg — 110.00 a unit landed.
 */
function oneLeg(
  opts: {
    status?: string;
    lines?: [string, number, number][];
    legCost?: number;
  } = {},
) {
  const { cycle, items } = cycleWithOrder(db, {
    status: opts.status ?? 'ARRIVED_EGYPT',
    lines: opts.lines,
  });
  const leg = addLeg(db, cycle, 1, {
    departedOn: '2026-09-01',
    amountEgp: opts.legCost ?? 400,
  });
  return { cycle, item: items[0], items, leg };
}

/**
 * A China cycle: leg 1 China→UAE departed, leg 2 UAE→Egypt recorded. Leg 2
 * departs (`departAll`) once leg 1 has delivered — nothing leaves Dubai before
 * it is there (L8).
 */
function twoLegs(status = 'ARRIVED_EGYPT') {
  const { cycle, items } = cycleWithOrder(db, {
    status,
    originType: 'CHINA',
  });
  const leg1 = addLeg(db, cycle, 1, { departedOn: '2026-09-01' });
  const leg2 = addLeg(db, cycle, 2, { departedOn: null });
  return { cycle, item: items[0], leg1, leg2 };
}

async function deliver(leg: Row, item: Row, qty: number, day = '2026-09-20') {
  const { data } = await deliveries.recordDelivery(
    leg.id,
    { arrivedOn: day, lines: [{ purchaseOrderItemId: item.id, qty }] },
    ACTOR,
  );
  return data as Row;
}

const lose = (leg: Row, item: Row, qty: number) =>
  deliveries.recordLoss(
    leg.id,
    { lines: [{ purchaseOrderItemId: item.id, qty }] },
    ACTOR,
  );

/** Receive `qty` of a delivery's first line, the way the receive dialog does. */
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
    ACTOR,
  );

/** The older body: an order line and no delivery (fixtures, old wizard). */
const receiveOld = (cycle: Row, item: Row, qty: number) =>
  inventory.verifyStock(
    cycle.id,
    { items: [{ purchaseOrderItemId: item.id, receivedQty: qty }] },
    ACTOR,
  );

const status = (cycle: Row) => db.cycles.find((c) => c.id === cycle.id)!.status;
const batchesOf = (item: Row) =>
  db.batches.filter((b) => b.sourcePoItemId === item.id);
async function position(cycleId: string) {
  return (await loadShipment(fakePrisma(db), cycleId))!.position;
}

/** A shop, and a confirmed sale of `qty` of a product at `price`. */
async function sell(productId: string, qty: number, price = 200) {
  if (db.customers.length === 0) {
    db.customers.push({
      id: randomUUID(),
      displayName: 'Nile Motors',
      type: 'B2B',
      verificationStatus: 'VERIFIED',
    });
  }
  const { data } = await sales.create(
    {
      customerId: db.customers[0].id,
      channel: 'B2B',
      currency: 'EGP',
      items: [{ productId, quantity: qty, unitPrice: price, discount: 0 }],
      confirm: true,
    },
    ACTOR,
  );
  return data as Row;
}

const allocationsOf = (order: Row) => {
  const itemIds = new Set(
    db.saleItems.filter((i) => i.saleOrderId === order.id).map((i) => i.id),
  );
  return db.allocations.filter((a) => itemIds.has(a.saleItemId));
};

function participant(cycle: Row) {
  db.participants.push({
    id: randomUUID(),
    cycleId: cycle.id,
    participantType: 'CORE_PARTNER',
    partnerUserId: ACTOR,
    contributionAmount: D(4400),
    customProfitPct: null,
    investorFeePct: null,
    createdAt: new Date(),
  });
}

// ─── Receiving ───────────────────────────────────────────────────────────

describe('POST /receipts/verify', () => {
  it('Deliveries 15 then 10 received → two batches, same landed unit cost, both sellable', async () => {
    const { cycle, item, leg } = oneLeg();
    const first = await deliver(leg, item, 15, '2026-09-20');
    await receive(cycle, first, 15);
    const second = await deliver(leg, item, 10, '2026-09-30');
    await receive(cycle, second, 10);

    const batches = batchesOf(item);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.landedUnitCostEgp.toFixed(4))).toEqual([
      '110.0000',
      '110.0000',
    ]);
    expect(batches.map((b) => b.saleableQty.toNumber())).toEqual([15, 10]);
    expect(batches.every((b) => b.verificationStatus === 'VERIFIED')).toBe(
      true,
    );
  });

  it('The first delivery received and sold before the second arrives → the sale’s COGS is unchanged after the second delivery and after a loss', async () => {
    const { cycle, item, leg } = oneLeg();
    await receive(cycle, await deliver(leg, item, 15, '2026-09-20'), 15);
    const order = await sell(item.productId, 10);
    const cogsBefore = allocationsOf(order).map((a) => a.cogsEgp.toFixed(2));
    expect(cogsBefore).toEqual(['1100.00']);

    await receive(cycle, await deliver(leg, item, 20, '2026-09-30'), 20);
    await lose(leg, item, 5);

    expect(allocationsOf(order).map((a) => a.cogsEgp.toFixed(2))).toEqual(
      cogsBefore,
    );
    // Nor was the batch it drew from re-priced (§3: COGS never re-priced).
    expect(batchesOf(item)[0].landedUnitCostEgp.toFixed(4)).toBe('110.0000');
  });

  it('Unit cost: 40 ordered, goods 4,000, shipping 400 → 110.00 per unit for every batch, not 4,400 / received', async () => {
    const { cycle, item, leg } = oneLeg();
    // Only 22 ever came in; the old formula made each 200.00 (4,400 / 22).
    await receive(cycle, await deliver(leg, item, 12, '2026-09-20'), 12);
    await receive(cycle, await deliver(leg, item, 10, '2026-09-25'), 10);

    expect(batchesOf(item).map((b) => b.landedUnitCostEgp.toFixed(2))).toEqual([
      '110.00',
      '110.00',
    ]);
    expect(db.ledger.map((t) => t.amount.toFixed(2))).toEqual([
      '1320.00',
      '1100.00',
    ]);
  });

  it('GET /costing/cycles/:id/landed-cost is per ordered unit', async () => {
    const { cycle, item, leg } = oneLeg();
    await receive(cycle, await deliver(leg, item, 10), 10);
    const costing = new CostingService(fakePrisma(db));
    const r = await costing.computeCycleLandedCosts(cycle.id);
    expect(r.items[0].qty.toNumber()).toBe(40);
    expect(r.items[0].landedUnitCostEgp.toFixed(4)).toBe('110.0000');
  });

  it('Received 14 of a delivery of 15 → batch 14; 1 is waiting to be received against that delivery, and can be received later or marked lost', async () => {
    const { cycle, item, leg } = oneLeg();
    const d = await deliver(leg, item, 15);
    await receive(cycle, d, 14);

    expect(batchesOf(item).map((b) => b.receivedQty.toNumber())).toEqual([14]);
    const pos = await position(cycle.id);
    expect(pos.lines[0]).toMatchObject({ waiting: 1, onTheWay: 25 });
    expect(pos.legs[0].deliveries[0].lines[0]).toMatchObject({
      qty: 15,
      received: 14,
    });

    // Either way out of "waiting" is open. Received later: the next test.
    // Lost here — a loss takes what is on the way first, then what waits
    // (B1), so the 25 on the way and the 1 waiting go together.
    await lose(leg, item, 26);
    expect((await position(cycle.id)).lines[0]).toMatchObject({
      waiting: 0,
      onTheWay: 0,
      accounted: true,
    });
  });

  it('Receive 16 of a delivery of 15 → RECEIVED_EXCEEDS_DELIVERED', async () => {
    const { cycle, item, leg } = oneLeg();
    const d = await deliver(leg, item, 15);
    const r = await refusal(receive(cycle, d, 16));
    expect(r.code).toBe('RECEIVED_EXCEEDS_DELIVERED');
    expect(r.params).toEqual({
      product: 'Brake pad',
      received: 16,
      available: 15,
    });
    expect(db.batches).toHaveLength(0);
  });

  it('Receive 14 of a delivery of 15, then the 1 later → a second batch on the same delivery line; a third receipt → STOCK_ALREADY_VERIFIED', async () => {
    const { cycle, item, leg } = oneLeg();
    const d = await deliver(leg, item, 15);
    await receive(cycle, d, 14);
    await receive(cycle, d, 1);

    const batches = batchesOf(item);
    expect(batches.map((b) => b.receivedQty.toNumber())).toEqual([14, 1]);
    expect(new Set(batches.map((b) => b.sourceDeliveryLineId))).toEqual(
      new Set([d.lines[0].id]),
    );

    const r = await refusal(receive(cycle, d, 1));
    expect(r.code).toBe('STOCK_ALREADY_VERIFIED');
    expect(batchesOf(item)).toHaveLength(2);
  });

  it('A loss of the waiting unit caps the next receipt at the line’s waiting quantity, not only the delivery line’s', async () => {
    // B1's carry-over: a loss on the last leg takes on-the-way first, then
    // waiting. Delivered 15, received 14, 25 on the way + 1 waiting; losing 26
    // leaves the delivery line "1 not received" but the line nothing waiting.
    const { cycle, item, leg } = oneLeg();
    const d = await deliver(leg, item, 15);
    await receive(cycle, d, 14);
    await lose(leg, item, 26);

    const r = await refusal(receive(cycle, d, 1));
    expect(r.code).toBe('RECEIVED_EXCEEDS_DELIVERED');
    expect(r.params).toMatchObject({ available: 0 });
    expect(batchesOf(item)).toHaveLength(1);
  });

  it('Receipt on a cycle still IN_TRANSIT → CYCLE_NOT_ARRIVED', async () => {
    const { cycle, item, leg } = oneLeg({ status: 'IN_TRANSIT_TO_EGYPT' });
    const d = await deliver(leg, item, 15);
    // Since L3 the delivery moves the cycle to ARRIVED_EGYPT by itself. A
    // cycle left behind its deliveries is what a delivery recorded before
    // that rule, or a walk a step check stopped, leaves: still refused.
    db.cycles.find((c) => c.id === cycle.id)!.status = 'IN_TRANSIT_TO_EGYPT';
    const r = await refusal(receive(cycle, d, 15));
    expect(r.code).toBe('CYCLE_NOT_ARRIVED');
    expect(db.batches).toHaveLength(0);
  });

  it('Receive in SELLING (a later delivery) → allowed', async () => {
    const { cycle, item, leg } = oneLeg();
    await receive(cycle, await deliver(leg, item, 15), 15);
    expect(status(cycle)).toBe('SELLING');

    await receive(cycle, await deliver(leg, item, 10, '2026-09-28'), 10);
    expect(batchesOf(item)).toHaveLength(2);
    expect(status(cycle)).toBe('SELLING');
  });

  it.each([
    ['SETTLEMENT', 'CYCLE_SETTLING'],
    ['CLOSED', 'CYCLE_SETTLING'],
    ['CANCELLED', 'CYCLE_CLOSED'],
  ])('Receive on a %s cycle → refused with %s', async (frozen, code) => {
    const { cycle, item, leg } = oneLeg({ status: 'SELLING' });
    const d = await deliver(leg, item, 15);
    db.cycles.find((c) => c.id === cycle.id)!.status = frozen;
    const r = await refusal(receive(cycle, d, 15));
    expect(r.code).toBe(code);
    expect(db.batches).toHaveLength(0);
  });

  it('Receive a leg-1 (UAE) delivery into stock → NOT_LAST_LEG_DELIVERY', async () => {
    const { cycle, item, leg1, leg2 } = twoLegs();
    const uae = await deliver(leg1, item, 40, '2026-09-08');
    departAll(db, leg2, '2026-09-10');
    await deliver(leg2, item, 40, '2026-09-20');
    const r = await refusal(receive(cycle, uae, 40));
    expect(r.code).toBe('NOT_LAST_LEG_DELIVERY');
    expect(db.batches).toHaveLength(0);
  });

  it('A delivery from another cycle → 404', async () => {
    const mine = oneLeg();
    const theirs = oneLeg();
    const theirDelivery = await deliver(theirs.leg, theirs.item, 15);
    const r = await refusal(receive(mine.cycle, theirDelivery, 15));
    expect(r).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      params: { entity: 'shipmentDelivery' },
    });
    // A line of another delivery under a delivery of mine is a 404 too.
    const myDelivery = await deliver(mine.leg, mine.item, 15);
    const r2 = await refusal(
      inventory.verifyStock(
        mine.cycle.id,
        {
          deliveryId: myDelivery.id,
          items: [
            { deliveryLineId: theirDelivery.lines[0].id, receivedQty: 1 },
          ],
        },
        ACTOR,
      ),
    );
    expect(r2).toMatchObject({
      status: 404,
      params: { entity: 'shipmentDeliveryLine' },
    });
    expect(db.batches).toHaveLength(0);
  });

  it('Receiving 0 → no batch; negative qty or negative landed cost → refused', async () => {
    const { cycle, items, leg } = oneLeg({
      lines: [
        ['Brake pad', 40, 100],
        ['Chain kit', 10, 50],
      ],
    });
    const { data: d } = await deliveries.recordDelivery(
      leg.id,
      {
        arrivedOn: '2026-09-20',
        lines: items.map((i) => ({ purchaseOrderItemId: i.id, qty: 10 })),
      },
      ACTOR,
    );
    const line = (i: number) => (d as Row).lines[i].id;

    // A zero line is skipped: the chain kits stay waiting, no empty batch.
    await inventory.verifyStock(
      cycle.id,
      {
        deliveryId: d.id,
        items: [
          { deliveryLineId: line(0), receivedQty: 10 },
          { deliveryLineId: line(1), receivedQty: 0 },
        ],
      },
      ACTOR,
    );
    expect(db.batches.map((b) => b.productId)).toEqual([items[0].productId]);

    // Every line zero is nothing received at all.
    expect(
      (
        await refusal(
          inventory.verifyStock(
            cycle.id,
            {
              deliveryId: d.id,
              items: [{ deliveryLineId: line(1), receivedQty: 0 }],
            },
            ACTOR,
          ),
        )
      ).code,
    ).toBe('QTY_NOT_POSITIVE');

    const neg = await refusal(
      inventory.verifyStock(
        cycle.id,
        {
          deliveryId: d.id,
          items: [{ deliveryLineId: line(1), receivedQty: -1 }],
        },
        ACTOR,
      ),
    );
    expect(neg.code).toBe('QTY_NOT_POSITIVE');

    const negCost = await refusal(
      inventory.verifyStock(
        cycle.id,
        {
          deliveryId: d.id,
          items: [
            { deliveryLineId: line(1), receivedQty: 5, landedUnitCostEgp: -1 },
          ],
        },
        ACTOR,
      ),
    );
    expect(negCost).toMatchObject({
      code: 'VALIDATION_FAILED',
      params: { fields: 'landedUnitCostEgp' },
    });
    expect(db.batches).toHaveLength(1);
  });

  it('The same delivery line twice in one receipt → VALIDATION_FAILED, nothing written', async () => {
    const { cycle, item, leg } = oneLeg();
    const d = await deliver(leg, item, 15);
    const r = await refusal(
      inventory.verifyStock(
        cycle.id,
        {
          deliveryId: d.id,
          items: [
            { deliveryLineId: d.lines[0].id, receivedQty: 5 },
            { deliveryLineId: d.lines[0].id, receivedQty: 5 },
          ],
        },
        ACTOR,
      ),
    );
    expect(r.code).toBe('VALIDATION_FAILED');
    expect(db.batches).toHaveLength(0);
  });

  it('Two receipts of one delivery line at once that exceed it together → one succeeds, the other gets a coded refusal, not a 500', async () => {
    const { cycle, item, leg } = oneLeg({ status: 'SELLING' });
    const d = await deliver(leg, item, 15);
    const results = await Promise.allSettled([
      receive(cycle, d, 10),
      receive(cycle, d, 10),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(HttpException);
    expect((failed[0].reason as HttpException).getResponse()).toMatchObject({
      code: 'RECEIVED_EXCEEDS_DELIVERED',
      params: { available: 5 },
    });
    expect(batchesOf(item).map((b) => b.receivedQty.toNumber())).toEqual([10]);
  });

  it('`receivedQty` after 15 + 10 → 25 (a sum, not overwritten)', async () => {
    const { cycle, item, leg } = oneLeg();
    await receive(cycle, await deliver(leg, item, 15), 15);
    await receive(cycle, await deliver(leg, item, 10, '2026-09-28'), 10);
    expect(db.items.find((i) => i.id === item.id)!.receivedQty.toNumber()).toBe(
      25,
    );
  });

  it('Manual landed-cost override still applies to that batch only', async () => {
    const { cycle, item, leg } = oneLeg();
    await receive(cycle, await deliver(leg, item, 10), 10, {
      landedUnitCostEgp: 95.5,
    });
    await receive(cycle, await deliver(leg, item, 10, '2026-09-28'), 10);

    expect(batchesOf(item).map((b) => b.landedUnitCostEgp.toFixed(4))).toEqual([
      '95.5000',
      '110.0000',
    ]);
    expect(db.ledger.map((t) => t.amount.toFixed(2))).toEqual([
      '955.00',
      '1100.00',
    ]);
  });

  it('Each batch carries its delivery’s arrival date and delivery line', async () => {
    const { cycle, item, leg } = oneLeg();
    const d = await deliver(leg, item, 15, '2026-09-21');
    await receive(cycle, d, 15);
    const [batch] = batchesOf(item);
    expect(batch.arrivedOn.toISOString().slice(0, 10)).toBe('2026-09-21');
    expect(batch.sourceDeliveryLineId).toBe(d.lines[0].id);
  });
});

// ─── The walk to SELLING ─────────────────────────────────────────────────

describe('the first receipt walks the cycle on', () => {
  it('The first receipt walks ARRIVED_EGYPT → VERIFICATION → SELLING through planTransition (each step’s checks run; a refused step stops the walk with its own code, nothing received)', async () => {
    const { cycle, item, leg } = oneLeg({ status: 'ARRIVED_EGYPT' });
    const d = await deliver(leg, item, 15);
    const original = cycles.planTransition.bind(cycles);
    const plan = jest.spyOn(cycles, 'planTransition');

    await receive(cycle, d, 15);
    expect(status(cycle)).toBe('SELLING');
    expect(plan.mock.calls.map((c) => c[1])).toEqual([
      'VERIFICATION',
      'SELLING',
    ]);

    // Now a cycle whose step to SELLING is refused: nothing received, and it
    // has not even stayed in VERIFICATION (the whole receipt rolled back).
    const other = oneLeg({ status: 'ARRIVED_EGYPT' });
    const d2 = await deliver(other.leg, other.item, 15);
    plan.mockImplementation((id, target, opts) => {
      if (target === 'SELLING') {
        return Promise.reject(
          badRequest('PO_HAS_NO_ITEMS', 'a step refused, for the test'),
        );
      }
      return original(id, target, opts);
    });
    const r = await refusal(receive(other.cycle, d2, 15));
    expect(r.code).toBe('PO_HAS_NO_ITEMS');
    expect(batchesOf(other.item)).toHaveLength(0);
    expect(db.ledger.filter((t) => t.cycleId === other.cycle.id)).toHaveLength(
      0,
    );
    expect(status(other.cycle)).toBe('ARRIVED_EGYPT');
  });

  it('From VERIFICATION the walk is one step; in SELLING there is none', async () => {
    const { cycle, item, leg } = oneLeg({ status: 'VERIFICATION' });
    const plan = jest.spyOn(cycles, 'planTransition');
    await receive(cycle, await deliver(leg, item, 15), 15);
    expect(plan.mock.calls.map((c) => c[1])).toEqual(['SELLING']);
    plan.mockClear();
    await receive(cycle, await deliver(leg, item, 5, '2026-09-28'), 5);
    expect(plan).not.toHaveBeenCalled();
  });
});

// ─── Compatibility ───────────────────────────────────────────────────────

describe('the older body (purchaseOrderItemId, no deliveryId)', () => {
  it('The old body with two deliveries waiting → DELIVERY_REQUIRED; with one → works', async () => {
    const { cycle, item, leg } = oneLeg();
    await deliver(leg, item, 15, '2026-09-20');
    await deliver(leg, item, 10, '2026-09-25');
    const r = await refusal(receiveOld(cycle, item, 15));
    expect(r.code).toBe('DELIVERY_REQUIRED');
    expect(r.params).toEqual({ product: 'Brake pad', deliveries: 2 });
    expect(db.batches).toHaveLength(0);

    const single = oneLeg();
    const d = await deliver(single.leg, single.item, 40);
    await receiveOld(single.cycle, single.item, 40);
    expect(batchesOf(single.item)).toHaveLength(1);
    expect(batchesOf(single.item)[0].sourceDeliveryLineId).toBe(d.lines[0].id);
  });

  it('The `giveStock` fixture still produces stock: a dated leg (PUT arrivedOn) then the old body', async () => {
    // What apps/web/tests/support/fixtures.ts does: the leg is posted with
    // departure and arrival dates, the cycle walked to VERIFICATION, and the
    // order line verified with no delivery named.
    const { cycle, item, leg } = oneLeg({ status: 'VERIFICATION' });
    await shipping.updateLeg(
      leg.id,
      { departedOn: '2026-09-01', arrivedOn: '2026-10-05' },
      ACTOR,
    );
    await receiveOld(cycle, item, 40);

    expect(batchesOf(item).map((b) => b.receivedQty.toNumber())).toEqual([40]);
    expect(status(cycle)).toBe('SELLING');
    expect((await position(cycle.id)).accounted).toBe(true);
    // Verifying it again is refused, as TC-CYCLE-06 and TC-MCP-CYC-31 expect.
    expect((await refusal(receiveOld(cycle, item, 40))).code).toBe(
      'STOCK_ALREADY_VERIFIED',
    );
  });

  it('An order line nothing of which reached Egypt → RECEIVED_EXCEEDS_DELIVERED (0 delivered)', async () => {
    const { cycle, item } = oneLeg();
    const r = await refusal(receiveOld(cycle, item, 5));
    expect(r).toMatchObject({
      code: 'RECEIVED_EXCEEDS_DELIVERED',
      params: { available: 0 },
    });
  });
});

// ─── The fixed unit cost and its residual ────────────────────────────────

describe('landed cost per ordered unit', () => {
  it('Rounding: 3 ordered, 100 shipping → batches + losses re-sum to the line’s landed total exactly; the final event takes the residual', async () => {
    // Goods free, 100 of shipping over 3 units: 33.3333 a unit, and three
    // events of 33.33 would leave the line a piastre short.
    const { cycle, item, leg } = oneLeg({
      lines: [['Spark plug', 3, 0]],
      legCost: 100,
    });
    await receive(cycle, await deliver(leg, item, 1, '2026-09-20'), 1);
    await lose(leg, item, 1);
    await receive(cycle, await deliver(leg, item, 1, '2026-09-25'), 1);

    const batchCosts = db.ledger
      .filter((t) => t.relatedId === item.id)
      .map((t) => t.amount.toFixed(2));
    const lossCosts = db.losses.map((x) => x.costEgp.toFixed(2));
    expect(batchCosts).toEqual(['33.33', '33.34']);
    expect(lossCosts).toEqual(['33.33']);
    const total = [...batchCosts, ...lossCosts].reduce(
      (s, v) => s.add(v),
      D(0),
    );
    expect(total.toFixed(2)).toBe('100.00');
    expect(batchesOf(item).map((b) => b.landedUnitCostEgp.toFixed(4))).toEqual([
      '33.3333',
      '33.3400',
    ]);
  });

  it('Rounding: when the final event is a loss, the loss takes the residual', async () => {
    const { cycle, item, leg } = oneLeg({
      lines: [['Spark plug', 3, 0]],
      legCost: 100,
    });
    await receive(cycle, await deliver(leg, item, 2), 2);
    await lose(leg, item, 1);
    expect(db.ledger.map((t) => t.amount.toFixed(2))).toEqual(['66.67']);
    expect(db.losses.map((x) => x.costEgp.toFixed(2))).toEqual(['33.33']);

    // 66.67 + 33.33: the loss here is the final event and absorbs nothing
    // only because the batch rounded up; the sum is exact either way.
    const other = oneLeg({ lines: [['Spark plug', 3, 0]], legCost: 100 });
    await receive(other.cycle, await deliver(other.leg, other.item, 1), 1);
    await lose(other.leg, other.item, 2);
    const residual = db.losses.find(
      (x) => x.purchaseOrderItemId === other.item.id,
    )!;
    expect(residual.costEgp.toFixed(2)).toBe('66.67');
    expect(residual.unitCostEgp.toFixed(4)).toBe('33.3350');
  });

  it('lineEventCost: an earlier batch with a manual cost is counted at the standard cost, so the residual is not pushed onto the last batch', () => {
    const r = lineEventCost({
      orderedQty: 3,
      landedTotalEgp: 100,
      unitCostEgp: '33.3333',
      priorReceivedQtys: [2],
      priorLosses: [],
      qty: 1,
    });
    expect(r).toMatchObject({ final: true });
    expect(r.costEgp.toFixed(2)).toBe('33.33');
  });
});

// ─── FIFO ────────────────────────────────────────────────────────────────

describe('FIFO', () => {
  it('FIFO: batch A arrived 1 Oct and received 20 Oct, batch B arrived 10 Oct and received 11 Oct → B sells first; COGS stable after more deliveries', async () => {
    // Two cycles of one product: A's goods landed first but sat uncounted.
    const a = oneLeg({ status: 'SELLING', lines: [['Brake pad', 40, 100]] });
    const b = cycleWithOrder(db, { status: 'SELLING' });
    // The same product on both orders.
    b.items[0].productId = a.item.productId;
    const bLeg = addLeg(db, b.cycle, 1, {
      departedOn: '2026-09-01',
      amountEgp: 800,
    });

    const aDelivery = await deliver(a.leg, a.item, 10, '2026-10-01');
    const bDelivery = await deliver(bLeg, b.items[0], 10, '2026-10-09');

    jest.setSystemTime(new Date('2026-10-11T09:00:00Z'));
    await receive(b.cycle, bDelivery, 10);
    jest.setSystemTime(new Date('2026-10-20T09:00:00Z'));
    await receive(a.cycle, aDelivery, 10);

    // B costs 120 a unit (4,000 + 800 over 40), A 110.
    const order = await sell(a.item.productId, 5);
    const [alloc] = allocationsOf(order);
    expect(
      db.batches.find((x) => x.id === alloc.inventoryBatchId)!.cycleId,
    ).toBe(b.cycle.id);
    expect(alloc.cogsEgp.toFixed(2)).toBe('600.00');

    await receive(a.cycle, await deliver(a.leg, a.item, 10, '2026-10-20'), 10);
    expect(allocationsOf(order)[0].cogsEgp.toFixed(2)).toBe('600.00');
  });
});

// ─── Arrival per batch ───────────────────────────────────────────────────

describe('GET /inventory', () => {
  it('Inventory shows each batch’s own Arrived date; two deliveries → two dates; never leg 1’s date', async () => {
    const { cycle, item, leg1, leg2 } = twoLegs();
    await deliver(leg1, item, 40, '2026-09-08');
    departAll(db, leg2, '2026-09-10');
    await receive(cycle, await deliver(leg2, item, 15, '2026-09-20'), 15);
    await receive(cycle, await deliver(leg2, item, 10, '2026-09-29'), 10);

    const { data } = await inventory.getStock({ productId: item.productId });
    const dates = (data[0] as Row).batches.map((x: Row) =>
      new Date(x.arrivedOn).toISOString().slice(0, 10),
    );
    expect(dates).toEqual(['2026-09-20', '2026-09-29']);
    expect(dates).not.toContain('2026-09-08');
  });

  it('A batch from before deliveries, with no arrival of its own, falls back to the last dated leg', async () => {
    const { cycle, item, leg1, leg2 } = twoLegs('SELLING');
    db.legs.find((l) => l.id === leg1.id)!.arrivedOn = new Date('2026-08-01');
    db.legs.find((l) => l.id === leg2.id)!.arrivedOn = new Date('2026-08-15');
    db.batches.push({
      id: randomUUID(),
      cycleId: cycle.id,
      productId: item.productId,
      sourcePoItemId: item.id,
      sourceDeliveryLineId: null,
      arrivedOn: null,
      receivedQty: D(40),
      remainingQty: D(40),
      reservedQty: D(0),
      saleableQty: D(40),
      landedUnitCostEgp: D(110),
      verificationStatus: 'VERIFIED',
      createdAt: new Date('2026-08-20'),
    });
    const { data } = await inventory.getStock({ productId: item.productId });
    expect(
      new Date((data[0] as Row).batches[0].arrivedOn)
        .toISOString()
        .slice(0, 10),
    ).toBe('2026-08-15');
  });
});

// ─── The settlement gate ─────────────────────────────────────────────────

describe('a cycle settles only once every unit is accounted for (§8)', () => {
  it('With 5 on the way, the plain transition SELLING → SETTLEMENT → SHIPMENT_NOT_ACCOUNTED, as approve is', async () => {
    const { cycle, item, leg } = oneLeg();
    await receive(cycle, await deliver(leg, item, 35), 35);
    expect(status(cycle)).toBe('SELLING');

    const r = await refusal(cycles.transition(cycle.id, 'SETTLEMENT', ACTOR));
    expect(r.code).toBe('SHIPMENT_NOT_ACCOUNTED');
    expect(r.params).toMatchObject({ onTheWay: 5, waiting: 0, lines: 1 });
    expect(status(cycle)).toBe('SELLING');

    await lose(leg, item, 5);
    await cycles.transition(cycle.id, 'SETTLEMENT', ACTOR);
    expect(status(cycle)).toBe('SETTLEMENT');
  });

  it('Delivered but not received counts too: the gate names what is waiting', async () => {
    const { cycle, item, leg } = oneLeg();
    await receive(cycle, await deliver(leg, item, 40), 38);
    const r = await refusal(cycles.transition(cycle.id, 'SETTLEMENT', ACTOR));
    expect(r).toMatchObject({
      code: 'SHIPMENT_NOT_ACCOUNTED',
      params: { onTheWay: 0, waiting: 2 },
    });
  });

  it('A cycle with nothing ordered is accounted, and settles', async () => {
    const cycle = {
      id: randomUUID(),
      code: 'CYC-EMPTY',
      status: 'SELLING',
      originType: 'UAE_DIRECT',
    };
    db.cycles.push(cycle);
    await cycles.transition(cycle.id, 'SETTLEMENT', ACTOR);
    expect(status(cycle)).toBe('SETTLEMENT');
  });

  it('The transition takes the cycle’s lock (it can no longer race a delivery deleted at the same moment)', async () => {
    const { cycle, item, leg } = oneLeg();
    await receive(cycle, await deliver(leg, item, 40), 40);
    const before = db.locksTaken;
    await cycles.transition(cycle.id, 'SETTLEMENT', ACTOR);
    expect(db.locksTaken).toBe(before + 1);
  });

  it('Settlement approve with 5 on the way → SHIPMENT_NOT_ACCOUNTED with the count; after marking them lost → allowed', async () => {
    const { cycle, item, leg } = oneLeg();
    participant(cycle);
    await receive(cycle, await deliver(leg, item, 35), 35);
    const { data: draft } = await settlements.calculate(cycle.id);

    const r = await refusal(settlements.approve(draft!.id, ACTOR));
    expect(r.code).toBe('SHIPMENT_NOT_ACCOUNTED');
    expect(r.params).toMatchObject({ onTheWay: 5, lines: 1 });
    expect(status(cycle)).toBe('SELLING');

    await lose(leg, item, 5);
    const { data: again } = await settlements.calculate(cycle.id);
    await settlements.approve(again!.id, ACTOR);
    expect(status(cycle)).toBe('SETTLEMENT');
  });

  it('`markPaid` / CLOSE still refuses unsold stock without saying so (existing TC-CYCLE-08 still passes)', async () => {
    const { cycle, item, leg } = oneLeg();
    participant(cycle);
    await receive(cycle, await deliver(leg, item, 40), 40);
    const { data } = await settlements.calculate(cycle.id);
    await settlements.approve(data!.id, ACTOR);
    const row = db.settlements.find((s) => s.id === data!.id)!;
    row.cycle = { id: cycle.id, code: cycle.code, currency: 'EGP' };
    row.lines = [];

    const r = await refusal(settlements.markPaid(data!.id, ACTOR));
    expect(r.code).toBe('CYCLE_HAS_UNSOLD_STOCK');
  });
});

// ─── Losses in profit ────────────────────────────────────────────────────

describe('losses in profit (§2, §9; rule 11)', () => {
  it('Settlement profit with a loss of 5 × 110 → profit is 550 lower than without the loss', async () => {
    const { cycle, item, leg } = oneLeg();
    participant(cycle);
    await receive(cycle, await deliver(leg, item, 35), 35);
    await sell(item.productId, 10, 200);

    const before = await settlements.calculate(cycle.id);
    // Not a vacuous zero: 10 sold at 200 against 110 is 900 of profit.
    expect(before.summary.grossProfitEgp).toBe('900.00');

    await lose(leg, item, 5);
    const after = await settlements.calculate(cycle.id);
    expect(after.summary.lossesEgp).toBe('550.00');
    expect(after.summary.grossProfitEgp).toBe('350.00');
    // No ledger row for the loss: no money moved (§9).
    expect(db.ledger.filter((t) => t.category !== 'purchase')).toHaveLength(0);
  });

  it('Settlement and analytics both subtract `cycleLossesEgp`, and agree', async () => {
    const { cycle, item, leg } = oneLeg();
    participant(cycle);
    await receive(cycle, await deliver(leg, item, 35), 35);
    await sell(item.productId, 10, 200);
    await lose(leg, item, 5);

    const settled = await settlements.calculate(cycle.id);
    const { data } = await analytics.getCycleProfitability();
    const row = (data as Row[]).find((c) => c.cycleCode === cycle.code)!;
    expect(row.lossesEgp).toBe(550);
    expect(row.profit).toBe(350);
    expect(row.profit.toFixed(2)).toBe(settled.summary.grossProfitEgp);
  });
});

// ─── PurchaseOrderItem.receivedQty ───────────────────────────────────────

describe('PUT /purchases/items/:id', () => {
  it('`PUT /purchases/items/:id` with `receivedQty` → refused', async () => {
    const { item } = oneLeg();
    const purchases = new PurchasesService(
      fakePrisma(db),
      { log: jest.fn() } as unknown as AuditService,
      {} as NotificationsService,
    );
    const r = await refusal(
      purchases.updateItem(item.id, { receivedQty: 40 }, ACTOR),
    );
    expect(r).toMatchObject({
      code: 'VALIDATION_FAILED',
      params: { fields: 'receivedQty' },
    });
    expect(db.items.find((i) => i.id === item.id)!.receivedQty).toBeNull();
  });
});

// ─── Roles (CLAUDE.md rule 12) ───────────────────────────────────────────

describe('roles', () => {
  const contextFor = (role: string) =>
    ({
      getHandler: () =>
        Object.getOwnPropertyDescriptor(
          InventoryController.prototype,
          'verifyStock',
        )!.value as unknown,
      getClass: () => InventoryController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: 'u', role } }),
      }),
    }) as unknown as ExecutionContext;

  it('An investor or shop token on `POST /receipts/verify` → refused with a code', () => {
    const guard = new RolesGuard(new Reflector());
    for (const role of [
      'TEMP_INVESTOR',
      'ADMIN_SUPPORT',
      'SHOP_OWNER_PORTAL',
    ]) {
      let thrown: HttpException | undefined;
      try {
        guard.canActivate(contextFor(role));
      } catch (e) {
        thrown = e as HttpException;
      }
      expect(thrown?.getStatus()).toBe(403);
      expect(thrown?.getResponse()).toEqual(
        expect.objectContaining({ code: 'ROLE_NOT_ALLOWED' }),
      );
    }
    expect(guard.canActivate(contextFor('CORE_PARTNER'))).toBe(true);
  });
});
