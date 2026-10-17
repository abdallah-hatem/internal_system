/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- the fake database's rows are untyped records, as Prisma's argument objects are */
import { randomUUID } from 'crypto';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard';
import { cycleLossesEgp } from '../../common/cycle-losses';
import { shipmentPosition } from '../../common/shipment-position';
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
  departAll,
  cycleWithOrder,
  D,
  emptyStore,
  fakePrisma,
  receive,
  type Row,
  type Store,
} from './shipment-fake-spec';

/**
 * B2 — recording deliveries and losses (plan 2026-10-10, BUSINESS_LOGIC §1 §2
 * §9). One test per edge case in the plan, named after it. The database is an
 * in-memory fake (`shipment-fake-spec.ts`); the services, the costing and the
 * position arithmetic are the real ones. e2e for the same cases:
 * apps/web/tests/81-deliveries-and-losses.spec.ts.
 */

// 12:00 in Cairo on 2026-10-10 (UTC+3, summer time). Only the clock is faked:
// the fake database yields with setImmediate, which must keep running.
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
let cycles: CyclesService;
let notifications: { createForMultipleUsers: jest.Mock };

beforeEach(() => {
  db = emptyStore();
  const prisma = fakePrisma(db);
  const audit = { log: jest.fn() } as unknown as AuditService;
  notifications = { createForMultipleUsers: jest.fn() };
  const costing = new CostingService(prisma);
  cycles = new CyclesService(
    prisma,
    audit,
    notifications as unknown as NotificationsService,
  );
  deliveries = new DeliveriesService(
    prisma,
    audit,
    notifications as unknown as NotificationsService,
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

async function position(cycleId: string) {
  const prisma = fakePrisma(db);
  return (await loadShipment(prisma, cycleId))!.position;
}

const legRow = (id: string) => db.legs.find((l) => l.id === id)!;

/** A UAE-direct cycle in transit: 40 brake pads at 100, one leg costing 400. */
function oneLeg(status = 'IN_TRANSIT') {
  const { cycle, items } = cycleWithOrder(db, { status });
  const leg = addLeg(db, cycle, 1);
  return { cycle, item: items[0], leg };
}

/**
 * A China cycle: 40 pads, leg 1 China→UAE departed, leg 2 UAE→Egypt recorded.
 * Nothing can leave Dubai before it reaches Dubai (L8), so leg 2 departs —
 * `departLeg2` — only once leg 1 has delivered something.
 */
function twoLegs(status = 'IN_TRANSIT_TO_EGYPT') {
  const { cycle, items } = cycleWithOrder(db, { status, originType: 'CHINA' });
  const leg1 = addLeg(db, cycle, 1, { departedOn: '2026-09-01' });
  const leg2 = addLeg(db, cycle, 2, { departedOn: null });
  return { cycle, item: items[0], leg1, leg2 };
}

/** Everything that has reached Dubai leaves on leg 2, on the 10th. */
const departLeg2 = (leg2: Row) => departAll(db, leg2, '2026-09-10');

// ─── Deliveries ──────────────────────────────────────────────────────────

describe('POST /shipping/legs/:id/deliveries', () => {
  it('Delivery of 41 when 40 are on the way → DELIVERY_EXCEEDS_IN_TRANSIT, nothing written', async () => {
    const { item, leg } = oneLeg();
    const r = await refusal(deliver(leg, item, 41));
    expect(r.code).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
    expect(r.params).toEqual({ line: 'Brake pad', onTheWay: 40, asked: 41 });
    expect(db.deliveries).toHaveLength(0);
    expect(legRow(leg.id).status).toBe('IN_TRANSIT');
  });

  it('Deliveries 15, 10, 5, 10 → all accepted; the fifth (1 more) → refused', async () => {
    const { cycle, item, leg } = oneLeg();
    await deliver(leg, item, 15, '2026-09-10');
    expect(legRow(leg.id).status).toBe('PARTLY_ARRIVED');
    expect(legRow(leg.id).arrivedOn).toBeNull();
    await deliver(leg, item, 10, '2026-09-20');
    await deliver(leg, item, 5, '2026-09-30');
    await deliver(leg, item, 10, '2026-10-05');

    // The leg's stored reading is re-derived after every write (§1).
    expect(legRow(leg.id).status).toBe('ARRIVED');
    expect(legRow(leg.id).arrivedOn).toEqual(new Date('2026-10-05T00:00:00Z'));
    const p = await position(cycle.id);
    expect(p.legs[0].delivered).toBe(40);
    expect(p.legs[0].onTheWay).toBe(0);

    const fifth = await refusal(deliver(leg, item, 1, '2026-10-06'));
    expect(fifth.code).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
    expect(db.deliveries).toHaveLength(4);
  });

  it('Leg 2 delivery larger than leg 1 has delivered so far → refused', async () => {
    const { item, leg1, leg2 } = twoLegs();
    await deliver(leg1, item, 30, '2026-09-08');
    departLeg2(leg2);
    const r = await refusal(deliver(leg2, item, 31, '2026-09-20'));
    expect(r.code).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
    expect(r.params?.onTheWay).toBe(30);
    // Exactly what entered it is fine.
    await deliver(leg2, item, 30, '2026-09-20');
    expect(legRow(leg2.id).status).toBe('ARRIVED');
    expect(legRow(leg1.id).status).toBe('PARTLY_ARRIVED');
  });

  it('Delivery dated tomorrow → DATE_IN_FUTURE', async () => {
    const { item, leg } = oneLeg();
    const r = await refusal(deliver(leg, item, 5, '2026-10-11'));
    expect(r.code).toBe('DATE_IN_FUTURE');
    expect(db.deliveries).toHaveLength(0);
  });

  it('Delivery dated before the leg departed → DELIVERY_BEFORE_DEPARTURE', async () => {
    const { item, leg } = oneLeg(); // departed 2026-09-01
    const r = await refusal(deliver(leg, item, 5, '2026-08-31'));
    expect(r.code).toBe('DELIVERY_BEFORE_DEPARTURE');
    expect(r.params).toEqual(
      expect.objectContaining({ day: '2026-08-31', departedOn: '2026-09-01' }),
    );
    // The departure day itself is fine.
    await deliver(leg, item, 5, '2026-09-01');
  });

  it('Delivery on a leg not yet departed → LEG_NOT_DEPARTED', async () => {
    const { cycle, items } = cycleWithOrder(db, { status: 'PURCHASING' });
    const leg = addLeg(db, cycle, 1, { departedOn: null });
    const r = await refusal(deliver(leg, items[0], 5));
    expect(r.code).toBe('LEG_NOT_DEPARTED');
    expect(db.deliveries).toHaveLength(0);
  });

  it('Delivery or loss on a SETTLEMENT or CLOSED cycle → CYCLE_SETTLING; on a CANCELLED cycle → CYCLE_CLOSED', async () => {
    for (const [status, code] of [
      ['SETTLEMENT', 'CYCLE_SETTLING'],
      ['CLOSED', 'CYCLE_SETTLING'],
      ['CANCELLED', 'CYCLE_CLOSED'],
    ]) {
      const { item, leg } = oneLeg(status);
      expect((await refusal(deliver(leg, item, 5))).code).toBe(code);
      expect((await refusal(lose(leg, item, 5))).code).toBe(code);
    }
    expect(db.deliveries).toHaveLength(0);
    expect(db.losses).toHaveLength(0);
  });

  it('qty 0 or negative → QTY_NOT_POSITIVE', async () => {
    const { item, leg } = oneLeg();
    for (const qty of [0, -5, 0.0001]) {
      expect((await refusal(deliver(leg, item, qty))).code).toBe(
        'QTY_NOT_POSITIVE',
      );
      expect((await refusal(lose(leg, item, qty))).code).toBe(
        'QTY_NOT_POSITIVE',
      );
    }
    expect(db.deliveries).toHaveLength(0);
  });

  it("A line from another cycle's order → 404 purchaseOrderItem, not 500", async () => {
    const { leg } = oneLeg();
    const other = cycleWithOrder(db, { status: 'IN_TRANSIT' });
    for (const p of [
      deliver(leg, other.items[0], 5),
      lose(leg, other.items[0], 5),
    ]) {
      const r = await refusal(p);
      expect(r.status).toBe(404);
      expect(r.params).toEqual({ entity: 'purchaseOrderItem' });
    }
    // An id that is not even a uuid is the same refusal, not a cast failure.
    const r = await refusal(
      deliveries.recordDelivery(
        leg.id,
        {
          arrivedOn: '2026-09-20',
          lines: [{ purchaseOrderItemId: 'x', qty: 1 }],
        },
        ACTOR,
      ),
    );
    expect(r.status).toBe(404);
    expect(db.deliveries).toHaveLength(0);
  });

  it('The same line twice in one delivery → VALIDATION_FAILED', async () => {
    const { item, leg } = oneLeg();
    const r = await refusal(
      deliveries.recordDelivery(
        leg.id,
        {
          arrivedOn: '2026-09-20',
          lines: [
            { purchaseOrderItemId: item.id, qty: 5 },
            { purchaseOrderItemId: item.id, qty: 5 },
          ],
        },
        ACTOR,
      ),
    );
    expect(r.code).toBe('VALIDATION_FAILED');
  });

  it('No lines → VALIDATION_FAILED', async () => {
    const { leg } = oneLeg();
    for (const lines of [[], undefined]) {
      const r = await refusal(
        deliveries.recordDelivery(
          leg.id,
          { arrivedOn: '2026-09-20', lines: lines as never },
          ACTOR,
        ),
      );
      expect(r.code).toBe('VALIDATION_FAILED');
    }
  });

  it('Unknown leg id → 404', async () => {
    const { item } = oneLeg();
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const r = await refusal(deliver({ id }, item, 5));
      expect(r.status).toBe(404);
      expect(r.params).toEqual({ entity: 'shippingLeg' });
      const l = await refusal(lose({ id }, item, 5));
      expect(l.status).toBe(404);
    }
  });

  it('A cycle with no order lines: nothing can leave (DEPARTURE_NOTHING_WAITING), so nothing can be delivered (LEG_NOT_DEPARTED)', async () => {
    const { cycle } = cycleWithOrder(db, { lines: [] });
    const leg = addLeg(db, cycle, 1);
    const left = await refusal(
      deliveries.recordDeparture(leg.id, { departedOn: '2026-09-01' }, ACTOR),
    );
    expect(left.code).toBe('DEPARTURE_NOTHING_WAITING');
    const r = await refusal(deliver(leg, { id: randomUUID() }, 1));
    expect(r.code).toBe('LEG_NOT_DEPARTED');
    expect(db.departures).toHaveLength(0);
  });

  it('A delivery dated today at 00:37 Cairo → accepted; dated tomorrow in Cairo → refused', async () => {
    // 00:37 on the 10th in Cairo is still the 9th in UTC. A UTC check would
    // call the 10th "tomorrow" and refuse a delivery that came today.
    jest.setSystemTime(new Date('2026-10-09T21:37:00Z'));
    const { item, leg } = oneLeg();
    await deliver(leg, item, 5, '2026-10-10');
    expect(db.deliveries).toHaveLength(1);
    const r = await refusal(deliver(leg, item, 5, '2026-10-11'));
    expect(r.code).toBe('DATE_IN_FUTURE');
    // An instant is read in Cairo too: 23:30 UTC on the 10th is the 11th there.
    const late = await refusal(deliver(leg, item, 5, '2026-10-10T23:30:00Z'));
    expect(late.code).toBe('DATE_IN_FUTURE');
  });

  it('Two deliveries sent at once that together exceed what is on the way → exactly one succeeds', async () => {
    const { item, leg } = oneLeg();
    const results = await Promise.allSettled([
      deliver(leg, item, 30),
      deliver(leg, item, 30),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // A coded refusal, not a 500.
    expect((refused[0].reason as HttpException).getResponse()).toEqual(
      expect.objectContaining({ code: 'DELIVERY_EXCEEDS_IN_TRANSIT' }),
    );
    expect(db.deliveries).toHaveLength(1);
  });

  it('Two losses, or a loss and a delivery, sent at once that together exceed what is on the way → exactly one succeeds', async () => {
    const { item, leg } = oneLeg();
    const results = await Promise.allSettled([
      lose(leg, item, 25),
      deliver(leg, item, 25),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.deliveries.length + db.losses.length).toBe(1);
  });
});

// ─── Losses ──────────────────────────────────────────────────────────────

describe('POST /shipping/legs/:id/losses', () => {
  it('Loss of more than is on the way → LOSS_EXCEEDS_IN_TRANSIT', async () => {
    // Leg 1: 30 of 40 delivered to the UAE, so 10 can still be lost on it.
    const { item, leg1 } = twoLegs('IN_TRANSIT');
    await deliver(leg1, item, 30, '2026-09-08');
    const r = await refusal(lose(leg1, item, 11));
    expect(r.code).toBe('LOSS_EXCEEDS_IN_TRANSIT');
    expect(r.params).toEqual({ line: 'Brake pad', onTheWay: 10, asked: 11 });

    // The last leg: 30 delivered and all 30 received, so again 10 at most —
    // received goods are in stock, not lost.
    const last = oneLeg('SELLING');
    const { data } = await deliver(last.leg, last.item, 30);
    receive(db, last.cycle, data.lines[0], 30);
    expect((await refusal(lose(last.leg, last.item, 11))).code).toBe(
      'LOSS_EXCEEDS_IN_TRANSIT',
    );
    expect(db.losses).toHaveLength(0);
  });

  it('Loss of 5 → a loss record at 5 × unit cost; no ledger row', async () => {
    const { cycle, item, leg } = oneLeg();
    // 40 pads at 100 = 4,000 of goods + 400 of freight → 110.00 a unit.
    const { data } = await lose(leg, item, 5);
    expect(data).toHaveLength(1);
    expect(db.losses[0].unitCostEgp.toFixed(4)).toBe('110.0000');
    expect(db.losses[0].costEgp.toFixed(2)).toBe('550.00');
    // The fake has no financialTransaction table: a ledger write would have
    // thrown. And the one shared figure settlement and analytics read says 550.
    expect((await cycleLossesEgp(fakePrisma(db), cycle.id)).toFixed(2)).toBe(
      '550.00',
    );
    const p = await position(cycle.id);
    expect(p.legs[0].onTheWay).toBe(35);
    expect(p.lines[0].lost).toBe(5);
  });

  it('Loss then a delivery: on the way shrinks by both, and a delivery for the lost units is refused', async () => {
    const { cycle, item, leg } = oneLeg();
    await lose(leg, item, 10);
    await deliver(leg, item, 25);
    expect((await position(cycle.id)).legs[0].onTheWay).toBe(5);
    const r = await refusal(deliver(leg, item, 6));
    expect(r.code).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
    await deliver(leg, item, 5);
    // Delivered 30, lost 10: everything that entered is accounted → arrived.
    expect(legRow(leg.id).status).toBe('ARRIVED');
  });

  it('Loss of units a last-leg delivery brought but that were never received → allowed; it clears the waiting quantity', async () => {
    const { cycle, item, leg } = oneLeg('SELLING');
    const { data: d } = await deliver(leg, item, 40);
    receive(db, cycle, d.lines[0], 38);
    expect((await position(cycle.id)).lines[0].waiting).toBe(2);
    await lose(leg, item, 2);
    const p = await position(cycle.id);
    expect(p.lines[0].waiting).toBe(0);
    expect(p.accounted).toBe(true);
    // And no more than that.
    expect((await refusal(lose(leg, item, 1))).code).toBe(
      'LOSS_EXCEEDS_IN_TRANSIT',
    );
  });

  it('A loss on leg 1 marks the leg arrived once nothing is on the way', async () => {
    const { item, leg1 } = twoLegs('IN_TRANSIT');
    await deliver(leg1, item, 30, '2026-09-08');
    await lose(leg1, item, 10);
    expect(legRow(leg1.id).status).toBe('ARRIVED');
    expect(legRow(leg1.id).arrivedOn).toEqual(new Date('2026-09-08T00:00:00Z'));
  });
});

describe('DELETE /shipping/losses/:id (taking a loss back)', () => {
  it('Take a loss back → the units are on the way again; on a SETTLEMENT / CLOSED cycle → CYCLE_SETTLING', async () => {
    const { cycle, item, leg } = oneLeg();
    await deliver(leg, item, 30);
    const { data } = await lose(leg, item, 10);
    expect(legRow(leg.id).status).toBe('ARRIVED');

    await deliveries.takeBackLoss(data[0].id, ACTOR);
    expect(db.losses).toHaveLength(0);
    expect((await position(cycle.id)).legs[0].onTheWay).toBe(10);
    expect(legRow(leg.id).status).toBe('PARTLY_ARRIVED');

    const { data: again } = await lose(leg, item, 10);
    for (const status of ['SETTLEMENT', 'CLOSED']) {
      cycle.status = status;
      const r = await refusal(deliveries.takeBackLoss(again[0].id, ACTOR));
      expect(r.code).toBe('CYCLE_SETTLING');
      expect(db.losses).toHaveLength(1);
    }
  });

  it('Taking back an unknown loss → 404, not 500', async () => {
    for (const id of [randomUUID(), 'nope']) {
      const r = await refusal(deliveries.takeBackLoss(id, ACTOR));
      expect(r.status).toBe(404);
      expect(r.params).toEqual({ entity: 'shipmentLoss' });
    }
  });

  it('A delivery, loss or loss take-back on a cycle in SETTLEMENT → CYCLE_SETTLING; after the settlement is reversed to SELLING → allowed', async () => {
    const { cycle, item, leg } = oneLeg('SELLING');
    await deliver(leg, item, 20);
    const { data } = await lose(leg, item, 5);

    cycle.status = 'SETTLEMENT';
    expect((await refusal(deliver(leg, item, 5))).code).toBe('CYCLE_SETTLING');
    expect((await refusal(lose(leg, item, 5))).code).toBe('CYCLE_SETTLING');
    expect(
      (await refusal(deliveries.takeBackLoss(data[0].id, ACTOR))).code,
    ).toBe('CYCLE_SETTLING');

    // Reversing a settlement puts the cycle back in SELLING (§8).
    cycle.status = 'SELLING';
    await deliver(leg, item, 5);
    await lose(leg, item, 5);
    await deliveries.takeBackLoss(data[0].id, ACTOR);
    expect(db.deliveries).toHaveLength(2);
    expect(db.losses).toHaveLength(1);
  });
});

// ─── Deleting a delivery ─────────────────────────────────────────────────

describe('DELETE /shipping/deliveries/:id', () => {
  it('Deleting a leg-1 delivery that leg 2 has drawn on → DELIVERY_IN_USE; deleting the only last-leg delivery of a cycle in ARRIVED_EGYPT → DELIVERY_IN_USE', async () => {
    const { cycle, item, leg1, leg2 } = twoLegs();
    const { data: first } = await deliver(leg1, item, 20, '2026-09-05');
    await deliver(leg1, item, 20, '2026-09-08');
    departLeg2(leg2);
    await deliver(leg2, item, 30, '2026-09-20');

    // Without the first leg-1 delivery, leg 2 would have delivered 30 of 20.
    const drawn = await refusal(deliveries.deleteDelivery(first.id, ACTOR));
    expect(drawn.code).toBe('DELIVERY_IN_USE');
    expect(drawn.params).toEqual({ why: 'carried' });

    cycle.status = 'ARRIVED_EGYPT';
    const onlyLast = db.deliveries.find((d) => d.legId === leg2.id)!;
    const status = await refusal(deliveries.deleteDelivery(onlyLast.id, ACTOR));
    expect(status.code).toBe('DELIVERY_IN_USE');
    expect(status.params).toEqual({ why: 'status' });
    expect(db.deliveries).toHaveLength(3);
  });

  it('Deleting a delivery on a closed or cancelled cycle → refused', async () => {
    for (const [status, code] of [
      ['CLOSED', 'CYCLE_SETTLING'],
      ['SETTLEMENT', 'CYCLE_SETTLING'],
      ['CANCELLED', 'CYCLE_CLOSED'],
    ]) {
      const { cycle, item, leg } = oneLeg();
      const { data } = await deliver(leg, item, 5);
      cycle.status = status;
      expect(
        (await refusal(deliveries.deleteDelivery(data.id, ACTOR))).code,
      ).toBe(code);
    }
    expect(db.deliveries).toHaveLength(3);
  });

  it('Delete a delivery whose lines were received into stock → DELIVERY_IN_USE', async () => {
    const { cycle, item, leg } = oneLeg('SELLING');
    await deliver(leg, item, 10, '2026-09-10');
    const { data } = await deliver(leg, item, 10, '2026-09-20');
    receive(db, cycle, data.lines[0], 4);
    const r = await refusal(deliveries.deleteDelivery(data.id, ACTOR));
    expect(r.code).toBe('DELIVERY_IN_USE');
    expect(r.params).toEqual({ why: 'received' });
  });

  it('Delete a delivery that was not received → removed, and the leg status is re-derived', async () => {
    const { item, leg } = oneLeg();
    await deliver(leg, item, 30, '2026-09-10');
    const { data } = await deliver(leg, item, 10, '2026-09-20');
    expect(legRow(leg.id).status).toBe('ARRIVED');
    expect(legRow(leg.id).arrivedOn).toEqual(new Date('2026-09-20T00:00:00Z'));

    await deliveries.deleteDelivery(data.id, ACTOR);
    expect(db.deliveries).toHaveLength(1);
    expect(legRow(leg.id).status).toBe('PARTLY_ARRIVED');
    expect(legRow(leg.id).arrivedOn).toBeNull();

    // The second visit: deleting it again is a clear 404.
    const again = await refusal(deliveries.deleteDelivery(data.id, ACTOR));
    expect(again.status).toBe(404);
    expect(again.params).toEqual({ entity: 'shipmentDelivery' });
  });
});

// ─── The old leg form (PUT /shipping/legs/:id) ───────────────────────────

describe('PUT /shipping/legs/:id', () => {
  it('PUT leg with a future arrivedOn → refused; with arrivedOn: null or a status → ignored, no change', async () => {
    const { item, leg } = oneLeg();
    await deliver(leg, item, 15);
    const before = { ...legRow(leg.id) };

    const r = await refusal(
      shipping.updateLeg(leg.id, { arrivedOn: '2026-10-11' }, ACTOR),
    );
    expect(r.code).toBe('DATE_IN_FUTURE');

    await shipping.updateLeg(
      leg.id,
      { arrivedOn: null, status: 'ARRIVED' },
      ACTOR,
    );
    expect(db.deliveries).toHaveLength(1);
    expect(legRow(leg.id).status).toBe('PARTLY_ARRIVED');
    expect(legRow(leg.id).arrivedOn).toEqual(before.arrivedOn);
  });

  it('PUT leg with arrivedOn and 25 still on the way → one delivery of 25; again with the same date → no new delivery', async () => {
    const { cycle, item, leg } = oneLeg();
    await deliver(leg, item, 15, '2026-09-10');

    await shipping.updateLeg(leg.id, { arrivedOn: '2026-09-25' }, ACTOR);
    expect(db.deliveries).toHaveLength(2);
    expect(Number(db.deliveries[1].lines[0].qty)).toBe(25);
    expect(legRow(leg.id).status).toBe('ARRIVED');
    expect(legRow(leg.id).arrivedOn).toEqual(new Date('2026-09-25T00:00:00Z'));

    await shipping.updateLeg(leg.id, { arrivedOn: '2026-09-25' }, ACTOR);
    expect(db.deliveries).toHaveLength(2);
    expect((await position(cycle.id)).legs[0].delivered).toBe(40);
  });

  it('PUT leg with arrivedOn on a leg that never left → refused as before (ARRIVAL_WITHOUT_DEPARTURE)', async () => {
    const { cycle, items } = cycleWithOrder(db, { status: 'PURCHASING' });
    const leg = addLeg(db, cycle, 1, { departedOn: null });
    const r = await refusal(
      shipping.updateLeg(leg.id, { arrivedOn: '2026-09-25' }, ACTOR),
    );
    expect(r.code).toBe('ARRIVAL_WITHOUT_DEPARTURE');
    expect(db.deliveries).toHaveLength(0);
    // With the departure in the same edit it is one delivery of everything.
    await shipping.updateLeg(
      leg.id,
      { departedOn: '2026-09-01', arrivedOn: '2026-09-25' },
      ACTOR,
    );
    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0].lines[0].purchaseOrderItemId).toBe(items[0].id);
  });

  it("Moving a leg's departure after a delivery so the delivery predates it → refused", async () => {
    const { item, leg } = oneLeg();
    await deliver(leg, item, 15, '2026-09-10');
    const r = await refusal(
      shipping.updateLeg(leg.id, { departedOn: '2026-09-11' }, ACTOR),
    );
    expect(r.code).toBe('DELIVERY_BEFORE_DEPARTURE');
    expect(legRow(leg.id).departedOn).toEqual(new Date('2026-09-01T00:00:00Z'));
    // The delivery day itself is still a possible departure day.
    await shipping.updateLeg(leg.id, { departedOn: '2026-09-10' }, ACTOR);
  });

  // §2, 2026-10-17: after a receipt the cost can be corrected and the cycle is
  // re-costed (leg-recost.db.spec.ts) — unless something stands in the way,
  // each with its own code.
  it("Changing a leg's cost after a loss → LEG_COST_LOCKED_LOSSES; after a receipt with a settlement drafted → LEG_COST_LOCKED_SETTLEMENT", async () => {
    // After a loss.
    const a = oneLeg();
    await lose(a.leg, a.item, 1);
    const afterLoss = await refusal(
      shipping.updateLeg(a.leg.id, { amount: 500 }, ACTOR),
    );
    expect(afterLoss.code).toBe('LEG_COST_LOCKED_LOSSES');
    expect(legRow(a.leg.id).amountEgp.toFixed(2)).toBe('400.00');

    // After a receipt, on a cycle with a settlement drafted.
    const b = oneLeg('SELLING');
    const { data } = await deliver(b.leg, b.item, 10);
    receive(db, b.cycle, data.lines[0], 10);
    db.settlements.push({
      id: randomUUID(),
      cycleId: b.cycle.id,
      status: 'DRAFT',
    });
    const afterReceipt = await refusal(
      shipping.updateLeg(
        b.leg.id,
        { costBasis: 'PER_PIECE', ratePerUnit: 10, chargeablePieces: 40 },
        ACTOR,
      ),
    );
    expect(afterReceipt.code).toBe('LEG_COST_LOCKED_SETTLEMENT');

    // Not a cost change: the same amount sent again, or a tracking number.
    await shipping.updateLeg(
      b.leg.id,
      { amount: 400, trackingRef: 'T-1' },
      ACTOR,
    );
    expect(legRow(b.leg.id).trackingRef).toBe('T-1');

    // Before anything is received or lost, the cost can still move.
    const c = oneLeg();
    await deliver(c.leg, c.item, 10);
    await shipping.updateLeg(c.leg.id, { amount: 500 }, ACTOR);
    expect(legRow(c.leg.id).amountEgp.toFixed(2)).toBe('500.00');
  });

  it("A late freight charge once a settlement stands → recorded as an ordinary ledger expense on the cycle; counted once in settlement and analytics; no batch's cost changes", async () => {
    const { cycle, item, leg } = oneLeg('SELLING');
    const { data } = await deliver(leg, item, 40);
    receive(db, cycle, data.lines[0], 40);
    db.settlements.push({
      id: randomUUID(),
      cycleId: cycle.id,
      status: 'APPROVED',
    });
    const batch = db.batches[0];

    // The leg cannot absorb it…
    expect(
      (await refusal(shipping.updateLeg(leg.id, { amount: 650 }, ACTOR))).code,
    ).toBe('LEG_COST_LOCKED_SETTLEMENT');
    // …so nothing about the goods moved: the batch keeps its cost and the
    // losses figure (which settlement and analytics add to the ledger's
    // expenses) carries nothing of it. The charge itself goes in as a ledger
    // expense — the one place it is counted (e2e TC-DL-LATE-FREIGHT checks the
    // settlement figure moves by exactly that much).
    expect(batch.landedUnitCostEgp.toFixed(2)).toBe('110.00');
    expect(legRow(leg.id).amountEgp.toFixed(2)).toBe('400.00');
    expect((await cycleLossesEgp(fakePrisma(db), cycle.id)).toFixed(2)).toBe(
      '0.00',
    );
  });

  // Owner 2026-10-17: leg 2 was saved at 20 × 100 pieces while 230 went on it.
  // Once the shipment knows what is on the leg, a per-piece cost is for that.
  it('A per-piece cost is for the pieces on the leg: a typed count that disagrees is replaced by it, before and after a receipt', async () => {
    const { leg } = oneLeg();
    const onLeg = legRow(leg.id);
    await shipping.updateLeg(
      leg.id,
      { costBasis: 'PER_PIECE', ratePerUnit: 20, chargeablePieces: 100 },
      ACTOR,
    );
    expect(Number(legRow(leg.id).chargeablePieces)).toBe(40);
    expect(legRow(leg.id).amount.toFixed(2)).toBe('800.00');
    expect(legRow(leg.id).amountEgp.toFixed(2)).toBe('800.00');
    expect(onLeg.id).toBe(leg.id);

    // No count at all: the same.
    const b = oneLeg();
    await shipping.updateLeg(
      b.leg.id,
      { costBasis: 'PER_PIECE', ratePerUnit: 20 },
      ACTOR,
    );
    expect(Number(legRow(b.leg.id).chargeablePieces)).toBe(40);
    expect(legRow(b.leg.id).amountEgp.toFixed(2)).toBe('800.00');

    // A flat bill is untouched by it.
    await shipping.updateLeg(
      b.leg.id,
      { costBasis: 'FLAT', amount: 1000 },
      ACTOR,
    );
    expect(legRow(b.leg.id).amountEgp.toFixed(2)).toBe('1000.00');
  });

  it('A USD leg edited without a currency keeps its currency (it used to reset to EGP)', async () => {
    const { leg } = oneLeg();
    legRow(leg.id).currency = 'USD';
    legRow(leg.id).fxRateToEgp = D(50);
    legRow(leg.id).amount = D(8);
    await shipping.updateLeg(leg.id, { trackingRef: 'X' }, ACTOR);
    expect(legRow(leg.id).currency).toBe('USD');
  });

  // CLAUDE.md rule 3: the form's DTO said Min(0) and the service said
  // nothing, so any other caller — the assistant's update_leg_cost among
  // them (2026-10-17) — could write a negative cost or a zero rate that made a
  // USD bill cost nothing in pounds.
  it.each([
    ['a negative amount', { amount: -100 }, 'LEG_COST_NEGATIVE'],
    [
      'a negative rate',
      { costBasis: 'PER_PIECE', ratePerUnit: -2, chargeablePieces: 40 },
      'LEG_COST_NEGATIVE',
    ],
    [
      'negative pieces',
      { costBasis: 'PER_PIECE', ratePerUnit: 2, chargeablePieces: -40 },
      'LEG_COST_NEGATIVE',
    ],
    [
      'a rate to EGP of zero',
      { currency: 'USD', amount: 10, fxRateToEgp: 0 },
      'RATE_NOT_POSITIVE',
    ],
    [
      'a negative rate to EGP',
      { currency: 'USD', amount: 10, fxRateToEgp: -50 },
      'RATE_NOT_POSITIVE',
    ],
  ] as const)(
    'Editing a leg to %s is refused, the cost kept',
    async (_, cost, code) => {
      const { leg } = oneLeg();
      expect(
        (await refusal(shipping.updateLeg(leg.id, cost, ACTOR))).code,
      ).toBe(code);
      expect(legRow(leg.id).amountEgp.toFixed(2)).toBe('400.00');
    },
  );

  it('Creating a leg with a negative amount → LEG_COST_NEGATIVE, no leg', async () => {
    const { cycle } = cycleWithOrder(db, { status: 'PURCHASING' });
    expect(
      (
        await refusal(
          shipping.createLeg(cycle.id, { sequence: 1, amount: -1 }, ACTOR),
        )
      ).code,
    ).toBe('LEG_COST_NEGATIVE');
    expect(db.legs).toHaveLength(0);
  });

  // I3: the cycle page records a departure with this endpoint. §1 says no
  // departure is recorded on a cancelled or closed cycle; the button is hidden
  // there, and the server says so too (CLAUDE.md §3).
  it('A departure on a SETTLEMENT or CLOSED cycle → CYCLE_SETTLING; on a CANCELLED one → CYCLE_CLOSED; nothing written', async () => {
    for (const [status, code] of [
      ['SETTLEMENT', 'CYCLE_SETTLING'],
      ['CLOSED', 'CYCLE_SETTLING'],
      ['CANCELLED', 'CYCLE_CLOSED'],
    ]) {
      const { cycle, items } = cycleWithOrder(db, { status });
      const leg = addLeg(db, cycle, 1, { departedOn: null });
      const r = await refusal(
        shipping.updateLeg(leg.id, { departedOn: '2026-09-05' }, ACTOR),
      );
      expect(r.code).toBe(code);
      expect(legRow(leg.id).departedOn).toBeNull();
      expect(items).toHaveLength(1);
    }
  });

  it('Moving the departure of a closed cycle is refused; re-sending the same day (the edit form does) is not', async () => {
    const { leg } = oneLeg('CLOSED'); // departed 2026-09-01
    expect(
      (
        await refusal(
          shipping.updateLeg(leg.id, { departedOn: '2026-09-02' }, ACTOR),
        )
      ).code,
    ).toBe('CYCLE_SETTLING');
    await shipping.updateLeg(
      leg.id,
      { departedOn: '2026-09-01', trackingRef: 'T-1' },
      ACTOR,
    );
    expect(legRow(leg.id).departedOn).toEqual(new Date('2026-09-01T00:00:00Z'));
  });

  it('A departure on an open cycle is recorded, and the leg reads in transit', async () => {
    const { cycle } = cycleWithOrder(db, { status: 'PURCHASING' });
    const leg = addLeg(db, cycle, 1, { departedOn: null });
    await shipping.updateLeg(leg.id, { departedOn: '2026-09-05' }, ACTOR);
    expect(legRow(leg.id).departedOn).toEqual(new Date('2026-09-05T00:00:00Z'));
    expect(legRow(leg.id).status).toBe('IN_TRANSIT');
  });
});

describe('POST /cycles/:id/shipping-legs with an arrival date', () => {
  it('records one delivery of everything that entered the leg, and reads arrived', async () => {
    const { cycle, items } = cycleWithOrder(db, { status: 'PURCHASING' });
    const { data } = await shipping.createLeg(
      cycle.id,
      {
        sequence: 1,
        departedOn: '2026-09-01',
        arrivedOn: '2026-09-15',
        costBasis: 'FLAT',
        amount: 0,
      },
      ACTOR,
    );
    expect(db.deliveries).toHaveLength(1);
    expect(db.deliveries[0].lines[0].purchaseOrderItemId).toBe(items[0].id);
    expect(data.status).toBe('ARRIVED');
    expect(data.arrivedOn).toEqual(new Date('2026-09-15T00:00:00Z'));
  });
});

// ─── The cycle gates (§1's new table) ────────────────────────────────────

describe('cycle transitions read deliveries', () => {
  it("Cycle → ARRIVED_UAE after leg 1's first delivery of 15/40 → allowed; with no delivery → LEG_NOT_ARRIVED", async () => {
    const { cycle, item, leg1 } = twoLegs('IN_TRANSIT');
    const none = await refusal(cycles.planTransition(cycle.id, 'ARRIVED_UAE'));
    expect(none.code).toBe('LEG_NOT_ARRIVED');

    // L3: the delivery itself walks the cycle through this same gate — and
    // no further: nothing has left Dubai yet (L8).
    await deliver(leg1, item, 15, '2026-09-08');
    expect(db.cycles.find((c) => c.id === cycle.id)!.status).toBe(
      'ARRIVED_UAE',
    );
  });

  it('Cycle → ARRIVED_EGYPT with the last leg partly arrived → allowed', async () => {
    const { cycle, item, leg1, leg2 } = twoLegs('IN_TRANSIT_TO_EGYPT');
    await deliver(leg1, item, 30, '2026-09-08');
    departLeg2(leg2);
    const early = await refusal(
      cycles.planTransition(cycle.id, 'ARRIVED_EGYPT'),
    );
    expect(early.code).toBe('LEG_NOT_ARRIVED');

    await deliver(leg2, item, 12, '2026-09-20');
    expect(legRow(leg2.id).status).toBe('PARTLY_ARRIVED');
    // L3: the partial delivery walks the cycle there, through this same gate.
    expect(db.cycles.find((c) => c.id === cycle.id)!.status).toBe(
      'ARRIVED_EGYPT',
    );
  });

  // I3: the cycle page's Change status offers the fix for exactly the leg
  // named, so the refusal carries its id beside the readable route.
  it('LEG_NOT_DEPARTED and LEG_NOT_ARRIVED name the leg by id as well as by route', async () => {
    const { cycle, items } = cycleWithOrder(db, {
      status: 'PURCHASING',
      originType: 'CHINA',
    });
    const leg1 = addLeg(db, cycle, 1, { departedOn: null });
    addLeg(db, cycle, 2, { departedOn: null });
    const notLeft = await refusal(
      cycles.planTransition(cycle.id, 'IN_TRANSIT'),
    );
    expect(notLeft.code).toBe('LEG_NOT_DEPARTED');
    expect(notLeft.params).toEqual({
      leg: 'Guangzhou, CN → Dubai, UAE',
      legId: leg1.id,
    });

    legRow(leg1.id).departedOn = new Date('2026-09-01T00:00:00Z');
    legRow(leg1.id).status = 'IN_TRANSIT';
    cycle.status = 'IN_TRANSIT';
    const notArrived = await refusal(
      cycles.planTransition(cycle.id, 'ARRIVED_UAE'),
    );
    expect(notArrived.code).toBe('LEG_NOT_ARRIVED');
    expect(notArrived.params).toEqual({
      leg: 'Guangzhou, CN → Dubai, UAE',
      legId: leg1.id,
    });
    expect(items).toHaveLength(1);
  });

  it('A delivery on a leg that has not left names the leg by id too', async () => {
    const { cycle, items } = cycleWithOrder(db, { status: 'PURCHASING' });
    const leg = addLeg(db, cycle, 1, { departedOn: null });
    const r = await refusal(deliver(leg, items[0], 5));
    expect(r.params).toEqual({
      leg: 'Dubai, UAE → Cairo, Egypt',
      legId: leg.id,
    });
  });

  it("A UAE-direct cycle reaches Egypt on its one leg's first delivery", async () => {
    const { cycle, item, leg } = oneLeg('IN_TRANSIT');
    expect(
      (await refusal(cycles.planTransition(cycle.id, 'ARRIVED_EGYPT'))).code,
    ).toBe('LEG_NOT_ARRIVED');
    await deliver(leg, item, 1);
    await cycles.planTransition(cycle.id, 'ARRIVED_EGYPT');
  });
});

// ─── Roles (CLAUDE.md rule 12) ───────────────────────────────────────────

describe('roles', () => {
  const handlers = [
    'recordDelivery',
    'deleteDelivery',
    'recordLoss',
    'takeBackLoss',
    // Correcting a leg's cost re-costs every sale of the cycle (§2, 2026-10-17).
    'updateLeg',
  ] as const;

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

  it('Investor or shop token on each endpoint, including DELETE /shipping/losses/:id → refused with a code', () => {
    const guard = new RolesGuard(new Reflector());
    for (const handler of handlers) {
      for (const role of [
        'TEMP_INVESTOR',
        'ADMIN_SUPPORT',
        'SHOP_OWNER_PORTAL',
      ]) {
        let thrown: HttpException | undefined;
        try {
          guard.canActivate(contextFor(handler, role));
        } catch (e) {
          thrown = e as HttpException;
        }
        expect({ handler, role, status: thrown?.getStatus() }).toEqual({
          handler,
          role,
          status: 403,
        });
        expect(thrown?.getResponse()).toEqual(
          expect.objectContaining({ code: 'ROLE_NOT_ALLOWED' }),
        );
      }
    }
  });

  it('Deleting a delivery as an investor → refused (and a core partner still gets through on every endpoint)', () => {
    const guard = new RolesGuard(new Reflector());
    expect(() =>
      guard.canActivate(contextFor('deleteDelivery', 'TEMP_INVESTOR')),
    ).toThrow(HttpException);
    for (const handler of handlers) {
      expect(guard.canActivate(contextFor(handler, 'CORE_PARTNER'))).toBe(true);
    }
  });
});

// ─── The one arithmetic ──────────────────────────────────────────────────

it('the guards read shipmentPosition, so their numbers are its numbers', async () => {
  const { cycle, item, leg1, leg2 } = twoLegs();
  await deliver(leg1, item, 30, '2026-09-08');
  departLeg2(leg2);
  await lose(leg1, item, 4);
  await deliver(leg2, item, 10, '2026-09-20');
  const loaded = (await loadShipment(fakePrisma(db), cycle.id))!;
  const direct = shipmentPosition({
    lines: [{ id: item.id, orderedQty: 40 }],
    legs: [leg1, leg2].map((l) => ({
      id: l.id,
      sequence: l.sequence,
      departedOn: l.departedOn,
    })),
    departures: db.departures as never,
    deliveries: db.deliveries as never,
    losses: db.losses as never,
    batches: [],
  });
  expect(loaded.position.legs.map((l) => l.onTheWay)).toEqual(
    direct.legs.map((l) => l.onTheWay),
  );
  expect(direct.legs.map((l) => l.onTheWay)).toEqual([6, 20]);
});
