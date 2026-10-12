import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { InventoryService } from './inventory.service';

/**
 * Receiving against a real Postgres (plan B3: "two receipts of one delivery
 * line at once that exceed it together → one succeeds, the other a coded
 * refusal, not a 500"), plus the walk and the settlement gate run through real
 * Prisma, so every query shape the unit fake answers is one Postgres accepts.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — never the dev database (CLAUDE.md rule 6). See
 * `deliveries.db.spec.ts` for the container to start.
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
// A real user: movements and ledger rows name who recorded them.
const ACTOR = randomUUID();

suite('receipts against Postgres', () => {
  let prisma: PrismaClient;
  let deliveries: DeliveriesService;
  let inventory: InventoryService;
  let cycles: CyclesService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.user.create({
      data: {
        id: ACTOR,
        email: `receipts-${ACTOR}@example.test`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const notifications = {
      createForMultipleUsers: jest.fn(),
    } as unknown as NotificationsService;
    const costing = new CostingService(db);
    cycles = new CyclesService(db, audit, notifications);
    deliveries = new DeliveriesService(
      db,
      audit,
      notifications,
      costing,
      cycles,
    );
    inventory = new InventoryService(db, audit, notifications, costing, cycles);
  });
  afterAll(() => prisma.$disconnect());

  /** A UAE-direct cycle that has arrived: 40 ordered at 100, a 400 leg. */
  async function arrivedCycle() {
    const tag = randomUUID().slice(0, 8);
    const supplier = await prisma.supplier.create({
      data: { name: `Receipt ${tag}`, country: 'AE' },
    });
    const product = await prisma.product.create({
      data: { sku: `RCPT-${tag}`, name: `Receipt part ${tag}` },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `RCPT-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'ARRIVED_EGYPT',
      },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: cycle.id,
        supplierId: supplier.id,
        reference: `PO-${tag}`,
        currency: 'EGP',
        fxRateToEgp: 1,
        orderedOn: new Date('2026-08-20T00:00:00Z'),
        status: 'CONFIRMED',
      },
    });
    const item = await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        productId: product.id,
        orderedQty: 40,
        unitPrice: 100,
        lineTotal: 4000,
      },
    });
    const leg = await prisma.shippingLeg.create({
      data: {
        cycleId: cycle.id,
        sequence: 1,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        departedOn: new Date('2026-09-01T00:00:00Z'),
        status: 'IN_TRANSIT',
        costBasis: 'FLAT',
        amount: 400,
        amountEgp: 400,
      },
    });
    // L8 (2026-10-12): a leg's goods leave in departures. This one left with
    // everything ordered, as the migration reads a dated leg.
    await prisma.shipmentDeparture.create({
      data: {
        legId: leg.id,
        departedOn: new Date('2026-09-01T00:00:00Z'),
        lines: { create: [{ purchaseOrderItemId: item.id, qty: 40 }] },
      },
    });
    return { cycle, item, leg };
  }

  async function deliver(legId: string, itemId: string, qty: number) {
    const { data } = await deliveries.recordDelivery(
      legId,
      {
        arrivedOn: '2026-09-20',
        lines: [{ purchaseOrderItemId: itemId, qty }],
      },
      ACTOR,
    );
    return data;
  }

  it('Two receipts of one delivery line at once that exceed it together → one succeeds, the other gets a coded refusal, not a 500', async () => {
    const { cycle, item, leg } = await arrivedCycle();
    const d = await deliver(leg.id, item.id, 15);
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        inventory.verifyStock(
          cycle.id,
          {
            deliveryId: d.id,
            items: [{ deliveryLineId: d.lines[0].id, receivedQty: 10 }],
          },
          ACTOR,
        ),
      ),
    );
    const refused = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(HttpException);
    expect((refused[0].reason as HttpException).getResponse()).toEqual(
      expect.objectContaining({ code: 'RECEIVED_EXCEEDS_DELIVERED' }),
    );
    const batches = await prisma.inventoryBatch.findMany({
      where: { cycleId: cycle.id },
    });
    expect(batches.map((b) => b.receivedQty.toNumber())).toEqual([10]);
  });

  it('The first receipt walks the cycle to SELLING, keeps receivedQty a sum, and stamps the batch with its delivery', async () => {
    const { cycle, item, leg } = await arrivedCycle();
    const first = await deliver(leg.id, item.id, 15);
    await inventory.verifyStock(
      cycle.id,
      {
        deliveryId: first.id,
        items: [{ deliveryLineId: first.lines[0].id, receivedQty: 15 }],
      },
      ACTOR,
    );
    expect(
      (await prisma.importCycle.findUniqueOrThrow({ where: { id: cycle.id } }))
        .status,
    ).toBe('SELLING');

    const second = await deliver(leg.id, item.id, 10);
    await inventory.verifyStock(
      cycle.id,
      {
        deliveryId: second.id,
        items: [{ deliveryLineId: second.lines[0].id, receivedQty: 10 }],
      },
      ACTOR,
    );
    const line = await prisma.purchaseOrderItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(line.receivedQty?.toNumber()).toBe(25);
    const batches = await prisma.inventoryBatch.findMany({
      where: { cycleId: cycle.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(batches.map((b) => b.landedUnitCostEgp.toFixed(4))).toEqual([
      '110.0000',
      '110.0000',
    ]);
    expect(batches.map((b) => b.sourceDeliveryLineId)).toEqual([
      first.lines[0].id,
      second.lines[0].id,
    ]);
    expect(batches[0].arrivedOn?.toISOString().slice(0, 10)).toBe('2026-09-20');

    // 15 on the way: the plain transition to SETTLEMENT is refused.
    const refused = await cycles
      .transition(cycle.id, 'SETTLEMENT', ACTOR)
      .catch((e: HttpException) => e.getResponse());
    expect(refused).toEqual(
      expect.objectContaining({ code: 'SHIPMENT_NOT_ACCOUNTED' }),
    );

    await deliveries.recordLoss(
      leg.id,
      { lines: [{ purchaseOrderItemId: item.id, qty: 15 }] },
      ACTOR,
    );
    await cycles.transition(cycle.id, 'SETTLEMENT', ACTOR);
    expect(
      (await prisma.importCycle.findUniqueOrThrow({ where: { id: cycle.id } }))
        .status,
    ).toBe('SETTLEMENT');
  });
});
