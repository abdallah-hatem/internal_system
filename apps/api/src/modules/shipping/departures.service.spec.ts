/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- the fake database's rows are untyped records */
import { randomUUID } from 'crypto';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard';
import { loadShipment } from '../../common/shipment-load';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { DeliveriesService } from './deliveries.service';
import { ShippingService } from './shipping.service';
import { ShippingController } from './shipping.controller';
import {
  addLeg,
  cycleWithOrder,
  emptyStore,
  fakePrisma,
  type Row,
  type Store,
} from './shipment-fake-spec';

/**
 * L8 — goods can leave in parts (BUSINESS_LOGIC §1, owner 2026-10-12).
 *
 * Recording a departure, undoing one, and what deliveries and losses may take
 * once departures are per product. Each case tries to break a rule: too much,
 * zero, the future, too early, the wrong cycle, a frozen cycle, the second
 * time. The database is the in-memory fake; the services and the position
 * arithmetic are the real ones.
 */

// 12:00 in Cairo on 2026-10-10.
const NOW = new Date('2026-10-10T09:00:00Z');
beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    now: NOW,
  });
});
afterEach(() => jest.useRealTimers());

let db: Store;
let deliveries: DeliveriesService;
let shipping: ShippingService;

beforeEach(() => {
  db = emptyStore();
  const prisma = fakePrisma(db);
  const audit = { log: jest.fn() } as unknown as AuditService;
  const notifications = {
    createForMultipleUsers: jest.fn(),
  } as unknown as NotificationsService;
  const costing = new CostingService(prisma);
  const cycles = new CyclesService(prisma, audit, notifications);
  deliveries = new DeliveriesService(
    prisma,
    audit,
    notifications,
    costing,
    cycles,
  );
  shipping = new ShippingService(prisma, audit, costing, deliveries);
});

const ACTOR = randomUUID();

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

const depart = (
  leg: Row,
  lines: [Row, number][] | undefined,
  departedOn = '2026-09-05',
) =>
  deliveries.recordDeparture(
    leg.id,
    {
      departedOn,
      lines: lines?.map(([item, qty]) => ({
        purchaseOrderItemId: item.id,
        qty,
      })),
    },
    ACTOR,
  );
const deliver = (leg: Row, item: Row, qty: number, arrivedOn = '2026-09-20') =>
  deliveries.recordDelivery(
    leg.id,
    { arrivedOn, lines: [{ purchaseOrderItemId: item.id, qty }] },
    ACTOR,
  );
const lose = (leg: Row, item: Row, qty: number) =>
  deliveries.recordLoss(
    leg.id,
    { lines: [{ purchaseOrderItemId: item.id, qty }] },
    ACTOR,
  );

const legRow = (id: string) => db.legs.find((l) => l.id === id)!;
const statusOf = (c: Row) => db.cycles.find((x) => x.id === c.id)!.status;
async function legPosition(cycleId: string, legId: string) {
  const loaded = (await loadShipment(fakePrisma(db), cycleId))!;
  return loaded.position.legs.find((l) => l.legId === legId)!;
}

/** A UAE-direct cycle, 40 brake pads ordered on 1 September, leg not left. */
function waiting(status = 'PURCHASING') {
  const { cycle, items, po } = cycleWithOrder(db, { status });
  po.orderedOn = new Date('2026-09-01T00:00:00Z');
  const leg = addLeg(db, cycle, 1, { departedOn: null });
  return { cycle, item: items[0], leg, po };
}

/** A China cycle: 40 ordered on 1 September; neither leg has left. */
function china(status = 'PURCHASING') {
  const { cycle, items, po } = cycleWithOrder(db, {
    status,
    originType: 'CHINA',
  });
  po.orderedOn = new Date('2026-09-01T00:00:00Z');
  const leg1 = addLeg(db, cycle, 1, { departedOn: null });
  const leg2 = addLeg(db, cycle, 2, { departedOn: null });
  return { cycle, item: items[0], leg1, leg2 };
}

// ─── Recording a departure ───────────────────────────────────────────────

describe('POST /shipping/legs/:id/departures — the limits', () => {
  it('25 of 40 leaves → 15 still waiting, leg PARTLY_DEPARTED, departedOn stored as that day', async () => {
    const { cycle, item, leg } = waiting();
    await depart(leg, [[item, 25]]);
    const p = await legPosition(cycle.id, leg.id);
    expect(p.lines[0]).toMatchObject({ atOrigin: 15, onTheWay: 25 });
    expect(legRow(leg.id).status).toBe('PARTLY_DEPARTED');
    expect(legRow(leg.id).departedOn).toEqual(new Date('2026-09-05T00:00:00Z'));
  });

  it('more than waits (41 of 40) → DEPARTURE_EXCEEDS_WAITING, nothing written', async () => {
    const { item, leg } = waiting();
    const r = await refusal(depart(leg, [[item, 41]]));
    expect(r.code).toBe('DEPARTURE_EXCEEDS_WAITING');
    expect(r.params).toMatchObject({
      line: 'Brake pad',
      waiting: 40,
      asked: 41,
    });
    expect(db.departures).toHaveLength(0);
    expect(legRow(leg.id).status).toBe('PENDING');
  });

  it('the second time: 25, then 15 → in transit; then 1 more → refused', async () => {
    const { item, leg } = waiting();
    await depart(leg, [[item, 25]]);
    await depart(leg, [[item, 15]], '2026-09-07');
    expect(legRow(leg.id).status).toBe('IN_TRANSIT');
    // The leg still left on the FIRST day.
    expect(legRow(leg.id).departedOn).toEqual(new Date('2026-09-05T00:00:00Z'));
    const r = await refusal(depart(leg, [[item, 1]], '2026-09-08'));
    expect(r.code).toBe('DEPARTURE_EXCEEDS_WAITING');
    expect(db.departures).toHaveLength(2);
  });

  it('zero and negative → QTY_NOT_POSITIVE; no lines at all → VALIDATION_FAILED', async () => {
    const { item, leg } = waiting();
    for (const qty of [0, -5]) {
      const r = await refusal(depart(leg, [[item, qty]]));
      expect(r.code).toBe('QTY_NOT_POSITIVE');
    }
    const empty = await refusal(depart(leg, []));
    expect(empty.code).toBe('VALIDATION_FAILED');
    expect(db.departures).toHaveLength(0);
  });

  it('the same product twice → VALIDATION_FAILED', async () => {
    const { item, leg } = waiting();
    const r = await refusal(
      depart(leg, [
        [item, 5],
        [item, 5],
      ]),
    );
    expect(r.code).toBe('VALIDATION_FAILED');
  });

  it('dated tomorrow in Cairo → DATE_IN_FUTURE; today → accepted', async () => {
    const { item, leg } = waiting();
    const r = await refusal(depart(leg, [[item, 5]], '2026-10-11'));
    expect(r.code).toBe('DATE_IN_FUTURE');
    await depart(leg, [[item, 5]], '2026-10-10');
    expect(db.departures).toHaveLength(1);
  });

  it('leg 1 dated before the order was placed → DEPARTURE_BEFORE_ORDER; on the order day → accepted', async () => {
    const { item, leg } = waiting();
    const r = await refusal(depart(leg, [[item, 5]], '2026-08-31'));
    expect(r.code).toBe('DEPARTURE_BEFORE_ORDER');
    expect(r.params).toMatchObject({
      day: '2026-08-31',
      orderedOn: '2026-09-01',
    });
    await depart(leg, [[item, 5]], '2026-09-01');
    expect(db.departures).toHaveLength(1);
  });

  it('leg 2 with nothing in Dubai yet → DEPARTURE_EXCEEDS_WAITING; with no lines → DEPARTURE_NOTHING_WAITING', async () => {
    const { item, leg1, leg2 } = china();
    await depart(leg1, [[item, 40]]);
    const r = await refusal(depart(leg2, [[item, 1]], '2026-09-10'));
    expect(r.code).toBe('DEPARTURE_EXCEEDS_WAITING');
    const all = await refusal(depart(leg2, undefined, '2026-09-10'));
    expect(all.code).toBe('DEPARTURE_NOTHING_WAITING');
  });

  it('leg 2 dated before the leg-1 delivery that brought the goods → DEPARTURE_BEFORE_ARRIVAL', async () => {
    const { item, leg1, leg2 } = china();
    await depart(leg1, [[item, 40]], '2026-09-02');
    await deliver(leg1, item, 10, '2026-09-10');
    await deliver(leg1, item, 20, '2026-09-15');
    // 30 in Dubai now, but only 10 had arrived by the 12th.
    const r = await refusal(depart(leg2, [[item, 25]], '2026-09-12'));
    expect(r.code).toBe('DEPARTURE_BEFORE_ARRIVAL');
    expect(r.params).toMatchObject({
      day: '2026-09-12',
      available: 10,
      asked: 25,
    });
    await depart(leg2, [[item, 10]], '2026-09-12');
    // The 10 that left on the 12th are spent: on the 14th nothing more was there.
    const again = await refusal(depart(leg2, [[item, 1]], '2026-09-14'));
    expect(again.code).toBe('DEPARTURE_BEFORE_ARRIVAL');
    await depart(leg2, [[item, 20]], '2026-09-15');
  });

  it('"everything waiting" on leg 2 takes only what had reached Dubai by that day', async () => {
    const { cycle, item, leg1, leg2 } = china();
    await depart(leg1, [[item, 40]], '2026-09-02');
    await deliver(leg1, item, 10, '2026-09-10');
    await deliver(leg1, item, 20, '2026-09-15');
    await depart(leg2, undefined, '2026-09-12');
    const p = await legPosition(cycle.id, leg2.id);
    expect(p.lines[0]).toMatchObject({ departed: 10, atOrigin: 20 });
  });

  it('a line of another cycle → 404, never a departure of someone else’s order', async () => {
    const { leg } = waiting();
    const other = cycleWithOrder(db);
    const r = await refusal(depart(leg, [[other.items[0], 1]]));
    expect(r.status).toBe(404);
    expect(db.departures).toHaveLength(0);
  });

  it('an unknown leg → 404', async () => {
    const { item } = waiting();
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const r = await refusal(depart({ id }, [[item, 1]]));
      expect(r.status).toBe(404);
    }
  });

  it.each([
    ['SETTLEMENT', 'CYCLE_SETTLING'],
    ['CLOSED', 'CYCLE_SETTLING'],
    ['CANCELLED', 'CYCLE_CLOSED'],
  ])('a departure on a cycle %s → %s', async (status, code) => {
    const { item, leg } = waiting(status);
    const r = await refusal(depart(leg, [[item, 1]]));
    expect(r.code).toBe(code);
    expect(db.departures).toHaveLength(0);
  });

  it('two departures of 30 against 40 sent at once → one is refused (the cycle lock)', async () => {
    const { item, leg } = waiting();
    const results = await Promise.allSettled([
      depart(leg, [[item, 30]]),
      depart(leg, [[item, 30]]),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.departures).toHaveLength(1);
  });
});

// ─── L3: the first departure moves the cycle, later ones do not ──────────

describe('the cycle’s status follows the first departure only', () => {
  it('first departure walks PURCHASING → IN_TRANSIT_TO_EGYPT; a second, with the cycle kept back, moves nothing', async () => {
    const { cycle, item, leg } = waiting('PURCHASING');
    const first = await depart(leg, [[item, 25]]);
    expect(statusOf(cycle)).toBe('IN_TRANSIT_TO_EGYPT');
    expect(first.cycleStatus).toMatchObject({ moved: true });

    // A partner moved it back by hand; the next departure is not news.
    db.cycles.find((c) => c.id === cycle.id)!.status = 'PURCHASING';
    const second = await depart(leg, [[item, 15]], '2026-09-07');
    expect(statusOf(cycle)).toBe('PURCHASING');
    expect(second.cycleStatus).toBeNull();
  });

  it('China: leg 1’s first departure → IN_TRANSIT; leg 2’s first → IN_TRANSIT_TO_EGYPT', async () => {
    const { cycle, item, leg1, leg2 } = china('PURCHASING');
    await depart(leg1, [[item, 20]], '2026-09-02');
    expect(statusOf(cycle)).toBe('IN_TRANSIT');
    await deliver(leg1, item, 20, '2026-09-10');
    expect(statusOf(cycle)).toBe('ARRIVED_UAE');
    await depart(leg2, [[item, 20]], '2026-09-12');
    expect(statusOf(cycle)).toBe('IN_TRANSIT_TO_EGYPT');
  });
});

// ─── Deliveries and losses take only what has left ──────────────────────

describe('a delivery or a loss can only take what has LEFT', () => {
  it('25 of 40 left: a delivery of 30 → DELIVERY_EXCEEDS_IN_TRANSIT (goods still at the supplier cannot arrive)', async () => {
    const { item, leg } = waiting();
    await depart(leg, [[item, 25]]);
    const r = await refusal(deliver(leg, item, 30));
    expect(r.code).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
    expect(r.params).toMatchObject({ onTheWay: 25, asked: 30 });
    await deliver(leg, item, 25);
    expect(legRow(leg.id).status).toBe('PARTLY_ARRIVED');
  });

  it('a delivery dated before the departure that carried its goods → DELIVERY_BEFORE_GOODS_LEFT', async () => {
    const { item, leg } = waiting();
    await depart(leg, [[item, 10]], '2026-09-05');
    await depart(leg, [[item, 30]], '2026-09-20');
    // On the 15th only the first 10 had left.
    const r = await refusal(deliver(leg, item, 15, '2026-09-15'));
    expect(r.code).toBe('DELIVERY_BEFORE_GOODS_LEFT');
    expect(r.params).toMatchObject({ available: 10, asked: 15 });
    await deliver(leg, item, 10, '2026-09-15');
    await deliver(leg, item, 30, '2026-09-25');
    expect(legRow(leg.id).status).toBe('ARRIVED');
  });

  it('nothing left yet → a delivery is LEG_NOT_DEPARTED', async () => {
    const { item, leg } = waiting();
    const r = await refusal(deliver(leg, item, 1));
    expect(r.code).toBe('LEG_NOT_DEPARTED');
  });

  it('25 of 40 left: marking 30 lost → LOSS_EXCEEDS_IN_TRANSIT; nothing left → any loss refused', async () => {
    const { item, leg } = waiting();
    const none = await refusal(lose(leg, item, 1));
    expect(none.code).toBe('LOSS_EXCEEDS_IN_TRANSIT');
    await depart(leg, [[item, 25]]);
    const r = await refusal(lose(leg, item, 30));
    expect(r.code).toBe('LOSS_EXCEEDS_IN_TRANSIT');
    expect(r.params).toMatchObject({ onTheWay: 25, asked: 30 });
    await lose(leg, item, 25);
    expect(db.losses).toHaveLength(1);
  });

  it('deleting a leg-1 delivery whose goods leg 2 already sent on → DELIVERY_IN_USE (carried)', async () => {
    const { item, leg1, leg2 } = china('IN_TRANSIT');
    await depart(leg1, [[item, 40]], '2026-09-02');
    const { data: d1 } = await deliver(leg1, item, 20, '2026-09-08');
    await deliver(leg1, item, 20, '2026-09-09');
    await depart(leg2, [[item, 40]], '2026-09-10');
    db.cycles.find((c) => c.id === leg1.cycleId)!.status = 'IN_TRANSIT';
    const r = await refusal(deliveries.deleteDelivery(d1.id, ACTOR));
    expect(r.code).toBe('DELIVERY_IN_USE');
    expect(r.params).toEqual({ why: 'carried' });
  });
});

// ─── Undoing a departure ─────────────────────────────────────────────────

describe('DELETE /shipping/departures/:id', () => {
  it('a later departure nothing came from → undone; the leg reads as before it', async () => {
    const { item, leg } = waiting('PURCHASING');
    await depart(leg, [[item, 25]]);
    const { data: second } = await depart(leg, [[item, 15]], '2026-09-07');
    expect(legRow(leg.id).status).toBe('IN_TRANSIT');
    await deliveries.deleteDeparture(second.id, ACTOR);
    expect(legRow(leg.id).status).toBe('PARTLY_DEPARTED');
    expect(db.departures).toHaveLength(1);
  });

  it('undoing the first of two moves the leg’s departure day to the second', async () => {
    const { item, leg } = waiting('PURCHASING');
    const { data: first } = await depart(leg, [[item, 25]]);
    await depart(leg, [[item, 15]], '2026-09-07');
    db.cycles.find((c) => c.id === leg.cycleId)!.status = 'PURCHASING';
    await deliveries.deleteDeparture(first.id, ACTOR);
    expect(legRow(leg.id).departedOn).toEqual(new Date('2026-09-07T00:00:00Z'));
  });

  it('goods from it were delivered → DEPARTURE_IN_USE (used); the later, unused one can still go', async () => {
    const { item, leg } = waiting('PURCHASING');
    const { data: first } = await depart(leg, [[item, 20]]);
    const { data: second } = await depart(leg, [[item, 20]], '2026-09-07');
    await deliver(leg, item, 5);
    const r = await refusal(deliveries.deleteDeparture(first.id, ACTOR));
    expect(r.code).toBe('DEPARTURE_IN_USE');
    expect(r.params).toEqual({ why: 'used' });
    await deliveries.deleteDeparture(second.id, ACTOR);
  });

  it('goods from it were marked lost → DEPARTURE_IN_USE (used)', async () => {
    const { item, leg } = waiting('PURCHASING');
    const { data } = await depart(leg, [[item, 20]]);
    await lose(leg, item, 1);
    const r = await refusal(deliveries.deleteDeparture(data.id, ACTOR));
    expect(r.params).toEqual({ why: 'used' });
  });

  it('the shipment’s last departure → undone, and the cycle back to Preparing (§1, 2026-10-27)', async () => {
    const { cycle, item, leg } = waiting('PURCHASING');
    const { data } = await depart(leg, [[item, 20]]);
    expect(statusOf(cycle)).toBe('IN_TRANSIT_TO_EGYPT');
    const r = await deliveries.deleteDeparture(data.id, ACTOR);
    expect(legRow(leg.id).status).toBe('PENDING');
    expect(legRow(leg.id).departedOn).toBeNull();
    expect(statusOf(cycle)).toBe('PREPARING');
    expect(r.cycleStatus).toMatchObject({
      from: 'IN_TRANSIT_TO_EGYPT',
      to: 'PREPARING',
      moved: true,
    });
  });

  it('a cycle kept at a status no departure set is left there when its departure is undone', async () => {
    const { cycle, item, leg } = waiting('PURCHASING');
    const { data } = await depart(leg, [[item, 20]]);
    db.cycles.find((c) => c.id === cycle.id)!.status = 'ARRIVED_UAE';
    const r = await deliveries.deleteDeparture(data.id, ACTOR);
    expect(legRow(leg.id).status).toBe('PENDING');
    // A UAE-direct cycle at Arrived UAE asks nothing of its leg: not moved.
    expect(statusOf(cycle)).toBe('ARRIVED_UAE');
    expect(r.cycleStatus).toBeNull();
  });

  it('on a cycle being settled → CYCLE_SETTLING', async () => {
    const { cycle, item, leg } = waiting('PURCHASING');
    const { data } = await depart(leg, [[item, 20]]);
    await depart(leg, [[item, 20]], '2026-09-07');
    db.cycles.find((c) => c.id === cycle.id)!.status = 'SETTLEMENT';
    const r = await refusal(deliveries.deleteDeparture(data.id, ACTOR));
    expect(r.code).toBe('CYCLE_SETTLING');
  });

  it('twice → the second is 404; an unknown id → 404', async () => {
    const { item, leg } = waiting('PURCHASING');
    await depart(leg, [[item, 20]]);
    const { data } = await depart(leg, [[item, 20]], '2026-09-07');
    await deliveries.deleteDeparture(data.id, ACTOR);
    expect(
      (await refusal(deliveries.deleteDeparture(data.id, ACTOR))).status,
    ).toBe(404);
    expect(
      (await refusal(deliveries.deleteDeparture('nope', ACTOR))).status,
    ).toBe(404);
  });
});

// ─── The leg forms: create and edit ──────────────────────────────────────

describe('the Shipments page’s leg forms record the first departure the same way', () => {
  it('creating a leg with a departure and per-product lines → that departure, those lines', async () => {
    const { cycle, items, po } = cycleWithOrder(db, { status: 'PURCHASING' });
    po.orderedOn = new Date('2026-09-01T00:00:00Z');
    const { data } = await shipping.createLeg(
      cycle.id,
      {
        sequence: 1,
        departedOn: '2026-09-05',
        departureLines: [{ purchaseOrderItemId: items[0].id, qty: 12 }],
        costBasis: 'FLAT',
        amount: 100,
      },
      ACTOR,
    );
    expect(db.departures).toHaveLength(1);
    expect(db.departures[0].lines[0].qty.toString()).toBe('12');
    expect(legRow(data.id).status).toBe('PARTLY_DEPARTED');
  });

  it('creating a leg with lines but no date → VALIDATION_FAILED, no leg', async () => {
    const { cycle, items } = cycleWithOrder(db, { status: 'PURCHASING' });
    const r = await refusal(
      shipping.createLeg(
        cycle.id,
        {
          sequence: 1,
          departureLines: [{ purchaseOrderItemId: items[0].id, qty: 12 }],
        },
        ACTOR,
      ),
    );
    expect(r.code).toBe('VALIDATION_FAILED');
    expect(db.legs).toHaveLength(0);
  });

  it('creating a leg whose departure is refused writes no leg either', async () => {
    const { cycle, items } = cycleWithOrder(db, { status: 'PURCHASING' });
    const r = await refusal(
      shipping.createLeg(
        cycle.id,
        {
          sequence: 1,
          departedOn: '2026-09-05',
          departureLines: [{ purchaseOrderItemId: items[0].id, qty: 41 }],
        },
        ACTOR,
      ),
    );
    expect(r.code).toBe('DEPARTURE_EXCEEDS_WAITING');
    expect(db.legs).toHaveLength(0);
  });

  it('editing: the only departure moves to a new day (deliveries after it stay); with several → LEG_HAS_SEVERAL_DEPARTURES', async () => {
    const { item, leg } = waiting('IN_TRANSIT_TO_EGYPT');
    await depart(leg, [[item, 40]], '2026-09-05');
    await deliver(leg, item, 10, '2026-09-20');
    await shipping.updateLeg(leg.id, { departedOn: '2026-09-06' }, ACTOR);
    expect(db.departures).toHaveLength(1);
    expect(db.departures[0].departedOn).toEqual(
      new Date('2026-09-06T00:00:00Z'),
    );
    expect(legRow(leg.id).departedOn).toEqual(new Date('2026-09-06T00:00:00Z'));
    // Moving it after a delivery is still refused.
    const late = await refusal(
      shipping.updateLeg(leg.id, { departedOn: '2026-09-21' }, ACTOR),
    );
    expect(late.code).toBe('DELIVERY_BEFORE_DEPARTURE');

    const other = waiting('PURCHASING');
    await depart(other.leg, [[other.item, 20]]);
    await depart(other.leg, [[other.item, 20]], '2026-09-07');
    const r = await refusal(
      shipping.updateLeg(other.leg.id, { departedOn: '2026-09-02' }, ACTOR),
    );
    expect(r.code).toBe('LEG_HAS_SEVERAL_DEPARTURES');
    // The same day sent back unchanged is not a change.
    await shipping.updateLeg(other.leg.id, { departedOn: '2026-09-05' }, ACTOR);
    expect(db.departures).toHaveLength(3);
  });

  it('editing a leg that has not left, with lines → its first departure, of those lines', async () => {
    const { item, leg } = waiting('PURCHASING');
    await shipping.updateLeg(
      leg.id,
      {
        departedOn: '2026-09-05',
        departureLines: [{ purchaseOrderItemId: item.id, qty: 7 }],
      },
      ACTOR,
    );
    expect(db.departures[0].lines[0].qty.toString()).toBe('7');
  });

  it('moving the only departure before the order date → DEPARTURE_BEFORE_ORDER', async () => {
    const { item, leg } = waiting('PURCHASING');
    await depart(leg, [[item, 40]], '2026-09-05');
    const r = await refusal(
      shipping.updateLeg(leg.id, { departedOn: '2026-08-20' }, ACTOR),
    );
    expect(r.code).toBe('DEPARTURE_BEFORE_ORDER');
    expect(db.departures[0].departedOn).toEqual(
      new Date('2026-09-05T00:00:00Z'),
    );
  });
});

// ─── Who may (rule 12) ───────────────────────────────────────────────────

describe('roles', () => {
  const contextFor = (handler: string, role: string) =>
    ({
      getHandler: () =>
        Object.getOwnPropertyDescriptor(ShippingController.prototype, handler)!
          .value as unknown,
      getClass: () => ShippingController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: 'u', role } }),
      }),
    }) as unknown as ExecutionContext;

  it('an investor or a shop is refused on both departure endpoints; a core partner gets through', () => {
    const guard = new RolesGuard(new Reflector());
    for (const handler of ['recordDeparture', 'deleteDeparture']) {
      for (const role of [
        'TEMP_INVESTOR',
        'SHOP_OWNER_PORTAL',
        'ADMIN_SUPPORT',
      ]) {
        expect(() => guard.canActivate(contextFor(handler, role))).toThrow(
          HttpException,
        );
      }
      expect(guard.canActivate(contextFor(handler, 'CORE_PARTNER'))).toBe(true);
    }
  });
});
