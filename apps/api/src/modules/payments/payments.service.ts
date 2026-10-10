import { pageSize, cursorPage } from '../../common/dto/pagination.dto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertNotFuture, calendarRange } from '../../common/dates';
import { AuditService } from '../audit/audit.service';

import { badRequest, notFound } from '../../common/api-error';
import { assertVerified } from '../../common/verified-customer';
import { OWED_STATUSES, owedBy } from '../../common/customer-balance';
import type { Prisma } from '@prisma/client';

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll(pagination: {
    cursor?: string;
    limit?: number;
    customerId?: string;
    /** Calendar days, YYYY-MM-DD, both included, on the day it was received. */
    from?: string;
    to?: string;
  }) {
    const { cursor, limit: rawLimit = 20, customerId, from, to } = pagination;
    const limit = pageSize(rawLimit);
    const received = calendarRange(from, to);
    const where: any = {
      ...(customerId ? { customerId } : {}),
      ...(received ? { receivedOn: received } : {}),
    };

    const items = await this.prisma.payment.findMany({
      where,
      ...cursorPage(cursor, limit),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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

  /**
   * Record a payment — on a chosen order, or unallocated.
   *
   * With `orderId` (BUSINESS_LOGIC §7, DECIDED 2026-10-10) the money goes on
   * that order: the payment, its ledger row and the allocation are written in
   * one transaction, through the same `allocateWithin` the Allocate action
   * uses, so a refusal leaves nothing behind — no payment collected against
   * nobody. Without it, the payment is recorded as before and the caller puts
   * it on the oldest orders first.
   */
  async create(
    data: {
      customerId: string;
      amount: number;
      currency: string;
      receivedOn?: string;
      method?: string;
      reference?: string;
      orderId?: string;
    },
    actorId: string,
    idempotencyKey?: string,
  ) {
    // A repeated key answers with the payment it already made, before any
    // check runs: the first one may have cleared the order, and a retry must
    // not be told "nothing is owed" about money it already recorded.
    if (idempotencyKey) {
      const existing = await this.prisma.payment.findFirst({
        where: { reference: idempotencyKey },
      });
      if (existing) return { data: existing };
    }

    // The DTO checks this too; repeated because the service is also reached
    // without the pipe, and a zero allocated to an order would be a row that
    // says money moved when none did.
    if (!(Number(data.amount) > 0)) {
      throw badRequest(
        'AMOUNT_NOT_POSITIVE',
        'A payment must be more than zero.',
      );
    }

    assertNotFuture(data.receivedOn, 'PAYMENT_RECEIVED');

    // The customer must exist. Without this the foreign key failed deep in
    // Prisma and surfaced as a 500 "An unexpected error occurred", which tells
    // whoever typed the id nothing at all.
    const customer = await this.prisma.customer.findUnique({
      where: { id: data.customerId },
      select: { id: true, displayName: true, verificationStatus: true },
    });
    if (!customer) throw notFound('customer');
    assertVerified(customer);

    // A shop cannot pay more than it owes. Taking 500 against a 300 balance
    // leaves 200 attached to nobody: it clears no order, shows as paid, and
    // quietly overstates what has been collected. In practice it is a typo,
    // and the moment to catch a typo is before it is written down.
    //
    // On a chosen order the order's own cap is the tighter one, checked in
    // `allocateWithin`, so its refusal names the order rather than the shop.
    if (!data.orderId) {
      const owed = Number(await owedBy(this.prisma, data.customerId));
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
              {
                customer: customer.displayName,
                owed: owed.toFixed(2),
                amount: Number(data.amount).toFixed(2),
              },
            );
      }
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
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

      // The ledger records money as it is received (§9).
      await tx.financialTransaction.create({
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

      const allocated = data.orderId
        ? await this.allocateWithin(
            tx,
            payment,
            data.orderId,
            Number(data.amount),
            { chosenByPayer: true },
          )
        : null;

      return { payment, allocated };
    });

    // Audit rows after the commit — see `allocateToOrder` for why.
    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'Payment',
      entityId: outcome.payment.id,
      afterJson: outcome.payment,
    });
    if (outcome.allocated) {
      await this.audit.log({
        actorUserId: actorId,
        action: 'ALLOCATE',
        entityType: 'Payment',
        entityId: outcome.payment.id,
        afterJson: outcome.allocated.audit,
      });
    }

    return { data: outcome.payment };
  }

  async allocateToOrder(
    paymentId: string,
    saleOrderId: string,
    amount: number,
    actorId: string,
  ) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
      });
      if (!payment) throw notFound('payment');
      return this.allocateWithin(tx, payment, saleOrderId, amount, {
        chosenByPayer: false,
      });
    });

    // The audit row is written after the commit. `this.audit` uses the outer
    // client, and `connection_limit: 1` means a transaction holds the only
    // connection there is — an audit write from inside waits for one that
    // cannot arrive until the transaction ends, and the transaction cannot
    // end until it returns. P2028 at exactly the ceiling, every time.
    await this.audit.log({
      actorUserId: actorId,
      action: 'ALLOCATE',
      entityType: 'Payment',
      entityId: paymentId,
      afterJson: outcome.audit,
    });
    return { data: outcome.data };
  }

  /**
   * Put part of a payment on one order — the one definition of it.
   *
   * The Allocate action and a payment recorded on a chosen order both come
   * through here, inside a transaction the caller owns, so a rule added here
   * cannot be skipped by choosing the other screen.
   *
   * `chosenByPayer` is the record-on-an-order path. It differs only in how two
   * refusals read: someone else's order is "not found" (the order is picked
   * from this shop's own orders, so another shop's id is not one it can see),
   * and too much names the order's figure (`PAYMENT_EXCEEDS_ORDER`).
   */
  private async allocateWithin(
    tx: Prisma.TransactionClient,
    payment: {
      id: string;
      customerId: string;
      amount: Prisma.Decimal | number;
      status: string;
    },
    saleOrderId: string,
    amount: number,
    { chosenByPayer }: { chosenByPayer: boolean },
  ) {
    if (payment.status !== 'RECORDED')
      throw badRequest(
        'PAYMENT_FULLY_ALLOCATED',
        'Payment already fully allocated or reversed',
      );

    // Check total allocations don't exceed payment
    const existingAllocations = await tx.paymentAllocation.aggregate({
      where: { paymentId: payment.id },
      _sum: { amount: true },
    });
    const totalAllocated = Number(existingAllocations._sum.amount || 0);
    if (totalAllocated + amount > Number(payment.amount)) {
      throw badRequest(
        'ALLOCATION_EXCEEDS_PAYMENT',
        `Cannot allocate ${amount}. Payment has ${Number(payment.amount) - totalAllocated} remaining`,
        {
          amount: String(amount),
          remaining: Number(payment.amount) - totalAllocated,
        },
      );
    }

    const order = await tx.saleOrder.findUnique({
      where: { id: saleOrderId },
    });
    if (!order) throw notFound('saleOrder');

    // The order must belong to whoever paid. Nothing checked this, and the
    // allocate picker offered every order in the system by number, so one
    // shop's money could clear another shop's debt — leaving both balances
    // wrong and no sign of it anywhere.
    if (order.customerId !== payment.customerId) {
      if (chosenByPayer) throw notFound('saleOrder');
      throw badRequest(
        'ORDER_OTHER_CUSTOMER',
        `Order ${order.orderNo} belongs to a different customer than this payment.`,
        { order: order.orderNo },
      );
    }

    // Only a confirmed order owes anything (§4, §7a). A draft is not a sale
    // yet; a cancelled, returned or paid order owes nothing any more.
    if (order.status === 'DRAFT') {
      throw badRequest(
        'ORDER_NOT_CONFIRMED',
        `Order ${order.orderNo} is a draft, so it owes nothing yet.`,
        { order: order.orderNo },
      );
    }
    const outstanding = Number(order.outstanding);
    if (
      !(OWED_STATUSES as readonly string[]).includes(order.status) ||
      outstanding <= 0
    ) {
      throw badRequest(
        'ORDER_OWES_NOTHING',
        `Order ${order.orderNo} owes nothing, so nothing can be paid on it.`,
        { order: order.orderNo },
      );
    }

    // The order's outstanding is already net of returns: a credit note lowers
    // it when the return is recorded (§5), so this cap is what it really owes.
    if (amount > outstanding) {
      throw chosenByPayer
        ? badRequest(
            'PAYMENT_EXCEEDS_ORDER',
            `Order ${order.orderNo} owes ${outstanding.toFixed(2)}, so ${amount.toFixed(2)} cannot be paid on it.`,
            {
              order: order.orderNo,
              owed: outstanding.toFixed(2),
              asked: amount.toFixed(2),
            },
          )
        : badRequest(
            'ALLOCATION_EXCEEDS_OUTSTANDING',
            `Order outstanding is ${outstanding.toFixed(2)}, cannot allocate ${amount}`,
            { outstanding: outstanding.toFixed(2), amount: String(amount) },
          );
    }

    const allocation = await tx.paymentAllocation.create({
      data: { paymentId: payment.id, saleOrderId, amount },
    });

    const newOutstanding = outstanding - amount;
    const newStatus = newOutstanding <= 0 ? 'PAID' : 'PARTIALLY_PAID';
    await tx.saleOrder.update({
      where: { id: saleOrderId },
      data: {
        outstanding: newOutstanding,
        status: newStatus,
        version: { increment: 1 },
      },
    });

    return {
      audit: { saleOrderId, amount, newOutstanding },
      data: allocation,
    };
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
