import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class SalesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll(pagination: {
    cursor?: string;
    limit?: number;
    customerId?: string;
    status?: string;
    channel?: string;
  }) {
    const { cursor, limit = 20, customerId, status, channel } = pagination;
    const where: any = {};
    if (customerId) where.customerId = customerId;
    if (status) where.status = status;
    if (channel) where.channel = channel;

    const items = await this.prisma.saleOrder.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: true,
        items: { include: { product: true } },
      },
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    return {
      data,
      meta: {
        nextCursor: hasMore ? data[data.length - 1].id : null,
        limit,
      },
    };
  }

  async findById(id: string) {
    const order = await this.prisma.saleOrder.findUnique({
      where: { id },
      include: {
        customer: true,
        items: {
          include: {
            product: true,
            allocations: { include: { inventoryBatch: true } },
          },
        },
        paymentAllocations: { include: { payment: true } },
      },
    });
    if (!order) throw new NotFoundException('Sale order not found');
    return { data: order };
  }

  async create(
    data: {
      customerId: string;
      channel: string;
      currency: string;
      items: {
        productId: string;
        quantity: number;
        unitPrice: number;
        discount?: number;
      }[];
    },
    actorId: string,
  ) {
    // Validate customer exists
    if (!data.customerId) {
      throw new BadRequestException('customerId is required');
    }
    const customer = await this.prisma.customer.findUnique({
      where: { id: data.customerId },
    });
    if (!customer) {
      throw new NotFoundException(`Customer not found: ${data.customerId}`);
    }

    // Validate items array
    if (!data.items || data.items.length === 0) {
      throw new BadRequestException('Order must contain at least one item');
    }

    // Validate each item
    for (const item of data.items) {
      if (!item.productId) {
        throw new BadRequestException('Each item must have a productId');
      }
      const product = await this.prisma.product.findUnique({
        where: { id: item.productId },
      });
      if (!product) {
        throw new NotFoundException(`Product not found: ${item.productId}`);
      }
      if (!item.quantity || item.quantity <= 0) {
        throw new BadRequestException(`Invalid quantity for product ${item.productId}: must be greater than 0`);
      }
      if (item.unitPrice == null || item.unitPrice < 0) {
        throw new BadRequestException(`Invalid unitPrice for product ${item.productId}: must be 0 or greater`);
      }
    }

    // Generate order number: ORD-YYYY-XXXXX
    const year = new Date().getFullYear();
    const count = await this.prisma.saleOrder.count({
      where: { orderNo: { startsWith: `ORD-${year}` } },
    });
    const orderNo = `ORD-${year}-${String(count + 1).padStart(5, '0')}`;

    // Calculate totals using Decimal arithmetic
    let subtotal = new Prisma.Decimal(0);
    const itemsData = data.items.map((item) => {
      const lineTotal =
        item.unitPrice * item.quantity - (item.discount || 0);
      subtotal = subtotal.add(lineTotal);
      return {
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount || 0,
        lineTotal,
      };
    });

    const order = await this.prisma.saleOrder.create({
      data: {
        orderNo,
        customerId: data.customerId,
        channel: data.channel,
        currency: data.currency,
        status: 'DRAFT',
        subtotal,
        discount: 0,
        total: subtotal,
        outstanding: subtotal,
        createdBy: actorId,
        items: { create: itemsData },
      },
      include: { items: true, customer: true },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'SaleOrder',
      entityId: order.id,
      afterJson: order,
    });

    return { data: order };
  }

  async confirmOrder(id: string, actorId: string, version: number) {
    // Transactional FIFO allocation
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.saleOrder.findUnique({
        where: { id },
        include: { items: { include: { product: true } } },
      });
      if (!order) throw new NotFoundException('Order not found');
      if (order.status !== 'DRAFT')
        throw new BadRequestException('Only draft orders can be confirmed');
      if (order.version !== version)
        throw new ConflictException('Version conflict — order was modified');

      const allocations: any[] = [];
      let totalCogs = new Prisma.Decimal(0);

      for (const item of order.items) {
        let remainingQty = Number(item.quantity);

        // FIFO: get verified, saleable batches ordered by received date ASC
        const batches = await tx.inventoryBatch.findMany({
          where: {
            productId: item.productId,
            verificationStatus: 'VERIFIED',
            saleableQty: { gt: 0 },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });

        for (const batch of batches) {
          if (remainingQty <= 0) break;
          const available = Number(batch.saleableQty);
          const allocQty = Math.min(remainingQty, available);

          if (allocQty <= 0) continue;

          // Update batch: reduce saleable, increase reserved
          await tx.inventoryBatch.update({
            where: { id: batch.id },
            data: {
              saleableQty: { decrement: allocQty },
              reservedQty: { increment: allocQty },
            },
          });

          // Create movement
          await tx.inventoryMovement.create({
            data: {
              batchId: batch.id,
              movementType: 'RESERVE',
              qtyDelta: -allocQty,
              referenceType: 'SALE_ORDER',
              referenceId: id,
              createdBy: actorId,
            },
          });

          const unitCost = Number(batch.landedUnitCostEgp);
          const cogs = allocQty * unitCost;
          totalCogs = totalCogs.add(cogs);

          // Create allocation
          const allocation = await tx.saleItemAllocation.create({
            data: {
              saleItemId: item.id,
              inventoryBatchId: batch.id,
              qty: allocQty,
              unitCostEgp: unitCost,
              cogsEgp: cogs,
            },
          });

          allocations.push(allocation);
          remainingQty -= allocQty;
        }

        if (remainingQty > 0) {
          throw new BadRequestException(
            `Insufficient stock for ${item.product.name}. Missing: ${remainingQty}`,
          );
        }
      }

      // Update order status
      const updatedOrder = await tx.saleOrder.update({
        where: { id, version },
        data: { status: 'CONFIRMED', version: { increment: 1 } },
        include: { items: true },
      });

      // Auto-create financial transaction for sale revenue
      // Note: cycleId omitted because a sale may span inventory from multiple cycles
      await tx.financialTransaction.create({
        data: {
          type: 'SALE_REVENUE',
          category: 'revenue',
          direction: 'INFLOW',
          amount: Number(order.total),
          currency: order.currency,
          relatedType: 'SALE_ORDER',
          relatedId: id,
          reason: `Auto: Sale order ${order.orderNo} confirmed (${order.channel})`,
          createdBy: actorId,
        },
      });

      await this.audit.log({
        actorUserId: actorId,
        action: 'CONFIRM',
        entityType: 'SaleOrder',
        entityId: id,
        beforeJson: { status: 'DRAFT' },
        afterJson: { status: 'CONFIRMED', cogs: Number(totalCogs) },
      });

      return {
        data: {
          ...updatedOrder,
          allocations,
          totalCogs: Number(totalCogs),
        },
      };
    });
  }

  async cancelOrder(id: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.saleOrder.findUnique({
        where: { id },
        include: { items: { include: { allocations: true } } },
      });
      if (!order) throw new NotFoundException('Order not found');
      if (
        order.status === 'CANCELLED' ||
        order.status === 'RETURNED'
      ) {
        throw new BadRequestException(
          'Order is already cancelled/returned',
        );
      }

      // Release any reservations/allocations
      for (const item of order.items) {
        for (const alloc of item.allocations) {
          // Restore batch quantities
          await tx.inventoryBatch.update({
            where: { id: alloc.inventoryBatchId },
            data: {
              saleableQty: { increment: Number(alloc.qty) },
              reservedQty: { decrement: Number(alloc.qty) },
            },
          });

          // Create release movement
          await tx.inventoryMovement.create({
            data: {
              batchId: alloc.inventoryBatchId,
              movementType: 'RELEASE',
              qtyDelta: Number(alloc.qty),
              referenceType: 'SALE_ORDER_CANCEL',
              referenceId: id,
              createdBy: actorId,
            },
          });
        }
      }

      const updated = await tx.saleOrder.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });

      await this.audit.log({
        actorUserId: actorId,
        action: 'CANCEL',
        entityType: 'SaleOrder',
        entityId: id,
        beforeJson: { status: order.status },
        afterJson: { status: 'CANCELLED' },
      });

      return { data: updated };
    });
  }
}
