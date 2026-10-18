import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  NotificationsService,
  notifyLowStock,
} from '../notifications/notifications.service';
import { Prisma } from '@prisma/client';
import { CostingService, lineEventCost } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { formatMoney, formatQty } from '../../common/money';
import { findLowStock } from '../../common/low-stock';
import { unitsAtShopsByProduct } from '../../common/samples-out';

import { badRequest, notFound } from '../../common/api-error';
import { assertUuid, isUuid } from '../../common/uuid';
import { chosenDay, instantOfDay } from '../../common/dates';
import { loadShipment, lockCycle } from '../../common/shipment-load';
import {
  assertInScope,
  cycleIdWhere,
  cyclesVisibleTo,
  type ScopeViewer,
} from '../../common/investor-scope';

type Db = Prisma.TransactionClient;

/**
 * What a receipt of stock names (BUSINESS_LOGIC §3 — DECIDED 2026-10-10).
 *
 * The shape: one last-leg delivery (`deliveryId`) and, per line of it, how many
 * were counted in (`deliveryLineId`, `receivedQty`).
 *
 * The older shape names order lines (`purchaseOrderItemId`) and no delivery.
 * It still works when exactly one last-leg delivery of that line is waiting to
 * be received — which is what the fixtures, the old wizard and the assistant
 * produce — and is otherwise refused with DELIVERY_REQUIRED, because which
 * delivery the goods came in decides their arrival date (§14).
 */
export interface VerifyStockInput {
  deliveryId?: string | null;
  /**
   * The Cairo day the goods were counted into stock, YYYY-MM-DD (§3,
   * 2026-10-16). Today when left out; never in the future, never before the
   * delivery reached Egypt. It is the batch's received instant, so FIFO and a
   * sale dated in the past both read it.
   */
  receivedOn?: string | null;
  items: Array<{
    deliveryLineId?: string;
    purchaseOrderItemId?: string;
    /** Ignored: the product is the order line's. Accepted for older callers. */
    productId?: string;
    receivedQty: number;
    /** Optional manual override, for this batch only; computed when omitted. */
    landedUnitCostEgp?: number | null;
  }>;
}

/** Statuses stock can be received in (§3, amendment 6). */
const RECEIVABLE = ['ARRIVED_EGYPT', 'VERIFICATION', 'SELLING'];
/** The walk the first receipt makes, one transition at a time. */
const WALK = ['ARRIVED_EGYPT', 'VERIFICATION', 'SELLING'];

/** Quantities compared in whole thousandths, as `shipmentPosition` sums them. */
const milli = (q: Prisma.Decimal.Value) =>
  Math.round(Number(new Prisma.Decimal(q).toString()) * 1000);

function alreadyVerified(product: string) {
  return badRequest(
    'STOCK_ALREADY_VERIFIED',
    `Everything this delivery brought of ${product} has already been received into stock.`,
    { product },
  );
}

function exceedsDelivered(
  product: string,
  received: number,
  available: number,
) {
  return badRequest(
    'RECEIVED_EXCEEDS_DELIVERED',
    `${received} of ${product} cannot be received: only ${available} are waiting to be received from this delivery.`,
    { product, received, available },
  );
}

/** Refuse a receipt on a cycle that is not in Egypt yet, or is being settled. */
function assertReceivable(cycle: { code: string; status: string }) {
  if (RECEIVABLE.includes(cycle.status)) return;
  if (cycle.status === 'CANCELLED') {
    throw badRequest(
      'CYCLE_CLOSED',
      `Cycle ${cycle.code} was cancelled, so nothing can be recorded on its shipment.`,
      { cycle: cycle.code, status: cycle.status },
    );
  }
  if (cycle.status === 'SETTLEMENT' || cycle.status === 'CLOSED') {
    throw badRequest(
      'CYCLE_SETTLING',
      `Cycle ${cycle.code} is ${cycle.status}. Nothing is recorded on a cycle being settled; reverse the settlement first.`,
      { cycle: cycle.code, status: cycle.status },
    );
  }
  throw badRequest(
    'CYCLE_NOT_ARRIVED',
    `Cycle ${cycle.code} is ${cycle.status}. Stock can be received once the cycle has arrived in Egypt.`,
    { cycle: cycle.code, status: cycle.status },
  );
}

@Injectable()
export class InventoryService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private costing: CostingService,
    private cycles: CyclesService,
  ) {}

  /**
   * Every check a receipt makes, and the landed cost each line will be booked
   * at, with nothing written.
   *
   * The assistant previews a receipt from this, and `verifyStock` calls it
   * again inside its transaction, under the cycle's lock, and books exactly
   * the lines it returns — so the unit cost the partner confirms is the unit
   * cost on the batch and the amount on the ledger.
   *
   * What it checks against is `shipmentPosition` (rule 11): a delivery line can
   * be received in several goes, never past what it brought, and never past
   * what of its order line is still waiting to be received (a loss may have
   * taken some of it).
   */
  async planVerification(
    cycleId: string,
    data: VerifyStockInput,
    db: Db = this.prisma,
  ) {
    assertUuid(cycleId, 'cycleId');
    const receivedOn = chosenDay(data?.receivedOn, 'STOCK_RECEIVED');
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) {
      throw badRequest(
        'VALIDATION_FAILED',
        'items must contain at least one line',
        { fields: 'items' },
      );
    }

    const loaded = await loadShipment(db, cycleId);
    if (!loaded) throw notFound('cycle');
    const { cycle, position } = loaded;
    assertReceivable(cycle);

    const orderLines = new Map(
      cycle.purchaseOrders.flatMap((po) =>
        po.items.map((i) => [i.id, i] as const),
      ),
    );
    const lastLeg = position.legs.find((l) => l.isLast);
    const lastLegDeliveries = lastLeg?.deliveries ?? [];
    type Delivery = (typeof lastLegDeliveries)[number];
    type DeliveryLine = Delivery['lines'][number];

    // The delivery named, when one is: it must be this cycle's, and on the
    // leg that ends in Egypt — stock exists only there (§3).
    let named: Delivery | undefined;
    if (data.deliveryId !== undefined && data.deliveryId !== null) {
      if (!isUuid(data.deliveryId)) throw notFound('shipmentDelivery');
      named = lastLegDeliveries.find((d) => d.id === data.deliveryId);
      if (!named) {
        const elsewhere = position.legs.some((l) =>
          l.deliveries.some((d) => d.id === data.deliveryId),
        );
        // Another cycle's delivery is "no such delivery" here.
        if (!elsewhere) throw notFound('shipmentDelivery');
        throw badRequest(
          'NOT_LAST_LEG_DELIVERY',
          'This delivery reached the UAE, not Egypt. Stock is received from deliveries on the leg that ends in Egypt.',
        );
      }
    }

    const resolved: {
      delivery: Delivery;
      line: DeliveryLine;
      qty: Prisma.Decimal;
      override: Prisma.Decimal | null;
    }[] = [];
    const seen = new Set<string>();

    for (const item of items) {
      let delivery: Delivery;
      let line: DeliveryLine;

      if (named) {
        if (!isUuid(item.deliveryLineId)) {
          throw notFound('shipmentDeliveryLine');
        }
        const found = named.lines.find((x) => x.id === item.deliveryLineId);
        if (!found) throw notFound('shipmentDeliveryLine');
        delivery = named;
        line = found;
      } else {
        // The older shape: an order line, and the one delivery of it waiting.
        assertUuid(item.purchaseOrderItemId, 'purchaseOrderItemId');
        const poId = item.purchaseOrderItemId;
        if (!orderLines.has(poId)) {
          const exists = await db.purchaseOrderItem.findUnique({
            where: { id: poId },
            select: { id: true },
          });
          if (!exists) throw notFound('purchaseOrderItem');
          throw badRequest(
            'PO_ITEM_NOT_IN_CYCLE',
            `Purchase order item does not belong to cycle ${cycle.code}`,
          );
        }
        const product = orderLines.get(poId)!.product.name;
        const candidates = lastLegDeliveries.flatMap((d) =>
          d.lines
            .filter((l) => l.purchaseOrderItemId === poId)
            .map((l) => ({ d, l })),
        );
        const waiting = candidates.filter(
          ({ l }) => milli(l.qty) > milli(l.received),
        );
        // Nothing of it has reached Egypt: there is nothing to receive.
        if (candidates.length === 0) {
          throw exceedsDelivered(product, Number(item.receivedQty), 0);
        }
        if (waiting.length === 0) throw alreadyVerified(product);
        if (waiting.length > 1) {
          throw badRequest(
            'DELIVERY_REQUIRED',
            `${waiting.length} deliveries of ${product} are waiting to be received. Name the delivery the goods came in.`,
            { product, deliveries: waiting.length },
          );
        }
        delivery = waiting[0].d;
        line = waiting[0].l;
      }

      // The same line twice would be one delivery counted in twice.
      if (seen.has(line.id)) {
        throw badRequest(
          'VALIDATION_FAILED',
          'The same delivery line appears twice. Put its whole quantity on one line.',
          { fields: 'items' },
        );
      }
      seen.add(line.id);

      // A negative count is stock that was never there. Zero is nothing
      // received: no batch, and the line stays waiting (§15).
      const received = Number(item.receivedQty);
      if (!Number.isFinite(received) || received < 0) {
        throw badRequest(
          'QTY_NOT_POSITIVE',
          `receivedQty must not be negative (received ${String(item.receivedQty)})`,
        );
      }

      let override: Prisma.Decimal | null = null;
      if (
        item.landedUnitCostEgp !== undefined &&
        item.landedUnitCostEgp !== null
      ) {
        const cost = Number(item.landedUnitCostEgp);
        if (!Number.isFinite(cost) || cost < 0) {
          throw badRequest(
            'VALIDATION_FAILED',
            'landedUnitCostEgp must not be negative',
            { fields: 'landedUnitCostEgp' },
          );
        }
        override = new Prisma.Decimal(cost);
      }

      resolved.push({
        delivery,
        line,
        qty: new Prisma.Decimal(received),
        override,
      });
    }

    const counted = resolved.filter((r) => r.qty.gt(0));
    if (counted.length === 0) {
      throw badRequest(
        'QTY_NOT_POSITIVE',
        'Nothing was received: every quantity is zero.',
      );
    }

    // Goods are counted in once they are here: never before the delivery
    // that brought them reached Egypt (§3, 2026-10-16).
    for (const r of counted) {
      const arrivedOn = r.delivery.arrivedOn;
      if (arrivedOn && receivedOn < arrivedOn) {
        throw badRequest(
          'RECEIVED_BEFORE_ARRIVAL',
          `Stock cannot be received on ${receivedOn}: the delivery reached Egypt on ${arrivedOn}.`,
          { day: receivedOn, arrivedOn },
        );
      }
    }

    // Never past what the delivery line brought less what was already counted
    // in from it, and never past what of the order line is still waiting — a
    // loss can have taken some of what a delivery brought (§1, §3).
    for (const r of counted) {
      const product = orderLines.get(r.line.purchaseOrderItemId)!.product.name;
      const leftOnLine = milli(r.line.qty) - milli(r.line.received);
      if (leftOnLine <= 0) throw alreadyVerified(product);
      const waiting = milli(
        position.lines.find(
          (l) => l.purchaseOrderItemId === r.line.purchaseOrderItemId,
        )!.waiting,
      );
      const available = Math.max(0, Math.min(leftOnLine, waiting));
      if (milli(r.qty) > available) {
        throw exceedsDelivered(product, r.qty.toNumber(), available / 1000);
      }
    }

    // Per unit ORDERED (§2): the same for every delivery; the receipt that
    // accounts for a line's last units takes the rounding residual.
    const costing = await this.costing.computeCycleLandedCosts(cycleId, {
      db,
    });
    const losses = cycle.shippingLegs.flatMap((l) => l.losses);

    const lines = counted.map(({ delivery, line, qty, override }) => {
      const poItem = orderLines.get(line.purchaseOrderItemId)!;
      const costed = costing.items.find(
        (i) => i.purchaseOrderItemId === poItem.id,
      );
      if (!costed) {
        throw badRequest(
          'NO_LANDED_COST',
          `Could not determine landed unit cost for purchase order item ${poItem.id}`,
        );
      }
      const computed = lineEventCost({
        orderedQty: poItem.orderedQty,
        landedTotalEgp: costed.totalLandedCostEgp,
        unitCostEgp: costed.landedUnitCostEgp,
        priorReceivedQtys: cycle.inventoryBatches
          .filter((b) => b.sourcePoItemId === poItem.id)
          .map((b) => b.receivedQty),
        priorLosses: losses.filter((x) => x.purchaseOrderItemId === poItem.id),
        qty,
      });
      // A manual figure applies to this batch only (§2).
      const unit = override ?? computed.unitCostEgp;
      return {
        deliveryId: delivery.id,
        deliveryLineId: line.id,
        /** The day the delivery reached Egypt, YYYY-MM-DD (§14). */
        arrivedOn: delivery.arrivedOn,
        purchaseOrderItemId: poItem.id,
        productId: poItem.productId,
        productName: poItem.product.name,
        orderedQty: new Prisma.Decimal(poItem.orderedQty),
        receivedQty: qty,
        landedUnitCostEgp: unit,
        costSource: override ? ('manual' as const) : ('computed' as const),
        /** What the ledger records as this line's purchase cost. */
        lineCostEgp: override
          ? unit.mul(qty).toDecimalPlaces(2)
          : computed.costEgp,
      };
    });

    return {
      cycle,
      /** The day the goods were counted in, YYYY-MM-DD. */
      receivedOn,
      lines,
      totalEgp: lines.reduce(
        (s, l) => s.add(l.lineCostEgp),
        new Prisma.Decimal(0),
      ),
      warnings: costing.warnings,
    };
  }

  /**
   * POST /receipts/verify — count one last-leg delivery into stock, a batch per
   * line, each carrying the delivery's arrival date (§3, §14).
   *
   * Everything happens in one transaction holding the cycle's lock: two
   * receipts of the same delivery line sent at once would otherwise both read
   * "15 waiting" and both be booked. With the lock the second waits, reads
   * what the first left, and is refused.
   *
   * The first receipt walks the cycle on to SELLING through each transition
   * (Arrived Egypt → Verification → Selling), so each step's own checks run;
   * a refused step refuses the receipt, and nothing is received.
   *
   * Only what must stand or fall together is inside the transaction. Anything
   * reaching for `this.prisma` from in here asks the pool for a second
   * connection while this one is held — and `connection_limit: 1` on the
   * deployed runtime means there is none (P2028, every time, at exactly the
   * ceiling). Audit rows and notifications are written after the commit.
   */
  async verifyStock(cycleId: string, data: VerifyStockInput, actorId: string) {
    // Before the lock: a non-uuid would otherwise fail inside the SQL cast.
    assertUuid(cycleId, 'cycleId');

    const { batches, lowStockProducts, walked } =
      await this.prisma.$transaction(async (tx) => {
        await lockCycle(tx, cycleId);
        const plan = await this.planVerification(cycleId, data, tx);

        const walked: Awaited<
          ReturnType<CyclesService['transitionIn']>
        >['plan'][] = [];
        const from = WALK.indexOf(plan.cycle.status);
        for (const step of WALK.slice(from + 1)) {
          const { plan: stepPlan } = await this.cycles.transitionIn(
            tx,
            cycleId,
            step,
          );
          walked.push(stepPlan);
        }

        const batches: Awaited<ReturnType<Db['inventoryBatch']['create']>>[] =
          [];

        for (const line of plan.lines) {
          const batch = await tx.inventoryBatch.create({
            data: {
              cycleId,
              productId: line.productId,
              sourcePoItemId: line.purchaseOrderItemId,
              sourceDeliveryLineId: line.deliveryLineId,
              arrivedOn: new Date(`${line.arrivedOn}T00:00:00Z`),
              receivedQty: line.receivedQty,
              remainingQty: line.receivedQty,
              saleableQty: line.receivedQty,
              landedUnitCostEgp: line.landedUnitCostEgp,
              verificationStatus: 'VERIFIED',
              // The received instant FIFO orders by (§3): now for today, the
              // middle of the chosen day for an earlier one.
              createdAt: instantOfDay(plan.receivedOn),
            },
          });
          batches.push(batch);

          await tx.inventoryMovement.create({
            data: {
              batchId: batch.id,
              movementType: 'RECEIVE',
              qtyDelta: line.receivedQty,
              referenceType: 'PURCHASE_ORDER_ITEM',
              referenceId: line.purchaseOrderItemId,
              createdBy: actorId,
            },
          });

          // The order line's received quantity is the sum of its batches —
          // never set directly, never overwritten by the latest receipt.
          const sum = await tx.inventoryBatch.aggregate({
            where: { sourcePoItemId: line.purchaseOrderItemId },
            _sum: { receivedQty: true },
          });
          await tx.purchaseOrderItem.update({
            where: { id: line.purchaseOrderItemId },
            data: {
              receivedQty: sum._sum.receivedQty ?? new Prisma.Decimal(0),
            },
          });

          await tx.financialTransaction.create({
            data: {
              type: 'PURCHASE_COST',
              category: 'purchase',
              direction: 'OUTFLOW',
              amount: line.lineCostEgp,
              currency: 'EGP',
              cycleId,
              relatedType: 'PURCHASE_ORDER_ITEM',
              relatedId: line.purchaseOrderItemId,
              reason: `Auto: ${formatQty(line.receivedQty)} units received at ${formatMoney(line.landedUnitCostEgp)} EGP/unit landed`,
              createdBy: actorId,
            },
          });
        }

        // Low stock after this receipt, by the one rule (common/low-stock.ts):
        // active, a minimum set, on hand (remaining) below it. Once per product,
        // after every line is in, so two lines of one product raise one alert
        // with the final figure.
        const lowStockProducts = await findLowStock(tx, [
          ...new Set(plan.lines.map((l) => l.productId)),
        ]);

        return { batches, lowStockProducts, walked };
      });

    // After the commit: records of something that already happened. An audit
    // row for a receipt that rolled back would be a lie, and a low-stock alert
    // for stock never landed sends somebody to look at an unchanged shelf.
    for (const step of walked) {
      await this.cycles.announceTransition(step, actorId);
    }
    await this.audit.log({
      actorUserId: actorId,
      action: 'VERIFY_STOCK',
      entityType: 'InventoryBatch',
      entityId: cycleId,
      afterJson: {
        batchCount: batches.length,
        totalQty: batches.reduce((s, b) => s + Number(b.receivedQty), 0),
      },
    });

    await notifyLowStock(this.prisma, this.notifications, lowStockProducts);

    // Where the cycle now stands, in the shape a recorded departure or
    // delivery reports it (L3), so the office app says it the same way.
    const last = walked[walked.length - 1];
    return {
      data: batches,
      cycleStatus: last
        ? {
            cycleId,
            from: walked[0].from,
            to: last.to,
            moved: true,
            steps: walked.map((p) => p.to),
            stoppedAt: null,
            ordersConfirmed: [],
          }
        : null,
    };
  }

  async getStock(
    params: { productId?: string; cycleId?: string },
    viewer: ScopeViewer = 'internal',
  ) {
    const where: Prisma.InventoryBatchWhereInput = {};
    if (params.productId) where.productId = params.productId;
    // An investor: only batches their cycles brought in (R1). Every batch has
    // a source cycle, so stock from anyone else's cycle simply is not listed.
    const cycleFilter = cycleIdWhere(
      await cyclesVisibleTo(viewer, this.prisma),
      params.cycleId,
    );
    if (cycleFilter) where.cycleId = cycleFilter;

    const batches = await this.prisma.inventoryBatch.findMany({
      where,
      include: {
        product: true,
        cycle: {
          // Only for batches from before deliveries (2026-10-10), which carry
          // no arrival of their own. Ordered so the last leg is the arrival
          // into Egypt: a CHINA cycle has two, and the first leg arriving in
          // the UAE is not the date anyone means by "when did this arrive".
          include: {
            shippingLegs: {
              orderBy: { sequence: 'asc' },
              select: { sequence: true, arrivedOn: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Units out at shops as samples (§4, samples at shops, 2026-10-18): off
    // the shelf — so not in totalStock, which stays "on the shelf" and is what
    // low stock reads (§3) — and not sold. Counted once, from the open
    // samples orders' allocations; `allStock` is shelf + at shops.
    const atShops = await unitsAtShopsByProduct(this.prisma, where);

    // Group by product for totals
    const productTotals: Record<string, any> = {};
    for (const batch of batches) {
      if (!productTotals[batch.productId]) {
        productTotals[batch.productId] = {
          productId: batch.productId,
          productName: batch.product.name,
          productNameAr: batch.product.nameAr,
          totalStock: 0,
          reservedStock: 0,
          availableStock: 0,
          atShopsStock: Number(atShops.byProduct.get(batch.productId) ?? 0),
          allStock: 0,
          batches: [],
        };
      }
      productTotals[batch.productId].totalStock += Number(batch.remainingQty);
      productTotals[batch.productId].reservedStock += Number(batch.reservedQty);
      productTotals[batch.productId].availableStock += Number(
        batch.saleableQty,
      );
      // Two dates, because they answer different questions and a shop asking
      // "how old is this stock" means different things by them.
      //
      //   arrivedOn  — when the delivery that brought this batch reached
      //                Egypt (§14, 2026-10-10): the batch's own, so two
      //                batches of one cycle can show two dates.
      //   receivedAt — when it was verified into stock and became sellable.
      //                Always present, and the one the FIFO order uses.
      //
      // They are usually days apart and occasionally weeks, which is itself
      // worth seeing: a wide gap is stock that sat before anyone booked it in.
      // Collapsing them into one "arrived" would hide exactly that.
      //
      // Only a batch from before deliveries, with no date of its own, falls
      // back to the cycle's last dated leg — never the first.
      const legs = (batch.cycle as any)?.shippingLegs ?? [];
      const arrivedOn =
        batch.arrivedOn ??
        [...legs].reverse().find((l: any) => l.arrivedOn)?.arrivedOn ??
        null;

      productTotals[batch.productId].batches.push({
        ...batch,
        arrivedOn,
        receivedAt: batch.createdAt,
        atShopsQty: Number(atShops.byBatch.get(batch.id) ?? 0),
      });
    }
    for (const row of Object.values(productTotals) as {
      totalStock: number;
      atShopsStock: number;
      allStock: number;
    }[]) {
      // Thousandths, so 0.1 + 0.2 on the shelf and at shops is 0.3.
      row.allStock =
        Math.round((row.totalStock + row.atShopsStock) * 1000) / 1000;
    }

    return { data: Object.values(productTotals) };
  }

  async getMovements(batchId: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(batchId)) throw notFound('inventoryBatch');
    const batch = await this.prisma.inventoryBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw notFound('inventoryBatch');
    assertInScope(
      await cyclesVisibleTo(viewer, this.prisma),
      batch.cycleId,
      'inventoryBatch',
    );

    const movements = await this.prisma.inventoryMovement.findMany({
      where: { batchId },
      orderBy: { occurredAt: 'desc' },
    });

    return { data: movements };
  }
}
