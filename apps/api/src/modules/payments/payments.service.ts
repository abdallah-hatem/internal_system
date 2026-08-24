import { pageSize } from '../../common/dto/pagination.dto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertNotFuture } from '../../common/dates';
import { AuditService } from '../audit/audit.service';

import { badRequest, notFound } from '../../common/api-error';
/** Orders whose balance is genuinely outstanding; a draft owes nothing yet. */
const OWED_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID'] as const;

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll(pagination: { cursor?: string; limit?: number; customerId?: string }) {
    const { cursor, limit: rawLimit = 20, customerId } = pagination;
    const limit = pageSize(rawLimit);
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
    if (!payment) throw notFound('payment');
    return { data: payment };
  }

  async create(
    data: {
      customerId: string;
      amount: number;
      currency: string;
      receivedOn?: string;
      method?: string;
      reference?: string;
    },
    actorId: string,
    idempotencyKey?: string,
  ) {
    assertNotFuture(data.receivedOn, 'The date a payment was received');

    // The customer must exist. Without this the foreign key failed deep in
    // Prisma and surfaced as a 500 "An unexpected error occurred", which tells
    // whoever typed the id nothing at all.
    const customer = await this.prisma.customer.findUnique({
      where: { id: data.customerId },
      select: { id: true, displayName: true },
    });
    if (!customer) throw notFound('customer');

    // A shop cannot pay more than it owes. Taking 500 against a 300 balance
    // leaves 200 attached to nobody: it clears no order, shows as paid, and
    // quietly overstates what has been collected. In practice it is a typo,
    // and the moment to catch a typo is before it is written down.
    const owedAgg = await this.prisma.saleOrder.aggregate({
      where: { customerId: data.customerId, status: { in: [...OWED_STATUSES] } },
      _sum: { outstanding: true },
    });
    const owed = Number(owedAgg._sum?.outstanding ?? 0);
    if (data.amount > owed) {
      throw owed <= 0
        ? badRequest(
            'CUSTOMER_OWES_NOTHING',
            `${customer.displayName} does not owe anything, so there is nothing to pay.`,
            { customer: customer.displayName },
          )
        : badRequest(
            'PAYMENT_EXCEEDS_OWED',
            `${customer.displayName} owes ${owed.toFixed(2)}, so ${Number(data.amount).toFixed(2)} cannot be received against it.`,
            { customer: customer.displayName, owed: owed.toFixed(2), amount: Number(data.amount).toFixed(2) },
          );
    }

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
        // A payment with no stated date is one received today; without this
        // an omitted value became an Invalid Date and Prisma rejected the
        // write as an opaque 500.
        receivedOn: data.receivedOn ? new Date(data.receivedOn) : new Date(),
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
      if (!payment) throw notFound('payment');
      if (payment.status !== 'RECORDED')
        throw badRequest(
          'PAYMENT_FULLY_ALLOCATED',
          'Payment already fully allocated or reversed',
        );

      // Check total allocations don't exceed payment
      const existingAllocations = await tx.paymentAllocation.aggregate({
        where: { paymentId },
        _sum: { amount: true },
      });
      const totalAllocated = Number(existingAllocations._sum.amount || 0);
      if (totalAllocated + amount > Number(payment.amount)) {
        throw badRequest(
          'ALLOCATION_EXCEEDS_PAYMENT',
          `Cannot allocate ${amount}. Payment has ${Number(payment.amount) - totalAllocated} remaining`,
          { amount: String(amount), remaining: Number(payment.amount) - totalAllocated },
        );
      }

      // Check order outstanding
      const order = await tx.saleOrder.findUnique({
        where: { id: saleOrderId },
      });
      if (!order) throw notFound('order');

      // The order must belong to whoever paid. Nothing checked this, and the
      // allocate picker offered every order in the system by number, so one
      // shop's money could clear another shop's debt — leaving both balances
      // wrong and no sign of it anywhere.
      if (order.customerId !== payment.customerId) {
        throw badRequest(
          'ORDER_OTHER_CUSTOMER',
          `Order ${order.orderNo} belongs to a different customer than this payment.`,
          { order: order.orderNo },
        );
      }

      if (Number(order.outstanding) < amount) {
        throw badRequest(
          'ALLOCATION_EXCEEDS_OUTSTANDING',
          `Order outstanding is ${order.outstanding}, cannot allocate ${amount}`,
          { outstanding: String(order.outstanding), amount: String(amount) },
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
    if (!payment) throw notFound('payment');

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
