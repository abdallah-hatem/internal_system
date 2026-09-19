import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';
import { CostingService } from '../costing/costing.service';
import { formatMoney, formatQty } from '../../common/money';

import { badRequest, notFound } from '../../common/api-error';
import { assertUuid } from '../../common/uuid';

/** What a receipt of stock names: the order lines, and how many of each came. */
export interface VerifyStockInput {
  items: Array<{
    purchaseOrderItemId: string;
    /** Ignored: the product is the order line's. Accepted for older callers. */
    productId?: string;
    receivedQty: number;
    /** Optional manual override; computed from cycle costing when omitted. */
    landedUnitCostEgp?: number;
  }>;
}

function alreadyVerified(purchaseOrderItemId: string) {
  return badRequest(
    'STOCK_ALREADY_VERIFIED',
    `Stock already verified for purchase order item ${purchaseOrderItemId}`,
  );
}

@Injectable()
export class InventoryService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private costing: CostingService,
  ) {}

  /**
   * Every check `verifyStock` makes, and the landed cost each line will be
   * booked at, with nothing written.
   *
   * The assistant previews a receipt from this and `verifyStock` books exactly
   * the lines it returns, so the unit cost the partner confirms is the unit cost
   * on the batch and the amount on the ledger.
   *
   * The product comes from the order line, never from the caller: a batch holds
   * what was ordered on that line, and trusting a separate product id let a
   * receipt put one product's cost on another product's stock.
   */
  async planVerification(cycleId: string, data: VerifyStockInput) {
    assertUuid(cycleId, 'cycleId');
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
    });
    if (!cycle) throw notFound('cycle');

    if (cycle.status !== 'VERIFICATION') {
      throw badRequest(
        'CYCLE_NOT_IN_VERIFICATION',
        `Cycle must be in VERIFICATION status to verify stock. Current: ${cycle.status}`,
        { status: cycle.status },
      );
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) {
      throw badRequest(
        'VALIDATION_FAILED',
        'items must contain at least one line',
        { fields: 'items' },
      );
    }

    const checked: Array<{
      poItem: {
        id: string;
        productId: string;
        orderedQty: Prisma.Decimal;
        product: { name: string };
      };
      qty: Prisma.Decimal;
      override: Prisma.Decimal | null;
    }> = [];
    const seen = new Set<string>();

    for (const item of items) {
      assertUuid(item.purchaseOrderItemId, 'purchaseOrderItemId');
      // The second copy would fail on the batch's unique source line as a 500.
      if (seen.has(item.purchaseOrderItemId)) {
        throw badRequest(
          'VALIDATION_FAILED',
          `items lists purchase order item ${item.purchaseOrderItemId} twice`,
          { fields: 'items' },
        );
      }
      seen.add(item.purchaseOrderItemId);

      // Nothing received is not a receipt: a zero batch carries a zero unit
      // cost, and a negative one is stock that was never there.
      const received = Number(item.receivedQty);
      if (!Number.isFinite(received) || received <= 0) {
        throw badRequest(
          'QTY_NOT_POSITIVE',
          `receivedQty must be greater than zero (received ${String(item.receivedQty)})`,
        );
      }
      const qty = new Prisma.Decimal(received);

      // Validate PO item exists and belongs to this cycle
      const poItem = await this.prisma.purchaseOrderItem.findUnique({
        where: { id: item.purchaseOrderItemId },
        include: {
          purchaseOrder: { select: { cycleId: true } },
          product: { select: { name: true } },
        },
      });
      if (!poItem) {
        throw notFound('purchaseOrderItem');
      }
      if (poItem.purchaseOrder.cycleId !== cycleId) {
        throw badRequest(
          'PO_ITEM_NOT_IN_CYCLE',
          `Purchase order item does not belong to cycle ${cycleId}`,
        );
      }

      // More than was ordered cannot have come off this order line, and would
      // spread the line's goods cost over units nobody paid for.
      if (qty.gt(poItem.orderedQty)) {
        throw badRequest(
          'RECEIVED_EXCEEDS_ORDERED',
          `${formatQty(qty)} of ${poItem.product.name} cannot be received: only ${formatQty(poItem.orderedQty)} were ordered.`,
          {
            product: poItem.product.name,
            received: formatQty(qty),
            ordered: formatQty(poItem.orderedQty),
          },
        );
      }

      // Check for duplicate batch
      const existingBatch = await this.prisma.inventoryBatch.findUnique({
        where: { sourcePoItemId: item.purchaseOrderItemId },
      });
      if (existingBatch) {
        throw alreadyVerified(item.purchaseOrderItemId);
      }

      let override: Prisma.Decimal | null = null;
      if (item.landedUnitCostEgp !== undefined && item.landedUnitCostEgp !== null) {
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

      checked.push({ poItem, qty, override });
    }

    // Derive landed unit costs for this cycle using the quantities being
    // verified now, so shipping recorded on the cycle's legs (China->UAE and
    // UAE->Egypt, or UAE->Egypt alone) is spread across the goods it moved.
    const qtyOverrides: Record<string, Prisma.Decimal> = {};
    for (const c of checked) qtyOverrides[c.poItem.id] = c.qty;
    const costing = await this.costing.computeCycleLandedCosts(cycleId, {
      qtyOverrides,
    });
    const costByPoItem = new Map(
      costing.items.map((i) => [i.purchaseOrderItemId, i.landedUnitCostEgp]),
    );

    const lines = checked.map(({ poItem, qty, override }) => {
      // Manual override wins; otherwise use the computed landed cost.
      const unit = override ?? costByPoItem.get(poItem.id);
      if (unit === undefined) {
        throw badRequest(
          'NO_LANDED_COST',
          `Could not determine landed unit cost for purchase order item ${poItem.id}`,
        );
      }
      return {
        purchaseOrderItemId: poItem.id,
        productId: poItem.productId,
        productName: poItem.product.name,
        orderedQty: poItem.orderedQty,
        receivedQty: qty,
        landedUnitCostEgp: unit,
        costSource: override ? ('manual' as const) : ('computed' as const),
        /** What the ledger records as this line's purchase cost. */
        lineCostEgp: unit.mul(qty).toDecimalPlaces(2),
      };
    });

    return {
      cycle,
      lines,
      totalEgp: lines.reduce(
        (s, l) => s.add(l.lineCostEgp),
        new Prisma.Decimal(0),
      ),
      warnings: costing.warnings,
    };
  }

  async verifyStock(
    cycleId: string,
    data: VerifyStockInput,
    actorId: string,
  ) {
    const plan = await this.planVerification(cycleId, data);

    // One transaction for the writes that must stand or fall together — and
    // ONLY those. Anything reaching for `this.prisma` from in here asks the
    // pool for a second connection while this transaction holds the first, and
    // `connection_limit: 1` on the deployed runtime means there is no second
    // one to give. It waits for a connection that cannot arrive until the
    // transaction ends, and the transaction cannot end until it returns.
    //
    // That deadlock is what made receiving stock impossible in production:
    // P2028 at exactly the ceiling, every time, first at 5000 ms and then at
    // 15008 ms when the ceiling was raised. Always exactly the limit, never
    // near it — the shape of a hang rather than of slow work. Locally the pool
    // is large enough to hand out a second connection, so it never happened.
    const { batches, lowStockProducts } = await this.prisma.$transaction(async (tx) => {
      const batches: any[] = [];
      const lowStockProducts: any[] = [];

      for (const line of plan.lines) {
        const item = {
          purchaseOrderItemId: line.purchaseOrderItemId,
          productId: line.productId,
          receivedQty: line.receivedQty,
        };
        const resolvedUnitCost = line.landedUnitCostEgp;

        // Checked by the plan already; checked again here because another
        // receipt of the same line may have landed since.
        const existingBatch = await tx.inventoryBatch.findUnique({
          where: { sourcePoItemId: item.purchaseOrderItemId },
        });
        if (existingBatch) throw alreadyVerified(item.purchaseOrderItemId);

        const batch = await tx.inventoryBatch.create({
          data: {
            cycleId,
            productId: item.productId,
            sourcePoItemId: item.purchaseOrderItemId,
            receivedQty: item.receivedQty,
            remainingQty: item.receivedQty,
            saleableQty: item.receivedQty,
            landedUnitCostEgp: resolvedUnitCost,
            verificationStatus: 'VERIFIED',
          },
        });

        await tx.inventoryMovement.create({
          data: {
            batchId: batch.id,
            movementType: 'RECEIVE',
            qtyDelta: item.receivedQty,
            referenceType: 'PURCHASE_ORDER_ITEM',
            referenceId: item.purchaseOrderItemId,
            createdBy: actorId,
          },
        });

        // Update PO item receivedQty
        await tx.purchaseOrderItem.update({
          where: { id: item.purchaseOrderItemId },
          data: { receivedQty: item.receivedQty },
        });

        batches.push(batch);

        // Auto-create financial transaction for purchase cost
        const purchaseCost = line.lineCostEgp;
        await tx.financialTransaction.create({
          data: {
            type: 'PURCHASE_COST',
            category: 'purchase',
            direction: 'OUTFLOW',
            amount: purchaseCost,
            currency: 'EGP',
            cycleId,
            relatedType: 'PURCHASE_ORDER_ITEM',
            relatedId: item.purchaseOrderItemId,
            reason: `Auto: ${formatQty(item.receivedQty)} units received at ${formatMoney(resolvedUnitCost)} EGP/unit landed`,
            createdBy: actorId,
          },
        });

        // Check for low stock
        const product = await tx.product.findUnique({
          where: { id: item.productId },
        });
        if (product?.minStock) {
          // Calculate total stock for this product across all batches
          const totalStockAgg = await tx.inventoryBatch.aggregate({
            where: { productId: item.productId },
            _sum: { saleableQty: true },
          });
          const totalStock = Number(totalStockAgg._sum.saleableQty || 0);

          if (totalStock < Number(product.minStock)) {
            lowStockProducts.push({
              productId: item.productId,
              productName: product.name,
              currentStock: totalStock,
              minStock: Number(product.minStock),
            });
          }
        }
      }

      return { batches, lowStockProducts };
    });

    // After the commit, on the connection the transaction has now released.
    // Both of these are records of something that already happened, so they
    // belong here on their own merit: an audit row for a receipt that rolled
    // back would be a lie, and a low-stock alert for stock that was never
    // landed would send somebody to look at a shelf that did not change.
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

    if (lowStockProducts.length > 0) {
      const corePartners = await this.prisma.user.findMany({
        where: { role: 'CORE_PARTNER', status: 'ACTIVE' },
      });
      const userIds = corePartners.map((u) => u.id);
      if (userIds.length > 0) {
        await this.notifications.createForMultipleUsers(userIds, {
          eventType: 'LOW_STOCK_DETECTED',
          title: `Low stock detected: ${lowStockProducts.map((p) => p.productName).join(', ')}`,
          payload: { products: lowStockProducts },
        });
      }
    }

    return { data: batches };
  }

  async getStock(params: { productId?: string; cycleId?: string }) {
    const where: any = {};
    if (params.productId) where.productId = params.productId;
    if (params.cycleId) where.cycleId = params.cycleId;

    const batches = await this.prisma.inventoryBatch.findMany({
      where,
      include: {
        product: true,
        cycle: {
          // The legs carry the only record of when the goods physically
          // landed. Ordered so the last one is the arrival into Egypt: a
          // CHINA cycle has two, and the first leg arriving in the UAE is not
          // the date anyone means by "when did this arrive".
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

    // Group by product for totals
    const productTotals: Record<string, any> = {};
    for (const batch of batches) {
      if (!productTotals[batch.productId]) {
        productTotals[batch.productId] = {
          productId: batch.productId,
          productName: batch.product.name,
          totalStock: 0,
          reservedStock: 0,
          availableStock: 0,
          batches: [],
        };
      }
      productTotals[batch.productId].totalStock += Number(
        batch.remainingQty,
      );
      productTotals[batch.productId].reservedStock += Number(
        batch.reservedQty,
      );
      productTotals[batch.productId].availableStock += Number(
        batch.saleableQty,
      );
      // Two dates, because they answer different questions and a shop asking
      // "how old is this stock" means different things by them.
      //
      //   arrivedOn  — when the shipment physically landed. Null until the leg
      //                is dated, and null for stock that never had a leg.
      //   receivedAt — when it was verified into stock and became sellable.
      //                Always present, and the one the FIFO order uses.
      //
      // They are usually days apart and occasionally weeks, which is itself
      // worth seeing: a wide gap is stock that sat before anyone booked it in.
      // Collapsing them into one "arrived" would hide exactly that.
      const legs = (batch.cycle as any)?.shippingLegs ?? [];
      const lastArrival = [...legs]
        .reverse()
        .find((l: any) => l.arrivedOn)?.arrivedOn ?? null;

      productTotals[batch.productId].batches.push({
        ...batch,
        arrivedOn: lastArrival,
        receivedAt: batch.createdAt,
      });
    }

    return { data: Object.values(productTotals) };
  }

  async getMovements(batchId: string) {
    const batch = await this.prisma.inventoryBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw notFound('inventoryBatch');

    const movements = await this.prisma.inventoryMovement.findMany({
      where: { batchId },
      orderBy: { occurredAt: 'desc' },
    });

    return { data: movements };
  }
}
