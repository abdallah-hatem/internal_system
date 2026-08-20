import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';
import { CostingService } from '../costing/costing.service';

@Injectable()
export class InventoryService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private costing: CostingService,
  ) {}

  async verifyStock(
    cycleId: string,
    data: {
      items: Array<{
        purchaseOrderItemId: string;
        productId: string;
        receivedQty: number;
        /** Optional manual override; computed from cycle costing when omitted. */
        landedUnitCostEgp?: number;
      }>;
    },
    actorId: string,
  ) {
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
    });
    if (!cycle) throw new NotFoundException('Cycle not found');

    if (cycle.status !== 'VERIFICATION') {
      throw new BadRequestException(
        `Cycle must be in VERIFICATION status to verify stock. Current: ${cycle.status}`,
      );
    }

    // Derive landed unit costs for this cycle using the quantities being
    // verified now, so shipping recorded on the cycle's legs (China->UAE and
    // UAE->Egypt, or UAE->Egypt alone) is spread across the goods it moved.
    const qtyOverrides: Record<string, number> = {};
    for (const item of data.items) {
      qtyOverrides[item.purchaseOrderItemId] = item.receivedQty;
    }
    const costing = await this.costing.computeCycleLandedCosts(cycleId, {
      qtyOverrides,
    });
    const costByPoItem = new Map(
      costing.items.map((i) => [i.purchaseOrderItemId, i.landedUnitCostEgp]),
    );

    // All in a single Prisma transaction
    return this.prisma.$transaction(async (tx) => {
      const batches: any[] = [];
      const lowStockProducts: any[] = [];

      for (const item of data.items) {
        // Validate PO item exists and belongs to this cycle
        const poItem = await tx.purchaseOrderItem.findUnique({
          where: { id: item.purchaseOrderItemId },
          include: { purchaseOrder: true },
        });
        if (!poItem) {
          throw new NotFoundException(
            `Purchase order item ${item.purchaseOrderItemId} not found`,
          );
        }
        if (poItem.purchaseOrder.cycleId !== cycleId) {
          throw new BadRequestException(
            `Purchase order item does not belong to cycle ${cycleId}`,
          );
        }

        // Check for duplicate batch
        const existingBatch = await tx.inventoryBatch.findUnique({
          where: { sourcePoItemId: item.purchaseOrderItemId },
        });
        if (existingBatch) {
          throw new BadRequestException(
            `Stock already verified for purchase order item ${item.purchaseOrderItemId}`,
          );
        }

        // Manual override wins; otherwise use the computed landed cost.
        const resolvedUnitCost =
          item.landedUnitCostEgp !== undefined && item.landedUnitCostEgp !== null
            ? new Prisma.Decimal(item.landedUnitCostEgp)
            : costByPoItem.get(item.purchaseOrderItemId);

        if (resolvedUnitCost === undefined) {
          throw new BadRequestException(
            `Could not determine landed unit cost for purchase order item ${item.purchaseOrderItemId}`,
          );
        }

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
        const purchaseCost = resolvedUnitCost.mul(item.receivedQty).toDecimalPlaces(2);
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
            reason: `Auto: ${item.receivedQty} units received at ${resolvedUnitCost.toFixed(4)} EGP/unit landed`,
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

      await this.audit.log({
        actorUserId: actorId,
        action: 'VERIFY_STOCK',
        entityType: 'InventoryBatch',
        entityId: cycleId,
        afterJson: {
          batchCount: batches.length,
          totalQty: batches.reduce(
            (s, b) => s + Number(b.receivedQty),
            0,
          ),
        },
      });

      // Send low stock notifications
      if (lowStockProducts.length > 0) {
        const corePartners = await tx.user.findMany({
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
    });
  }

  async getStock(params: { productId?: string; cycleId?: string }) {
    const where: any = {};
    if (params.productId) where.productId = params.productId;
    if (params.cycleId) where.cycleId = params.cycleId;

    const batches = await this.prisma.inventoryBatch.findMany({
      where,
      include: { product: true, cycle: true },
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
      productTotals[batch.productId].batches.push(batch);
    }

    return { data: Object.values(productTotals) };
  }

  async getMovements(batchId: string) {
    const batch = await this.prisma.inventoryBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException('Inventory batch not found');

    const movements = await this.prisma.inventoryMovement.findMany({
      where: { batchId },
      orderBy: { occurredAt: 'desc' },
    });

    return { data: movements };
  }
}
