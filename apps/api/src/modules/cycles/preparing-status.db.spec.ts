import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { CostingService } from '../costing/costing.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { CyclesService } from './cycles.service';

/**
 * Preparing (BUSINESS_LOGIC §1, owner 2026-10-27): "a new status its where the
 * website or factory prepares your order, then next its in transit to uae".
 *
 * Against a real Postgres, because the status is a new enum value and the
 * migration that adds it is part of what is being tested. Every transition
 * into and out of Preparing, by hand and by the shipment walk (L3); the
 * illegal jumps; a cycle with no order, with two orders one still a draft; a
 * departure undone; goods leaving in parts (L8); a cancelled cycle; and each
 * done twice.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a throwaway database with
 * the migrations applied — never the dev database (CLAUDE.md rule 6).
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
const ACTOR = randomUUID();

suite('the Preparing cycle status, against Postgres', () => {
  let prisma: PrismaClient;
  let cycles: CyclesService;
  let deliveries: DeliveriesService;
  let audit: { log: jest.Mock };

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    audit = { log: jest.fn() };
    const a = audit as unknown as AuditService;
    const notifications = {
      createForMultipleUsers: jest.fn(),
    } as unknown as NotificationsService;
    cycles = new CyclesService(db, a, notifications);
    deliveries = new DeliveriesService(
      db,
      a,
      notifications,
      new CostingService(db),
      cycles,
    );
  });
  beforeEach(() => audit.log.mockClear());
  afterAll(() => prisma.$disconnect());

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      const body = e.getResponse() as {
        code: string;
        params?: Record<string, unknown>;
      };
      return { code: body.code, params: body.params };
    }
    throw new Error('expected a refusal');
  }

  const statusOf = async (id: string) =>
    (await prisma.importCycle.findUniqueOrThrow({ where: { id } })).status;
  const orderStatuses = async (cycleId: string) =>
    (
      await prisma.purchaseOrder.findMany({
        where: { cycleId },
        orderBy: { reference: 'asc' },
      })
    ).map((o) => `${o.reference.split('-').pop()}:${o.status}`);
  const transitionsLogged = () =>
    audit.log.mock.calls.filter(
      ([e]) => (e as { action: string }).action === 'TRANSITION',
    ).length;

  /**
   * A cycle at `status` with its legs not yet departed, and the orders asked
   * for: each `[suffix, status, qty]` — qty 0 is an order with no lines.
   */
  async function cycleWith(
    status: string,
    originType: 'CHINA' | 'UAE_DIRECT',
    orders: [string, 'DRAFT' | 'CONFIRMED', number][] = [['A', 'DRAFT', 40]],
  ) {
    const tag = randomUUID().slice(0, 8);
    const supplier = await prisma.supplier.create({
      data: { name: `Prep ${tag}`, country: 'CN' },
    });
    const product = await prisma.product.create({
      data: { sku: `PREP-${tag}`, name: `Prep part ${tag}` },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `PREP-${tag}`,
        originType,
        currency: 'EGP',
        status: status as never,
      },
    });
    const items: { id: string }[] = [];
    for (const [suffix, poStatus, qty] of orders) {
      const po = await prisma.purchaseOrder.create({
        data: {
          cycleId: cycle.id,
          supplierId: supplier.id,
          reference: `PO-${tag}-${suffix}`,
          currency: 'EGP',
          fxRateToEgp: 1,
          orderedOn: new Date('2026-08-20T00:00:00Z'),
          status: poStatus,
        },
      });
      if (qty > 0) {
        items.push(
          await prisma.purchaseOrderItem.create({
            data: {
              purchaseOrderId: po.id,
              productId: product.id,
              orderedQty: qty,
              unitPrice: 100,
              lineTotal: qty * 100,
            },
          }),
        );
      }
    }
    const china = originType === 'CHINA';
    const leg1 = await prisma.shippingLeg.create({
      data: {
        cycleId: cycle.id,
        sequence: 1,
        origin: china ? 'Guangzhou, CN' : 'Dubai, UAE',
        destination: china ? 'Dubai, UAE' : 'Cairo, Egypt',
        status: 'PENDING',
        costBasis: 'FLAT',
        amount: 0,
        amountEgp: 0,
      },
    });
    const leg2 = china
      ? await prisma.shippingLeg.create({
          data: {
            cycleId: cycle.id,
            sequence: 2,
            origin: 'Dubai, UAE',
            destination: 'Cairo, Egypt',
            status: 'PENDING',
            costBasis: 'FLAT',
            amount: 0,
            amountEgp: 0,
          },
        })
      : null;
    return { cycle, items, leg1, leg2, tag };
  }

  const depart = (
    legId: string,
    lines?: { purchaseOrderItemId: string; qty: number }[],
    departedOn = '2026-09-01',
  ) => deliveries.recordDeparture(legId, { departedOn, lines }, ACTOR);

  // ─── By hand (Change status) ───────────────────────────────────────────

  describe('by hand', () => {
    it('Purchasing → Preparing confirms the draft order, once, with an audit row', async () => {
      const { cycle, tag } = await cycleWith('PURCHASING', 'CHINA');
      const plan = await cycles.planTransition(cycle.id, 'PREPARING');
      expect(plan.ordersToConfirm.map((o) => o.reference)).toEqual([
        `PO-${tag}-A`,
      ]);
      await cycles.transition(cycle.id, 'PREPARING', ACTOR);
      expect(await statusOf(cycle.id)).toBe('PREPARING');
      expect(await orderStatuses(cycle.id)).toEqual(['A:CONFIRMED']);
      expect(transitionsLogged()).toBe(1);
    });

    it('twice: the second Purchasing → Preparing is refused and changes nothing', async () => {
      const { cycle } = await cycleWith('PURCHASING', 'CHINA');
      await cycles.transition(cycle.id, 'PREPARING', ACTOR);
      const again = await refusal(
        cycles.transition(cycle.id, 'PREPARING', ACTOR, {
          expectedFrom: 'PURCHASING',
        }),
      );
      // The partner saw Purchasing; it is Preparing now.
      expect(again.code).toBe('CYCLE_STATUS_CHANGED');
      const same = await refusal(
        cycles.transition(cycle.id, 'PREPARING', ACTOR),
      );
      expect(same.code).toBe('BAD_STATUS_TRANSITION');
      expect(await statusOf(cycle.id)).toBe('PREPARING');
      expect(transitionsLogged()).toBe(1);
    });

    it('a cycle with no purchase order cannot be preparing anything → CYCLE_HAS_NO_ORDER', async () => {
      const { cycle } = await cycleWith('PURCHASING', 'UAE_DIRECT', []);
      const r = await refusal(cycles.transition(cycle.id, 'PREPARING', ACTOR));
      expect(r).toEqual({
        code: 'CYCLE_HAS_NO_ORDER',
        params: { cycle: cycle.code },
      });
      expect(await statusOf(cycle.id)).toBe('PURCHASING');
    });

    it('an order with no lines is no order either: alone → CYCLE_HAS_NO_ORDER; beside a real one → PO_HAS_NO_ITEMS, nothing confirmed', async () => {
      const alone = await cycleWith('PURCHASING', 'CHINA', [['A', 'DRAFT', 0]]);
      expect(
        (await refusal(cycles.transition(alone.cycle.id, 'PREPARING', ACTOR)))
          .code,
      ).toBe('CYCLE_HAS_NO_ORDER');

      const beside = await cycleWith('PURCHASING', 'CHINA', [
        ['A', 'DRAFT', 40],
        ['B', 'DRAFT', 0],
      ]);
      expect(
        (await refusal(cycles.transition(beside.cycle.id, 'PREPARING', ACTOR)))
          .code,
      ).toBe('PO_HAS_NO_ITEMS');
      expect(await orderStatuses(beside.cycle.id)).toEqual([
        'A:DRAFT',
        'B:DRAFT',
      ]);
      expect(await statusOf(beside.cycle.id)).toBe('PURCHASING');
    });

    it('two orders, one confirmed and one still a draft: Preparing confirms the draft and names only it', async () => {
      const { cycle, tag } = await cycleWith('PURCHASING', 'CHINA', [
        ['A', 'CONFIRMED', 10],
        ['B', 'DRAFT', 30],
      ]);
      const plan = await cycles.planTransition(cycle.id, 'PREPARING');
      expect(plan.ordersToConfirm.map((o) => o.reference)).toEqual([
        `PO-${tag}-B`,
      ]);
      await cycles.transition(cycle.id, 'PREPARING', ACTOR);
      expect(await orderStatuses(cycle.id)).toEqual([
        'A:CONFIRMED',
        'B:CONFIRMED',
      ]);
    });

    it('Preparing → Purchasing while nothing has left: allowed, the orders stay confirmed, and leaving again confirms only what was added', async () => {
      const { cycle, tag } = await cycleWith('PURCHASING', 'CHINA');
      await cycles.transition(cycle.id, 'PREPARING', ACTOR);
      await cycles.transition(cycle.id, 'PURCHASING', ACTOR);
      expect(await statusOf(cycle.id)).toBe('PURCHASING');
      // Never back to a draft: the order was placed.
      expect(await orderStatuses(cycle.id)).toEqual(['A:CONFIRMED']);

      // A forgotten order is recorded, and the cycle goes on again.
      const supplier = await prisma.supplier.findFirstOrThrow({
        where: { name: `Prep ${tag}` },
      });
      const late = await prisma.purchaseOrder.create({
        data: {
          cycleId: cycle.id,
          supplierId: supplier.id,
          reference: `PO-${tag}-B`,
          currency: 'EGP',
          fxRateToEgp: 1,
          orderedOn: new Date('2026-08-25T00:00:00Z'),
          status: 'DRAFT',
        },
      });
      const product = await prisma.product.findFirstOrThrow({
        where: { sku: `PREP-${tag}` },
      });
      await prisma.purchaseOrderItem.create({
        data: {
          purchaseOrderId: late.id,
          productId: product.id,
          orderedQty: 5,
          unitPrice: 100,
          lineTotal: 500,
        },
      });
      const plan = await cycles.planTransition(cycle.id, 'PREPARING');
      expect(plan.ordersToConfirm.map((o) => o.reference)).toEqual([
        `PO-${tag}-B`,
      ]);
      await cycles.transition(cycle.id, 'PREPARING', ACTOR);
      expect(await orderStatuses(cycle.id)).toEqual([
        'A:CONFIRMED',
        'B:CONFIRMED',
      ]);
    });

    it('Preparing → In transit by hand needs the departure → LEG_NOT_DEPARTED naming the leg', async () => {
      const { cycle, leg1 } = await cycleWith('PURCHASING', 'CHINA');
      await cycles.transition(cycle.id, 'PREPARING', ACTOR);
      const r = await refusal(cycles.transition(cycle.id, 'IN_TRANSIT', ACTOR));
      expect(r.code).toBe('LEG_NOT_DEPARTED');
      expect(r.params).toMatchObject({ legId: leg1.id });
      expect(await statusOf(cycle.id)).toBe('PREPARING');
    });

    it.each([
      ['PURCHASING', 'IN_TRANSIT'],
      ['PURCHASING', 'ARRIVED_UAE'],
      ['FUNDING', 'PREPARING'],
      ['PLANNING', 'PREPARING'],
      ['PREPARING', 'ARRIVED_EGYPT'],
      ['PREPARING', 'IN_TRANSIT_TO_EGYPT'],
      ['PREPARING', 'FUNDING'],
      ['IN_TRANSIT', 'PREPARING'],
      ['SELLING', 'PREPARING'],
      ['CLOSED', 'PREPARING'],
    ])(
      'an illegal jump %s → %s is refused, nothing changes',
      async (from, to) => {
        const { cycle } = await cycleWith(from, 'CHINA');
        const r = await refusal(cycles.transition(cycle.id, to, ACTOR));
        expect(r.code).toBe('BAD_STATUS_TRANSITION');
        expect(r.params).toMatchObject({ from, to });
        expect(await statusOf(cycle.id)).toBe(from);
        expect(await orderStatuses(cycle.id)).toEqual(['A:DRAFT']);
      },
    );

    it('a cancelled cycle: Preparing can be cancelled; nothing moves it after, nor records a departure on it', async () => {
      const { cycle, leg1 } = await cycleWith('PURCHASING', 'CHINA');
      await cycles.transition(cycle.id, 'PREPARING', ACTOR);
      await cycles.transition(cycle.id, 'CANCELLED', ACTOR);
      expect(await statusOf(cycle.id)).toBe('CANCELLED');
      for (const to of ['PREPARING', 'PURCHASING', 'IN_TRANSIT']) {
        expect(
          (await refusal(cycles.transition(cycle.id, to, ACTOR))).code,
        ).toBe('BAD_STATUS_TRANSITION');
      }
      expect((await refusal(depart(leg1.id))).code).toBe('CYCLE_CLOSED');
      expect(await statusOf(cycle.id)).toBe('CANCELLED');
    });

    it('Preparing → Purchasing once goods have left → CYCLE_HAS_DEPARTED', async () => {
      // How a Preparing cycle comes to hold a departure: one left while the
      // cycle was still being set up, the walk stopped at Purchasing on an
      // empty order (§1, L3), and the partner fixed that and moved it on.
      const { cycle, leg1, tag } = await cycleWith('PLANNING', 'CHINA', [
        ['A', 'DRAFT', 40],
        ['B', 'DRAFT', 0],
      ]);
      const r = await depart(leg1.id);
      expect(r.cycleStatus).toMatchObject({
        to: 'PURCHASING',
        stoppedAt: { status: 'PREPARING', code: 'PO_HAS_NO_ITEMS' },
      });
      await prisma.purchaseOrder.deleteMany({
        where: { reference: `PO-${tag}-B` },
      });
      await cycles.transition(cycle.id, 'PREPARING', ACTOR);

      const back = await refusal(
        cycles.transition(cycle.id, 'PURCHASING', ACTOR),
      );
      expect(back).toEqual({
        code: 'CYCLE_HAS_DEPARTED',
        params: { cycle: cycle.code },
      });
      expect(await statusOf(cycle.id)).toBe('PREPARING');
      // And on by hand, now that the departure is there.
      await cycles.transition(cycle.id, 'IN_TRANSIT', ACTOR);
      expect(await statusOf(cycle.id)).toBe('IN_TRANSIT');
    });
  });

  // ─── By itself (the shipment walk, L3) ─────────────────────────────────

  describe('by itself', () => {
    it('China: the first departure from Purchasing walks Preparing → In transit and confirms the order there', async () => {
      const { cycle, tag, leg1 } = await cycleWith('PURCHASING', 'CHINA');
      const r = await depart(leg1.id);
      expect(r.cycleStatus).toMatchObject({
        from: 'PURCHASING',
        to: 'IN_TRANSIT',
        steps: ['PREPARING', 'IN_TRANSIT'],
        stoppedAt: null,
        ordersConfirmed: [`PO-${tag}-A`],
      });
      expect(await statusOf(cycle.id)).toBe('IN_TRANSIT');
      expect(await orderStatuses(cycle.id)).toEqual(['A:CONFIRMED']);
      expect(transitionsLogged()).toBe(2);
    });

    it('UAE direct: the departure walks Preparing → Arrived UAE → In transit to Egypt', async () => {
      const { cycle, leg1 } = await cycleWith('PURCHASING', 'UAE_DIRECT');
      const r = await depart(leg1.id);
      expect(r.cycleStatus).toMatchObject({
        to: 'IN_TRANSIT_TO_EGYPT',
        steps: ['PREPARING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT'],
      });
      expect(await statusOf(cycle.id)).toBe('IN_TRANSIT_TO_EGYPT');
    });

    it('from Preparing the first departure moves the cycle to In transit, confirming nothing more', async () => {
      const { cycle, leg1 } = await cycleWith('PURCHASING', 'CHINA');
      await cycles.transition(cycle.id, 'PREPARING', ACTOR);
      const r = await depart(leg1.id);
      expect(r.cycleStatus).toMatchObject({
        from: 'PREPARING',
        to: 'IN_TRANSIT',
        steps: ['IN_TRANSIT'],
        ordersConfirmed: [],
      });
    });

    it('goods leaving in parts (L8): the first part moves the cycle, the second moves nothing', async () => {
      const { cycle, items, leg1 } = await cycleWith('PREPARING', 'CHINA', [
        ['A', 'CONFIRMED', 40],
      ]);
      const first = await depart(leg1.id, [
        { purchaseOrderItemId: items[0].id, qty: 15 },
      ]);
      expect(first.cycleStatus).toMatchObject({ to: 'IN_TRANSIT' });
      const second = await depart(
        leg1.id,
        [{ purchaseOrderItemId: items[0].id, qty: 25 }],
        '2026-09-05',
      );
      expect(second.cycleStatus).toBeNull();
      expect(await statusOf(cycle.id)).toBe('IN_TRANSIT');
      expect(transitionsLogged()).toBe(1);
    });
  });

  // ─── A departure undone ────────────────────────────────────────────────

  describe('a departure undone', () => {
    it('the last departure: the cycle goes back to Preparing — never Purchasing — and the order stays confirmed', async () => {
      const { cycle, leg1 } = await cycleWith('PURCHASING', 'CHINA');
      const { data } = await depart(leg1.id);
      expect(await statusOf(cycle.id)).toBe('IN_TRANSIT');

      // The cycle page says so before the click.
      const shipment = (await cycles.getShipment(cycle.id)).data;
      const offered = shipment.legs[0].departures[0];
      expect(offered).toMatchObject({
        undoable: true,
        undoReturnsTo: 'PREPARING',
      });

      audit.log.mockClear();
      const r = await deliveries.deleteDeparture(data.id, ACTOR);
      expect(r.cycleStatus).toMatchObject({
        from: 'IN_TRANSIT',
        to: 'PREPARING',
        moved: true,
      });
      expect(await statusOf(cycle.id)).toBe('PREPARING');
      expect(await orderStatuses(cycle.id)).toEqual(['A:CONFIRMED']);
      expect(transitionsLogged()).toBe(1);
      const leg = await prisma.shippingLeg.findUniqueOrThrow({
        where: { id: leg1.id },
      });
      expect(leg.status).toBe('PENDING');
      expect(leg.departedOn).toBeNull();
    });

    it('twice: undone again → 404; recorded again → In transit again', async () => {
      const { cycle, leg1 } = await cycleWith('PURCHASING', 'CHINA');
      const { data } = await depart(leg1.id);
      await deliveries.deleteDeparture(data.id, ACTOR);
      const again = await refusal(deliveries.deleteDeparture(data.id, ACTOR));
      expect(again.code).toBe('NOT_FOUND');
      expect(await statusOf(cycle.id)).toBe('PREPARING');

      const redo = await depart(leg1.id);
      expect(redo.cycleStatus).toMatchObject({
        from: 'PREPARING',
        to: 'IN_TRANSIT',
        steps: ['IN_TRANSIT'],
      });
    });

    it('UAE direct: undoing its one departure returns In transit to Egypt to Preparing', async () => {
      const { cycle, leg1 } = await cycleWith('PURCHASING', 'UAE_DIRECT');
      const { data } = await depart(leg1.id);
      const r = await deliveries.deleteDeparture(data.id, ACTOR);
      expect(r.cycleStatus).toMatchObject({
        from: 'IN_TRANSIT_TO_EGYPT',
        to: 'PREPARING',
      });
      expect(await statusOf(cycle.id)).toBe('PREPARING');
    });

    it('in parts: undoing a later part moves nothing; undoing the last one left returns to Preparing', async () => {
      const { cycle, items, leg1 } = await cycleWith('PREPARING', 'CHINA', [
        ['A', 'CONFIRMED', 40],
      ]);
      const first = await depart(leg1.id, [
        { purchaseOrderItemId: items[0].id, qty: 15 },
      ]);
      const second = await depart(
        leg1.id,
        [{ purchaseOrderItemId: items[0].id, qty: 25 }],
        '2026-09-05',
      );
      const shipment = (await cycles.getShipment(cycle.id)).data;
      expect(shipment.legs[0].departures.map((d) => d.undoReturnsTo)).toEqual([
        null,
        null,
      ]);

      const r1 = await deliveries.deleteDeparture(second.data.id, ACTOR);
      expect(r1.cycleStatus).toBeNull();
      expect(await statusOf(cycle.id)).toBe('IN_TRANSIT');

      const r2 = await deliveries.deleteDeparture(first.data.id, ACTOR);
      expect(r2.cycleStatus).toMatchObject({ to: 'PREPARING' });
      expect(await statusOf(cycle.id)).toBe('PREPARING');
    });

    it('a departure whose goods arrived cannot be undone, and the cycle stays where it is', async () => {
      const { cycle, items, leg1 } = await cycleWith('PURCHASING', 'CHINA');
      const { data } = await depart(leg1.id);
      await deliveries.recordDelivery(
        leg1.id,
        {
          arrivedOn: '2026-09-10',
          lines: [{ purchaseOrderItemId: items[0].id, qty: 40 }],
        },
        ACTOR,
      );
      expect(await statusOf(cycle.id)).toBe('ARRIVED_UAE');
      const r = await refusal(deliveries.deleteDeparture(data.id, ACTOR));
      expect(r).toEqual({ code: 'DEPARTURE_IN_USE', params: { why: 'used' } });
      expect(await statusOf(cycle.id)).toBe('ARRIVED_UAE');
    });

    it('an old leg that delivered with no departure (B1) counts as left: the second leg’s only departure is refused, never back to Preparing', async () => {
      // Before L8 a leg could be backfilled with deliveries and no departure
      // date; its delivered goods read as left. The whole shipment then holds
      // one departure — leg 2's — and still something has left.
      const { cycle, items, leg1, leg2 } = await cycleWith(
        'ARRIVED_UAE',
        'CHINA',
        [['A', 'CONFIRMED', 40]],
      );
      await prisma.shipmentDelivery.create({
        data: {
          legId: leg1.id,
          arrivedOn: new Date('2026-09-10T00:00:00Z'),
          lines: { create: [{ purchaseOrderItemId: items[0].id, qty: 40 }] },
        },
      });
      const { data } = await depart(leg2!.id, undefined, '2026-09-12');
      expect(await statusOf(cycle.id)).toBe('IN_TRANSIT_TO_EGYPT');
      const shipment = (await cycles.getShipment(cycle.id)).data;
      expect(shipment.legs[1].departures[0].undoReturnsTo).toBeNull();
      const r = await refusal(deliveries.deleteDeparture(data.id, ACTOR));
      expect(r).toEqual({
        code: 'DEPARTURE_IN_USE',
        params: { why: 'status' },
      });
      expect(await statusOf(cycle.id)).toBe('IN_TRANSIT_TO_EGYPT');
    });

    it('the second leg’s only departure is still refused (status): Preparing is only for nothing having left at all', async () => {
      const { cycle, items, leg1, leg2 } = await cycleWith(
        'PURCHASING',
        'CHINA',
      );
      await depart(leg1.id);
      await deliveries.recordDelivery(
        leg1.id,
        {
          arrivedOn: '2026-09-10',
          lines: [{ purchaseOrderItemId: items[0].id, qty: 40 }],
        },
        ACTOR,
      );
      const { data } = await depart(leg2!.id, undefined, '2026-09-12');
      expect(await statusOf(cycle.id)).toBe('IN_TRANSIT_TO_EGYPT');
      const r = await refusal(deliveries.deleteDeparture(data.id, ACTOR));
      expect(r).toEqual({
        code: 'DEPARTURE_IN_USE',
        params: { why: 'status' },
      });
      expect(await statusOf(cycle.id)).toBe('IN_TRANSIT_TO_EGYPT');
    });
  });
});
