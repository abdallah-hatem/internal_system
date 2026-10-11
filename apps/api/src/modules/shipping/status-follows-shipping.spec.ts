/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- the fake database's rows are untyped records, as Prisma's argument objects are */
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import {
  statusProvenByShipment,
  stepsToward,
} from '../../common/status-follows-shipping';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { DeliveriesService } from './deliveries.service';
import { ShippingService } from './shipping.service';
import {
  addLeg,
  cycleWithOrder,
  emptyStore,
  fakePrisma,
  type Row,
  type Store,
} from './shipment-fake-spec';

/**
 * L3 — a cycle's status follows its shipment (BUSINESS_LOGIC §1, owner
 * 2026-10-11). Recording a departure or a delivery moves the cycle forward to
 * the furthest status the shipment proves, through each step's own checks;
 * never back, never past a step that refuses, never a cycle being settled,
 * closed or cancelled. The services and the transition checks are the real
 * ones; the database is B2's in-memory fake, which rolls a failed transaction
 * back. e2e: apps/web/tests/95-status-follows-shipping.spec.ts.
 */

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
let audit: { log: jest.Mock };
let notifications: { createForMultipleUsers: jest.Mock };

beforeEach(() => {
  db = emptyStore();
  const prisma = fakePrisma(db);
  audit = { log: jest.fn() };
  notifications = { createForMultipleUsers: jest.fn() };
  const a = audit as unknown as AuditService;
  const n = notifications as unknown as NotificationsService;
  const costing = new CostingService(prisma);
  const cycles = new CyclesService(prisma, a, n);
  deliveries = new DeliveriesService(prisma, a, n, costing, cycles);
  shipping = new ShippingService(prisma, a, costing, deliveries);
});

const ACTOR = randomUUID();

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    const body = e.getResponse() as Record<string, any>;
    return { code: body.code as string };
  }
  throw new Error('expected a refusal');
}

const statusOf = (cycle: Row) =>
  db.cycles.find((c) => c.id === cycle.id)!.status as string;
const transitionsLogged = () =>
  audit.log.mock.calls.filter(([e]) => e.action === 'TRANSITION').length;
const statusNotices = () =>
  notifications.createForMultipleUsers.mock.calls.filter(
    ([, n]) => n.eventType === 'CYCLE_STATUS_CHANGED',
  ).length;

const deliver = (leg: Row, item: Row, qty: number, arrivedOn = '2026-09-20') =>
  deliveries.recordDelivery(
    leg.id,
    { arrivedOn, lines: [{ purchaseOrderItemId: item.id, qty }] },
    ACTOR,
  );
const depart = (leg: Row, departedOn = '2026-09-01') =>
  shipping.updateLeg(leg.id, { departedOn }, ACTOR);

/** A cycle with one draft order of 40 brake pads and a participant to tell. */
function cycle(status: string, originType: 'CHINA' | 'UAE_DIRECT') {
  const made = cycleWithOrder(db, { status, originType });
  const po: Row = made.po;
  po.status = 'DRAFT';
  db.participants.push({
    id: randomUUID(),
    cycleId: made.cycle.id,
    partnerUserId: randomUUID(),
  });
  return { ...made, po, item: made.items[0] };
}

// ─── What the shipment proves (pure) ─────────────────────────────────────

describe('statusProvenByShipment / stepsToward', () => {
  const leg = (sequence: number, departed: boolean, deliveries = 0) => ({
    sequence,
    departedOn: departed ? '2026-09-01' : null,
    deliveries,
  });

  it('China: each record proves its own step', () => {
    expect(statusProvenByShipment('CHINA', [])).toBeNull();
    expect(statusProvenByShipment('CHINA', [leg(1, false)])).toBeNull();
    expect(statusProvenByShipment('CHINA', [leg(1, true)])).toBe('IN_TRANSIT');
    expect(statusProvenByShipment('CHINA', [leg(1, true, 1)])).toBe(
      'ARRIVED_UAE',
    );
    expect(
      statusProvenByShipment('CHINA', [leg(1, true, 1), leg(2, true)]),
    ).toBe('IN_TRANSIT_TO_EGYPT');
    expect(
      statusProvenByShipment('CHINA', [leg(1, true, 1), leg(2, true, 2)]),
    ).toBe('ARRIVED_EGYPT');
  });

  it('China with no second leg recorded proves nothing past Arrived UAE', () => {
    // The transition gates let a missing leg 2 through; the walk must not.
    expect(statusProvenByShipment('CHINA', [leg(1, true, 3)])).toBe(
      'ARRIVED_UAE',
    );
  });

  it('UAE direct: the one leg leaving proves In transit to Egypt', () => {
    expect(statusProvenByShipment('UAE_DIRECT', [leg(1, false)])).toBeNull();
    expect(statusProvenByShipment('UAE_DIRECT', [leg(1, true)])).toBe(
      'IN_TRANSIT_TO_EGYPT',
    );
    expect(statusProvenByShipment('UAE_DIRECT', [leg(1, true, 1)])).toBe(
      'ARRIVED_EGYPT',
    );
  });

  it('steps go forward only, and never from off the way to Egypt', () => {
    expect(
      stepsToward('UAE_DIRECT', 'PURCHASING', 'IN_TRANSIT_TO_EGYPT'),
    ).toEqual(['ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT']);
    expect(stepsToward('CHINA', 'PLANNING', 'IN_TRANSIT')).toEqual([
      'FUNDING',
      'PURCHASING',
      'IN_TRANSIT',
    ]);
    expect(stepsToward('CHINA', 'ARRIVED_EGYPT', 'IN_TRANSIT')).toEqual([]);
    expect(stepsToward('CHINA', 'ARRIVED_UAE', 'ARRIVED_UAE')).toEqual([]);
    expect(stepsToward('CHINA', 'IN_TRANSIT', null)).toEqual([]);
    for (const off of [
      'VERIFICATION',
      'SELLING',
      'SETTLEMENT',
      'CLOSED',
      'CANCELLED',
    ]) {
      expect(stepsToward('CHINA', off, 'ARRIVED_EGYPT')).toEqual([]);
      expect(stepsToward('UAE_DIRECT', off, 'ARRIVED_EGYPT')).toEqual([]);
    }
  });
});

// ─── The walk, through the services ──────────────────────────────────────

describe('China: every record moves the cycle one step on', () => {
  it('departure → In transit (orders confirmed), delivery → Arrived UAE, leg 2 departed → In transit to Egypt, delivery → Arrived Egypt', async () => {
    const { cycle: c, item, po } = cycle('PURCHASING', 'CHINA');
    const leg1 = addLeg(db, c, 1, { departedOn: null });

    const r1 = await depart(leg1);
    expect(statusOf(c)).toBe('IN_TRANSIT');
    expect(po.status).toBe('CONFIRMED');
    expect(r1.cycleStatus).toMatchObject({
      from: 'PURCHASING',
      to: 'IN_TRANSIT',
      moved: true,
      steps: ['IN_TRANSIT'],
      stoppedAt: null,
      ordersConfirmed: [po.reference],
    });

    const r2 = await deliver(leg1, item, 40, '2026-09-08');
    expect(statusOf(c)).toBe('ARRIVED_UAE');
    expect(r2.cycleStatus).toMatchObject({
      from: 'IN_TRANSIT',
      to: 'ARRIVED_UAE',
    });

    const r3 = await shipping.createLeg(
      c.id,
      { sequence: 2, departedOn: '2026-09-10', costBasis: 'FLAT', amount: 300 },
      ACTOR,
    );
    expect(statusOf(c)).toBe('IN_TRANSIT_TO_EGYPT');
    expect(r3.cycleStatus).toMatchObject({ to: 'IN_TRANSIT_TO_EGYPT' });

    const leg2 = db.legs.find((l) => l.cycleId === c.id && l.sequence === 2)!;
    const r4 = await deliver(leg2, item, 40, '2026-09-25');
    expect(statusOf(c)).toBe('ARRIVED_EGYPT');
    expect(r4.cycleStatus).toMatchObject({
      from: 'IN_TRANSIT_TO_EGYPT',
      to: 'ARRIVED_EGYPT',
    });
    // One audit row and one notice per step, after each commit.
    expect(transitionsLogged()).toBe(4);
    expect(statusNotices()).toBe(4);
  });

  it('leg 1 delivered with no second leg recorded stops at Arrived UAE', async () => {
    const { cycle: c, item } = cycle('IN_TRANSIT', 'CHINA');
    const leg1 = addLeg(db, c, 1, { departedOn: '2026-09-01' });
    await deliver(leg1, item, 40, '2026-09-08');
    expect(statusOf(c)).toBe('ARRIVED_UAE');
  });
});

describe('UAE direct', () => {
  it('the departure → In transit to Egypt through Arrived UAE; a delivery → Arrived Egypt', async () => {
    const { cycle: c, item, po } = cycle('PURCHASING', 'UAE_DIRECT');
    const leg = addLeg(db, c, 1, { departedOn: null });

    const r1 = await depart(leg);
    expect(r1.cycleStatus).toMatchObject({
      from: 'PURCHASING',
      to: 'IN_TRANSIT_TO_EGYPT',
      steps: ['ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT'],
      ordersConfirmed: [po.reference],
    });
    expect(po.status).toBe('CONFIRMED');

    const r2 = await deliver(leg, item, 15);
    expect(statusOf(c)).toBe('ARRIVED_EGYPT');
    expect(r2.cycleStatus).toMatchObject({
      to: 'ARRIVED_EGYPT',
      steps: ['ARRIVED_EGYPT'],
    });
  });

  it('a leg created with both dates walks all the way to Arrived Egypt', async () => {
    const { cycle: c } = cycle('PURCHASING', 'UAE_DIRECT');
    const r = await shipping.createLeg(
      c.id,
      {
        sequence: 1,
        departedOn: '2026-09-01',
        arrivedOn: '2026-09-15',
        costBasis: 'FLAT',
        amount: 0,
      },
      ACTOR,
    );
    expect(statusOf(c)).toBe('ARRIVED_EGYPT');
    expect(r.cycleStatus).toMatchObject({
      steps: ['ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT'],
    });
  });
});

describe('the limits', () => {
  it('a partial delivery (15 of 40) advances the cycle', async () => {
    const { cycle: c, item } = cycle('IN_TRANSIT_TO_EGYPT', 'UAE_DIRECT');
    const leg = addLeg(db, c, 1, { departedOn: '2026-09-01' });
    await deliver(leg, item, 15);
    expect(statusOf(c)).toBe('ARRIVED_EGYPT');
  });

  it('a delivery dated before the departure is still refused, and nothing moves', async () => {
    const { cycle: c, item } = cycle('IN_TRANSIT_TO_EGYPT', 'UAE_DIRECT');
    const leg = addLeg(db, c, 1, { departedOn: '2026-09-10' });
    const r = await refusal(deliver(leg, item, 15, '2026-09-05'));
    expect(r.code).toBe('DELIVERY_BEFORE_DEPARTURE');
    expect(statusOf(c)).toBe('IN_TRANSIT_TO_EGYPT');
    expect(transitionsLogged()).toBe(0);
    expect(statusNotices()).toBe(0);
  });

  it('a delivery on a leg that never left is refused, and nothing moves', async () => {
    const { cycle: c, item } = cycle('PURCHASING', 'UAE_DIRECT');
    const leg = addLeg(db, c, 1, { departedOn: null });
    const r = await refusal(deliver(leg, item, 15));
    expect(r.code).toBe('LEG_NOT_DEPARTED');
    expect(statusOf(c)).toBe('PURCHASING');
  });
});

describe('the second time', () => {
  it('a second delivery on the same leg does not transition again or confirm anything twice', async () => {
    const { cycle: c, item, po } = cycle('PURCHASING', 'UAE_DIRECT');
    const leg = addLeg(db, c, 1, { departedOn: null });
    await depart(leg);
    await deliver(leg, item, 15, '2026-09-10');
    const logged = transitionsLogged();
    const confirmedOnce = po.status;

    const again = await deliver(leg, item, 10, '2026-09-20');
    expect(statusOf(c)).toBe('ARRIVED_EGYPT');
    expect(again.cycleStatus).toMatchObject({
      moved: false,
      steps: [],
      ordersConfirmed: [],
    });
    expect(transitionsLogged()).toBe(logged);
    expect(confirmedOnce).toBe('CONFIRMED');
  });

  it('re-sending the departure a leg already has is no news: the cycle stays where it is', async () => {
    // A leg departed before L3, on a cycle a partner kept in PURCHASING. The
    // Shipments page's edit form sends the departure back on every save.
    const { cycle: c } = cycle('PURCHASING', 'UAE_DIRECT');
    const leg = addLeg(db, c, 1, { departedOn: '2026-09-01' });
    const r = await shipping.updateLeg(
      leg.id,
      { departedOn: '2026-09-01', trackingRef: 'TRK-1' },
      ACTOR,
    );
    expect(r.cycleStatus).toBeNull();
    expect(statusOf(c)).toBe('PURCHASING');
  });
});

describe('never backward, never a finished cycle', () => {
  it.each(['VERIFICATION', 'SELLING'])(
    'a delivery on a cycle already %s leaves it there',
    async (status) => {
      const { cycle: c, item } = cycle(status, 'UAE_DIRECT');
      const leg = addLeg(db, c, 1, { departedOn: '2026-09-01' });
      const r = await deliver(leg, item, 10);
      expect(statusOf(c)).toBe(status);
      expect(r.cycleStatus).toMatchObject({ moved: false, to: status });
    },
  );

  it('a China cycle in Arrived Egypt is not moved back by a late leg-1 delivery', async () => {
    const { cycle: c, item } = cycle('ARRIVED_EGYPT', 'CHINA');
    const leg1 = addLeg(db, c, 1, { departedOn: '2026-09-01' });
    await deliver(leg1, item, 20, '2026-09-05');
    expect(statusOf(c)).toBe('ARRIVED_EGYPT');
  });

  it('a leg added departed to a cycle in settlement leaves it in settlement', async () => {
    const { cycle: c } = cycle('SETTLEMENT', 'UAE_DIRECT');
    const r = await shipping.createLeg(
      c.id,
      { sequence: 1, departedOn: '2026-09-01', costBasis: 'FLAT', amount: 0 },
      ACTOR,
    );
    expect(statusOf(c)).toBe('SETTLEMENT');
    expect(r.cycleStatus).toMatchObject({ moved: false });
    expect(transitionsLogged()).toBe(0);
  });

  it.each([
    ['SETTLEMENT', 'CYCLE_SETTLING'],
    ['CLOSED', 'CYCLE_SETTLING'],
    ['CANCELLED', 'CYCLE_CLOSED'],
  ])(
    'a departure on a cycle %s is refused and the status stays',
    async (status, code) => {
      const { cycle: c } = cycle(status, 'UAE_DIRECT');
      const leg = addLeg(db, c, 1, { departedOn: null });
      const r = await refusal(depart(leg));
      expect(r.code).toBe(code);
      expect(statusOf(c)).toBe(status);
    },
  );
});

describe('a cycle still being set up', () => {
  it('PLANNING + a departure walks Funding → Purchasing → In transit, confirming the draft once', async () => {
    const { cycle: c, po } = cycle('PLANNING', 'CHINA');
    const leg1 = addLeg(db, c, 1, { departedOn: null });
    const r = await depart(leg1);
    expect(statusOf(c)).toBe('IN_TRANSIT');
    expect(r.cycleStatus).toMatchObject({
      from: 'PLANNING',
      steps: ['FUNDING', 'PURCHASING', 'IN_TRANSIT'],
      ordersConfirmed: [po.reference],
    });
    expect(po.status).toBe('CONFIRMED');
    expect(transitionsLogged()).toBe(3);
  });

  it('a step whose own check refuses stops the walk there, and the departure still saves', async () => {
    const { cycle: c } = cycle('PLANNING', 'UAE_DIRECT');
    // An order with no lines cannot leave PURCHASING (§15, PO_HAS_NO_ITEMS).
    db.orders.push({
      id: randomUUID(),
      cycleId: c.id,
      supplierId: db.suppliers[0].id,
      reference: 'PO-EMPTY',
      status: 'DRAFT',
    });
    const leg = addLeg(db, c, 1, { departedOn: null });
    const r = await depart(leg);

    expect(statusOf(c)).toBe('PURCHASING');
    expect(r.cycleStatus).toMatchObject({
      from: 'PLANNING',
      to: 'PURCHASING',
      steps: ['FUNDING', 'PURCHASING'],
      stoppedAt: { status: 'ARRIVED_UAE', code: 'PO_HAS_NO_ITEMS' },
      ordersConfirmed: [],
    });
    expect(db.legs.find((l) => l.id === leg.id)!.departedOn).toEqual(
      new Date('2026-09-01'),
    );
    expect(
      db.orders.every((o) => o.cycleId !== c.id || o.status === 'DRAFT'),
    ).toBe(true);
  });
});
