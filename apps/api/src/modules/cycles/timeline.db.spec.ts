import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { instantOfDay, startOfBusinessDay } from '../../common/dates';
import type { TimelineStep } from '../../common/cycle-timeline';
import { CyclesService } from './cycles.service';

/**
 * GET /cycles/:id/timeline (BUSINESS_LOGIC §1, owner 2026-11-10), against a
 * real Postgres: the rows it reads are the ones the shipment, receipts and the
 * status-history trigger write, and the trigger is part of what is tested.
 *
 * A China cycle in two legs with Egypt's deliveries in two batches and two
 * receipts; a cycle with only an order; legs entered out of order; a delivery
 * dated before its departure; stock moved in from another cycle (not a
 * receipt); a draft order (not placed); an unknown cycle and a malformed id.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a throwaway database with
 * the migrations applied — never the dev database (CLAUDE.md rule 6).
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('the cycle timeline, against Postgres', () => {
  let prisma: PrismaClient;
  let cycles: CyclesService;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const notifications = {
      createForMultipleUsers: jest.fn(),
    } as unknown as NotificationsService;
    cycles = new CyclesService(db, audit, notifications);
  });
  afterAll(() => prisma.$disconnect());

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      const body = e.getResponse() as { code: string };
      return { status: e.getStatus(), code: body.code };
    }
    throw new Error('expected a refusal');
  }

  const day = (d: string) => new Date(`${d}T00:00:00Z`);
  const timeline = async (id: string) => (await cycles.getTimeline(id)).data;
  const step = (steps: TimelineStep[], key: string) => {
    const s = steps.find((x) => x.key === key);
    if (!s)
      throw new Error(`no ${key} in ${steps.map((x) => x.key).join(', ')}`);
    return s;
  };
  const since = (steps: TimelineStep[], key: string) => {
    const s = step(steps, key).since;
    return s ? `${s.days} ${s.measure}` : null;
  };

  /** A cycle with one product ordered (100 units) on `orderedOn`. */
  async function cycleWith(opts: {
    originType?: 'CHINA' | 'UAE_DIRECT';
    status?: string;
    orderedOn?: string;
    poStatus?: 'DRAFT' | 'CONFIRMED';
  }) {
    const tag = randomUUID().slice(0, 8);
    const supplier = await prisma.supplier.create({
      data: { name: `Timeline ${tag}`, country: 'CN' },
    });
    const product = await prisma.product.create({
      data: { sku: `TL-${tag}`, name: `Timeline part ${tag}` },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `TL-${tag}`,
        originType: opts.originType ?? 'CHINA',
        currency: 'EGP',
        status: (opts.status ?? 'PREPARING') as never,
      },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: cycle.id,
        supplierId: supplier.id,
        reference: `PO-${tag}`,
        currency: 'EGP',
        fxRateToEgp: 1,
        orderedOn: day(opts.orderedOn ?? '2026-08-01'),
        status: opts.poStatus ?? 'CONFIRMED',
      },
    });
    const item = await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        productId: product.id,
        orderedQty: 100,
        unitPrice: 10,
        lineTotal: 1000,
      },
    });
    return { cycle, item, product, tag };
  }

  async function addLeg(
    cycleId: string,
    sequence: number,
    origin: string,
    destination: string,
  ) {
    return prisma.shippingLeg.create({
      data: {
        cycleId,
        sequence,
        origin,
        destination,
        costBasis: 'FLAT',
        amount: 0,
        amountEgp: 0,
      },
    });
  }
  const depart = (legId: string, itemId: string, on: string, qty: number) =>
    prisma.shipmentDeparture.create({
      data: {
        legId,
        departedOn: day(on),
        lines: { create: [{ purchaseOrderItemId: itemId, qty }] },
      },
    });
  const deliver = (legId: string, itemId: string, on: string, qty: number) =>
    prisma.shipmentDelivery.create({
      data: {
        legId,
        arrivedOn: day(on),
        lines: { create: [{ purchaseOrderItemId: itemId, qty }] },
      },
      include: { lines: true },
    });
  /** A receipt as `verifyStock` stores it: at its day's instant (`instantOfDay`). */
  const receive = (
    cycleId: string,
    productId: string,
    itemId: string,
    deliveryLineId: string,
    on: string,
    qty: number,
  ) =>
    prisma.inventoryBatch.create({
      data: {
        cycleId,
        productId,
        sourcePoItemId: itemId,
        sourceDeliveryLineId: deliveryLineId,
        receivedQty: qty,
        remainingQty: qty,
        saleableQty: qty,
        landedUnitCostEgp: 10,
        verificationStatus: 'VERIFIED',
        createdAt: instantOfDay(on, new Date('2099-01-01T00:00:00Z')),
      },
    });
  /** A status change as the audit-log backfill wrote it, at an instant in the past. */
  const pastChange = (cycleId: string, toStatus: string, at: string) =>
    prisma.cycleStatusChange.create({
      data: { cycleId, toStatus: toStatus as never, changedAt: new Date(at) },
    });

  it('a China cycle: two legs, Egypt in two batches, received twice, selling', async () => {
    const { cycle, item, product } = await cycleWith({ status: 'SELLING' });
    const leg1 = await addLeg(cycle.id, 1, 'Guangzhou, CN', 'Dubai, UAE');
    const leg2 = await addLeg(cycle.id, 2, 'Dubai, UAE', 'Cairo, Egypt');
    await depart(leg1.id, item.id, '2026-08-10', 100);
    await deliver(leg1.id, item.id, '2026-09-05', 100);
    await depart(leg2.id, item.id, '2026-09-12', 100);
    // The second batch entered first: the timeline orders by day, not by entry.
    const second = await deliver(leg2.id, item.id, '2026-10-08', 40);
    const first = await deliver(leg2.id, item.id, '2026-10-01', 60);
    await receive(
      cycle.id,
      product.id,
      item.id,
      first.lines[0].id,
      '2026-10-02',
      60,
    );
    await receive(
      cycle.id,
      product.id,
      item.id,
      second.lines[0].id,
      '2026-10-09',
      40,
    );
    // Selling at 00:30 on Oct 2 in Cairo — still Oct 1 in UTC — logged before
    // the status history began, so "recorded".
    await pastChange(cycle.id, 'SELLING', '2026-10-01T21:30:00Z');

    const t = await timeline(cycle.id);
    expect(t.steps.map((s) => s.key)).toEqual([
      'ordered',
      'leg1-departed-1',
      'leg1-delivered-1',
      'leg2-departed-1',
      'leg2-delivered-1',
      'leg2-delivered-2',
      'received-first',
      'received-last',
      'selling',
      'settlement',
      'closed',
    ]);
    expect(since(t.steps, 'leg1-delivered-1')).toBe('26 ON_THE_WAY');
    expect(since(t.steps, 'leg2-departed-1')).toBe('7 WAITED');
    expect(since(t.steps, 'leg2-delivered-1')).toBe('19 ON_THE_WAY');
    expect(since(t.steps, 'leg2-delivered-2')).toBe('7 AFTER_FIRST');
    expect(step(t.steps, 'leg2-delivered-2').completesLeg).toBe(true);
    expect(step(t.steps, 'leg2-delivered-1').leg).toEqual({
      sequence: 2,
      origin: 'Dubai, UAE',
      destination: 'Cairo, Egypt',
    });
    expect(step(t.steps, 'received-first').day).toBe('2026-10-02');
    expect(since(t.steps, 'received-last')).toBe('7 AFTER_FIRST');
    expect(step(t.steps, 'selling')).toMatchObject({
      day: '2026-10-02',
      recorded: true,
    });
    expect(t.summary).toEqual({
      from: '2026-08-01',
      to: '2026-10-02',
      days: 62,
      until: 'SELLING',
    });
  });

  it('a cycle with only an order: the rest is to come, with no dates, and the total runs to today', async () => {
    const { cycle } = await cycleWith({});
    const t = await timeline(cycle.id);
    expect(t.steps.filter((s) => s.state === 'DONE').map((s) => s.key)).toEqual(
      ['ordered'],
    );
    expect(
      t.steps.filter((s) => s.state !== 'DONE').every((s) => s.day === null),
    ).toBe(true);
    expect(t.summary).toMatchObject({
      from: '2026-08-01',
      until: 'TODAY',
      to: t.today,
    });
  });

  it('a draft order has not been placed: nothing is "ordered" yet', async () => {
    const { cycle } = await cycleWith({
      status: 'PURCHASING',
      poStatus: 'DRAFT',
    });
    const t = await timeline(cycle.id);
    expect(step(t.steps, 'ordered')).toMatchObject({
      state: 'UPCOMING',
      day: null,
    });
    expect(t.summary).toBeNull();
  });

  it('legs entered out of order are read in route order', async () => {
    const { cycle, item } = await cycleWith({ status: 'IN_TRANSIT_TO_EGYPT' });
    const leg2 = await addLeg(cycle.id, 2, 'Dubai, UAE', 'Cairo, Egypt');
    const leg1 = await addLeg(cycle.id, 1, 'Guangzhou, CN', 'Dubai, UAE');
    await depart(leg2.id, item.id, '2026-09-12', 100);
    await deliver(leg1.id, item.id, '2026-09-05', 100);
    await depart(leg1.id, item.id, '2026-08-10', 100);

    const t = await timeline(cycle.id);
    expect(
      t.steps
        .filter((s) => s.leg)
        .map((s) => `${s.leg!.sequence}:${s.kind}:${s.state}`),
    ).toEqual([
      '1:DEPARTED:DONE',
      '1:DELIVERED:DONE',
      '2:DEPARTED:DONE',
      '2:DELIVERED:UPCOMING',
    ]);
    expect(since(t.steps, 'leg2-departed-1')).toBe('7 WAITED');
  });

  it('a delivery dated before its departure is shown as dated, flagged, with no length', async () => {
    const { cycle, item } = await cycleWith({
      originType: 'UAE_DIRECT',
      status: 'ARRIVED_EGYPT',
    });
    const leg = await addLeg(cycle.id, 1, 'Dubai, UAE', 'Cairo, Egypt');
    await depart(leg.id, item.id, '2026-09-20', 100);
    await deliver(leg.id, item.id, '2026-09-15', 100);

    const t = await timeline(cycle.id);
    expect(step(t.steps, 'leg1-delivered-1')).toMatchObject({
      day: '2026-09-15',
      since: null,
      flag: 'BEFORE_PREVIOUS',
    });
    expect(t.steps.every((s) => !s.since || s.since.days >= 0)).toBe(true);
  });

  it('departures in parts: numbered, and what is still in Guangzhou is to come', async () => {
    const { cycle, item } = await cycleWith({ status: 'IN_TRANSIT' });
    const leg1 = await addLeg(cycle.id, 1, 'Guangzhou, CN', 'Dubai, UAE');
    await addLeg(cycle.id, 2, 'Dubai, UAE', 'Cairo, Egypt');
    await depart(leg1.id, item.id, '2026-08-10', 60);
    await depart(leg1.id, item.id, '2026-08-20', 20);

    const t = await timeline(cycle.id);
    expect(since(t.steps, 'leg1-departed-2')).toBe('10 AFTER_FIRST');
    expect(step(t.steps, 'leg1-departed-rest')).toMatchObject({
      state: 'UPCOMING',
      rest: true,
    });
  });

  it('stock moved in from another cycle is not a receipt of this one', async () => {
    const from = await cycleWith({ status: 'SELLING' });
    const to = await cycleWith({ status: 'PREPARING' });
    const source = await prisma.inventoryBatch.create({
      data: {
        cycleId: from.cycle.id,
        productId: from.product.id,
        receivedQty: 5,
        remainingQty: 5,
        saleableQty: 5,
        landedUnitCostEgp: 10,
      },
    });
    await prisma.inventoryBatch.create({
      data: {
        cycleId: to.cycle.id,
        productId: from.product.id,
        transferredFromBatchId: source.id,
        receivedQty: 5,
        remainingQty: 5,
        saleableQty: 5,
        landedUnitCostEgp: 10,
      },
    });
    const t = await timeline(to.cycle.id);
    expect(step(t.steps, 'received-first').state).toBe('UPCOMING');
  });

  it('status changes the trigger writes from now on are not "recorded"; the backfilled ones are', async () => {
    const { cycle } = await cycleWith({ status: 'PREPARING' });
    await pastChange(cycle.id, 'SELLING', '2026-10-02T10:00:00Z');
    // A change made now goes through the trigger, at the database's clock.
    await prisma.importCycle.update({
      where: { id: cycle.id },
      data: { status: 'SELLING' },
    });
    await prisma.importCycle.update({
      where: { id: cycle.id },
      data: { status: 'SETTLEMENT' },
    });
    const rows = await prisma.cycleStatusChange.findMany({
      where: { cycleId: cycle.id, toStatus: 'SETTLEMENT' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].changedAt >= startOfBusinessDay('2026-11-08')).toBe(true);

    const t = await timeline(cycle.id);
    // Selling began at the first change into it, the backfilled one.
    expect(step(t.steps, 'selling')).toMatchObject({
      day: '2026-10-02',
      recorded: true,
    });
    expect(step(t.steps, 'settlement')).toMatchObject({
      state: 'DONE',
      recorded: false,
    });
  });

  it('twice: reading it again changes nothing and answers the same', async () => {
    const { cycle, item } = await cycleWith({ status: 'IN_TRANSIT' });
    const leg1 = await addLeg(cycle.id, 1, 'Guangzhou, CN', 'Dubai, UAE');
    await depart(leg1.id, item.id, '2026-08-10', 100);
    const a = await timeline(cycle.id);
    const b = await timeline(cycle.id);
    expect(b).toEqual(a);
  });

  it('an unknown cycle is a coded 404', async () => {
    expect(await refusal(cycles.getTimeline(randomUUID()))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('an id that cannot be one is a coded 400, not a 500 from Postgres', async () => {
    for (const bad of ['abc', '1', "'; drop table import_cycles; --", '']) {
      expect(await refusal(cycles.getTimeline(bad))).toEqual({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it("an investor reading another cycle's timeline gets 404, as if it did not exist", async () => {
    const { cycle } = await cycleWith({});
    const investor = { id: randomUUID(), role: 'TEMP_INVESTOR' };
    expect(
      await refusal(cycles.getTimeline(cycle.id, investor as never)),
    ).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});
