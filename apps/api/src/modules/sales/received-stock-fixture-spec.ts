import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { InventoryService } from '../inventory/inventory.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { ShippingService } from '../shipping/shipping.service';

/**
 * Stock as the business gets it (CLAUDE.md §4), for DB-backed suites: a
 * cycle, a purchase order, a shipping leg that departed and delivered, and a
 * verified receipt — through the real delivery and receipt services, so the
 * batch, its landed cost, the cycle's status and the movements are the ones
 * production writes. Not a test file (no `.spec.ts`), and never built (it
 * ends in `spec.ts`, which tsconfig.build excludes) — as `*-fake-spec.ts`.
 */
export function receivedStock(
  prisma: PrismaClient,
  audit: AuditService,
  notifier: unknown,
) {
  const db = prisma as unknown as PrismaService;
  const notifications = notifier as NotificationsService;
  const costing = new CostingService(db);
  const cycles = new CyclesService(db, audit, notifications, costing);
  const deliveries = new DeliveriesService(
    db,
    audit,
    notifications,
    costing,
    cycles,
  );
  const shipping = new ShippingService(db, audit, costing, deliveries);
  const inventory = new InventoryService(
    db,
    audit,
    notifications,
    costing,
    cycles,
  );

  /** YYYY-MM-DD, `n` days before `today`. */
  const before = (today: string, n: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };

  /**
   * A UAE-direct cycle of one product: `qty` bought at `cost` each, a Dubai →
   * Cairo leg (free, so the landed cost is the purchase price until a leg
   * cost is set) that left a week before and delivered on `receivedOn`, a
   * verified receipt that day — the one batch it makes — and `actor`'s
   * capital declared and recorded arriving (check-data 14).
   */
  async function cycleWith(opts: {
    productId: string;
    qty: number;
    cost: number;
    receivedOn: string;
    actor: string;
  }) {
    const { productId, qty, cost, receivedOn, actor } = opts;
    const tag = randomUUID().slice(0, 8);
    const departed = before(receivedOn, 7);
    const supplier = await prisma.supplier.create({
      data: { name: `Fixture supplier ${tag}`, country: 'AE' },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `FIX-${tag}`,
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
        orderedOn: new Date(`${before(receivedOn, 14)}T00:00:00Z`),
        status: 'CONFIRMED',
      },
    });
    const poItem = await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        productId,
        orderedQty: qty,
        unitPrice: cost,
        lineTotal: qty * cost,
      },
    });
    const leg = await prisma.shippingLeg.create({
      data: {
        cycleId: cycle.id,
        sequence: 1,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        departedOn: new Date(`${departed}T00:00:00Z`),
        status: 'IN_TRANSIT',
        costBasis: 'FLAT',
        amount: 0,
        amountEgp: 0,
      },
    });
    await prisma.shipmentDeparture.create({
      data: {
        legId: leg.id,
        departedOn: new Date(`${departed}T00:00:00Z`),
        lines: { create: [{ purchaseOrderItemId: poItem.id, qty }] },
      },
    });
    const capital = qty * cost;
    const participant = await prisma.cycleParticipant.create({
      data: {
        cycleId: cycle.id,
        participantType: 'CORE_PARTNER',
        partnerUserId: actor,
        contributionAmount: capital,
      },
    });
    await prisma.financialTransaction.create({
      data: {
        type: 'CAPITAL_CONTRIBUTION',
        category: 'contribution',
        direction: 'INFLOW',
        amount: capital,
        currency: 'EGP',
        cycleId: cycle.id,
        relatedType: 'CYCLE_PARTICIPANT',
        relatedId: participant.id,
        createdBy: actor,
      },
    });
    const { data: delivery } = await deliveries.recordDelivery(
      leg.id,
      {
        arrivedOn: receivedOn,
        lines: [{ purchaseOrderItemId: poItem.id, qty }],
      },
      actor,
    );
    await inventory.verifyStock(
      cycle.id,
      {
        deliveryId: delivery.id,
        receivedOn,
        items: delivery.lines.map((l) => ({
          deliveryLineId: l.id,
          receivedQty: qty,
        })),
      },
      actor,
    );
    const batch = await prisma.inventoryBatch.findFirstOrThrow({
      where: { cycleId: cycle.id, productId },
    });
    return { cycle, batch, leg };
  }

  return { cycleWith, shipping, inventory, deliveries };
}
