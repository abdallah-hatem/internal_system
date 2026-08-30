import { pageSize } from '../../common/dto/pagination.dto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { nextReferenceNumber, pad } from '../../common/references';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '@prisma/client';

import { badRequest, conflict, notFound } from '../../common/api-error';
import { assertVerified } from '../../common/verified-customer';
import { availableQty } from '../../common/available-stock';
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
    const { cursor, limit: rawLimit = 20, customerId, status, channel } = pagination;
    const limit = pageSize(rawLimit);
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
    if (!order) throw notFound('saleOrder');
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
      throw badRequest('CUSTOMER_REQUIRED', 'customerId is required');
    }
    const customer = await this.prisma.customer.findUnique({
      where: { id: data.customerId },
    });
    if (!customer) {
      throw notFound('customer');
    }
    assertVerified(customer);

    // Validate items array
    if (!data.items || data.items.length === 0) {
      throw badRequest('ORDER_NEEDS_ITEM', 'Order must contain at least one item');
    }

    // What can be sold right now, from the one definition of it.
    //
    // This was a local aggregate over saleable quantity, which was correct
    // while `InventoryReservation` sat unused. The storefront now lets a shop
    // hold stock while the owner decides, and a local copy here would have gone
    // on selling the held units — the storefront and the office disagreeing
    // about the same shelf, which shows up as a wrong figure on one screen and
    // a right one on the other. `availableQty` subtracts live holds and is read
    // by the catalogue, the request flow and this, all three.
    const availableFor = (productId: string) => availableQty(this.prisma, productId);

    // Summed per product, not checked line by line: two lines of 40 against 60
    // in stock is 80, and checking each alone would wave it through.
    const wantedPerProduct = new Map<string, Prisma.Decimal>();
    for (const item of data.items) {
      if (!item.productId || !item.quantity) continue;
      const soFar = wantedPerProduct.get(item.productId) ?? new Prisma.Decimal(0);
      wantedPerProduct.set(item.productId, soFar.add(item.quantity));
    }

    // Validate each item
    for (const item of data.items) {
      if (!item.productId) {
        throw badRequest('ITEM_NEEDS_PRODUCT', 'Each item must have a productId');
      }
      const product = await this.prisma.product.findUnique({
        where: { id: item.productId },
      });
      if (!product) {
        throw notFound('product');
      }
      if (!item.quantity || item.quantity <= 0) {
        throw badRequest('QTY_NOT_POSITIVE', `Invalid quantity for product ${item.productId}: must be greater than 0`);
      }
      if (item.unitPrice == null || item.unitPrice < 0) {
        throw badRequest('PRICE_NEGATIVE', `Invalid unitPrice for product ${item.productId}: must be 0 or greater`);
      }
    }

    // You cannot sell what is not there — and you should be told now, not at
    // the end. Only confirming checked this, so an order for 600 against 60 in
    // stock was built, priced and saved before anything objected.
    for (const [productId, wanted] of wantedPerProduct) {
      const available = await availableFor(productId);
      if (wanted.gt(available)) {
        const product = await this.prisma.product.findUnique({
          where: { id: productId },
          select: { name: true },
        });
        throw badRequest(
          'NOT_ENOUGH_STOCK',
          `Only ${available.toFixed(3)} of ${product?.name ?? 'that product'} ` +
            `is in stock, so ${wanted.toFixed(3)} cannot be sold.`,
          {
            available: available.toFixed(3),
            product: product?.name ?? 'that product',
            wanted: wanted.toFixed(3),
          },
        );
      }
    }

    // Generate order number: ORD-YYYY-XXXXX
    const year = new Date().getFullYear();
    const last = await this.prisma.saleOrder.findFirst({
      where: { orderNo: { startsWith: `ORD-${year}` } },
      orderBy: { orderNo: 'desc' },
      select: { orderNo: true },
    });
    const orderNo = `ORD-${year}-${pad(nextReferenceNumber(last?.orderNo, 5), 5)}`;

    // Calculate totals using Decimal arithmetic
    let subtotal = new Prisma.Decimal(0);
    const itemsData = data.items.map((item) => {
      const gross = item.unitPrice * item.quantity;
      const discount = item.discount || 0;

      // A discount cannot exceed what the line is worth. Without this the line
      // went negative and took the order with it: a 100 line discounted by
      // 9,999 produced an order totalling -9,899 — a sale that owes money to
      // the customer, and one that would have been counted as revenue.
      if (discount > gross) {
        throw badRequest(
          'DISCOUNT_EXCEEDS_LINE',
          `Discount ${discount.toFixed(2)} is more than the line is worth (${gross.toFixed(2)}).`,
          { discount: discount.toFixed(2), gross: gross.toFixed(2) },
        );
      }

      const lineTotal = gross - discount;
      subtotal = subtotal.add(lineTotal);
      return {
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount,
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
      if (!order) throw notFound('order');
      if (order.status !== 'DRAFT')
        throw badRequest('ONLY_DRAFT_CONFIRMABLE', 'Only draft orders can be confirmed');
      if (order.version !== version)
        throw conflict('ORDER_VERSION_CONFLICT', 'Version conflict — order was modified');

      const allocations: any[] = [];
      let totalCogs = new Prisma.Decimal(0);

      for (const item of order.items) {
        // Quantities and costs stay in Decimal: this COGS is written to the
        // allocation and is what cycle profit is later calculated from, so a
        // float rounding drift here would quietly misstate every settlement.
        let remainingQty = new Prisma.Decimal(item.quantity);

        // FIFO: oldest verified receipt first, batch id breaking any tie.
        const batches = await tx.inventoryBatch.findMany({
          where: {
            productId: item.productId,
            verificationStatus: 'VERIFIED',
            saleableQty: { gt: 0 },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });

        for (const batch of batches) {
          if (remainingQty.lte(0)) break;
          const available = new Prisma.Decimal(batch.saleableQty);
          const allocQty = Prisma.Decimal.min(remainingQty, available);

          if (allocQty.lte(0)) continue;

          // Confirming is the point the goods leave: these are counter sales
          // to shops and marketplace sales, with no separate dispatch step.
          //
          // remainingQty is what is physically in the room and must fall too.
          // Previously only saleable moved to reserved, so remainingQty never
          // dropped and nothing ever released the reservation — inventory
          // value and unsold-stock-at-close were overstated by everything ever
          // sold, and a returned unit could push a batch above the quantity
          // that arrived.
          await tx.inventoryBatch.update({
            where: { id: batch.id },
            data: {
              saleableQty: { decrement: allocQty },
              remainingQty: { decrement: allocQty },
            },
          });

          // Create movement
          await tx.inventoryMovement.create({
            data: {
              batchId: batch.id,
              movementType: 'SALE',
              qtyDelta: allocQty.neg(),
              referenceType: 'SALE_ORDER',
              referenceId: id,
              createdBy: actorId,
            },
          });

          const unitCost = new Prisma.Decimal(batch.landedUnitCostEgp);
          const cogs = allocQty.mul(unitCost).toDecimalPlaces(2);
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
          remainingQty = remainingQty.sub(allocQty);
        }

        if (remainingQty.gt(0)) {
          throw badRequest(
            'INSUFFICIENT_STOCK',
            `Insufficient stock for ${item.product.name}. Missing: ${remainingQty.toFixed(3)}`,
            { product: item.product.name, missing: remainingQty.toFixed(3) },
          );
        }
      }

      // Update order status
      const updatedOrder = await tx.saleOrder.update({
        where: { id, version },
        data: { status: 'CONFIRMED', version: { increment: 1 } },
        include: { items: true },
      });

      // No ledger entry is raised here, deliberately.
      //
      // Confirming a sale is not the arrival of money — the shop takes the
      // goods and pays later, often over weeks. Booking revenue here as well
      // as on each payment counted the same sale twice: 31,200 of orders
      // produced 72,710 of ledger revenue.
      //
      // DECIDED 2026-08-22: the ledger records money as it is received. The
      // sale itself is not lost — the order records it, and what has been sold
      // but not yet collected is reported as receivables, which is the gap
      // between the two.

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
      if (!order) throw notFound('order');
      if (
        order.status === 'CANCELLED' ||
        order.status === 'RETURNED'
      ) {
        throw badRequest(
          'ORDER_ALREADY_CLOSED',
          'Order is already cancelled/returned',
        );
      }

      // DECIDED 2026-08-23: an order that has been paid against cannot be
      // cancelled.
      //
      // Cancelling put the stock back and marked the order dead, and did
      // nothing at all about the money. The allocation stayed pointing at the
      // cancelled order: it cleared nothing, could not be applied anywhere
      // else, and still read as collected — the order vanished from what the
      // shop owed while their payment stayed spent on it.
      //
      // Money coming back is a refund, and a refund is a return: goods, cost
      // and cash all move together there. Cancelling is for an order that
      // never happened.
      const paid = await tx.paymentAllocation.aggregate({
        where: { saleOrderId: id },
        _sum: { amount: true },
      });
      const paidAmount = Number(paid._sum.amount ?? 0);
      if (paidAmount > 0) {
        throw badRequest(
          'ORDER_PAID_CANNOT_CANCEL',
          `${paidAmount.toFixed(2)} has already been paid against ${order.orderNo}, ` +
            'so it cannot be cancelled. Record a return instead, which refunds the ' +
            'money and puts the stock back.',
          { paid: paidAmount.toFixed(2), order: order.orderNo },
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
              remainingQty: { increment: Number(alloc.qty) },
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
