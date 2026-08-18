import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll(pagination: { cursor?: string; limit?: number; customerId?: string }) {
    const { cursor, limit = 20, customerId } = pagination;
    const where: any = {};
    if (customerId) where.customerId = customerId;

    const items = await this.prisma.payment.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { customer: true, allocations: true },
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
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: {
        customer: true,
        allocations: { include: { saleOrder: true } },
      },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return { data: payment };
  }

  async create(
    data: {
      customerId: string;
      amount: number;
      currency: string;
      receivedOn: string;
      method?: string;
      reference?: string;
    },
    actorId: string,
    idempotencyKey?: string,
  ) {
    // Check idempotency
    if (idempotencyKey) {
      const existing = await this.prisma.payment.findFirst({
        where: { reference: idempotencyKey },
      });
      if (existing) return { data: existing };
    }

    const payment = await this.prisma.payment.create({
      data: {
        customerId: data.customerId,
        amount: data.amount,
        currency: data.currency,
        receivedOn: new Date(data.receivedOn),
        method: data.method,
        reference: data.reference || idempotencyKey,
        status: 'RECORDED',
        createdBy: actorId,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'Payment',
      entityId: payment.id,
      afterJson: payment,
    });

    // Auto-create financial transaction for incoming payment
    await this.prisma.financialTransaction.create({
      data: {
        type: 'PAYMENT_RECEIVED',
        category: 'revenue',
        direction: 'INFLOW',
        amount: data.amount,
        currency: data.currency,
        relatedType: 'PAYMENT',
        relatedId: payment.id,
        reason: `Auto: Payment received from customer ${data.customerId}${data.method ? ` via ${data.method}` : ''}`,
        createdBy: actorId,
      },
    });

    return { data: payment };
  }

  async allocateToOrder(
    paymentId: string,
    saleOrderId: string,
    amount: number,
    actorId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
      });
      if (!payment) throw new NotFoundException('Payment not found');
      if (payment.status !== 'RECORDED')
        throw new BadRequestException(
          'Payment already fully allocated or reversed',
        );

      // Check total allocations don't exceed payment
      const existingAllocations = await tx.paymentAllocation.aggregate({
        where: { paymentId },
        _sum: { amount: true },
      });
      const totalAllocated = Number(existingAllocations._sum.amount || 0);
      if (totalAllocated + amount > Number(payment.amount)) {
        throw new BadRequestException(
          `Cannot allocate ${amount}. Payment has ${Number(payment.amount) - totalAllocated} remaining`,
        );
      }

      // Check order outstanding
      const order = await tx.saleOrder.findUnique({
        where: { id: saleOrderId },
      });
      if (!order) throw new NotFoundException('Order not found');
      if (Number(order.outstanding) < amount) {
        throw new BadRequestException(
          `Order outstanding is ${order.outstanding}, cannot allocate ${amount}`,
        );
      }

      // Create allocation
      const allocation = await tx.paymentAllocation.create({
        data: { paymentId, saleOrderId, amount },
      });

      // Update order outstanding and status
      const newOutstanding = Number(order.outstanding) - amount;
      const newStatus = newOutstanding <= 0 ? 'PAID' : 'PARTIALLY_PAID';
      await tx.saleOrder.update({
        where: { id: saleOrderId },
        data: {
          outstanding: newOutstanding,
          status: newStatus,
          version: { increment: 1 },
        },
      });

      await this.audit.log({
        actorUserId: actorId,
        action: 'ALLOCATE',
        entityType: 'Payment',
        entityId: paymentId,
        afterJson: { saleOrderId, amount, newOutstanding },
      });

      return { data: allocation };
    });
  }

  async reverse(id: string, reason: string, actorId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: { allocations: true },
    });
    if (!payment) throw new NotFoundException('Payment not found');

    // Reverse allocations
    for (const alloc of payment.allocations) {
      const order = await this.prisma.saleOrder.findUnique({
        where: { id: alloc.saleOrderId },
      });
      if (order) {
        await this.prisma.saleOrder.update({
          where: { id: alloc.saleOrderId },
          data: {
            outstanding: { increment: Number(alloc.amount) },
            status: 'PARTIALLY_PAID',
            version: { increment: 1 },
          },
        });
      }
    }

    await this.prisma.payment.update({
      where: { id },
      data: { status: 'REVERSED', version: { increment: 1 } },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'REVERSE',
      entityType: 'Payment',
      entityId: id,
      afterJson: { reason },
    });

    return { data: { success: true } };
  }
}
