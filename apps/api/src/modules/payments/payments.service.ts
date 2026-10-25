import { pageSize, cursorPage } from '../../common/dto/pagination.dto';
import { NotificationsService } from '../notifications/notifications.service';
import {
  paymentNews,
  reversalNews,
  tellOtherPartners,
  type PartnerNotifier,
} from '../../common/partner-news';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertNotFuture,
  businessDay,
  businessToday,
  calendarRange,
  endOfBusinessDay,
} from '../../common/dates';
import { AuditService } from '../audit/audit.service';

import { badRequest, notFound } from '../../common/api-error';
import { assertVerified } from '../../common/verified-customer';
import { OWED_STATUSES, owedBy } from '../../common/customer-balance';
import { owedByOneBranch } from '../../common/customer-branches';
import { isUuid } from '../../common/uuid';
import { isSamplesStatus } from '../../common/samples';
import type { Prisma } from '@prisma/client';

/** A payment's day: `receivedOn` is a date column, UTC midnight of the day. */
const paymentDay = (receivedOn: Date) => receivedOn.toISOString().slice(0, 10);

/**
 * Money cannot pay for a sale that had not happened yet (BUSINESS_LOGIC §7a,
 * 2026-10-16): with sales dated in the past, a payment received on the 3rd
 * against an order made on the 10th would say the shop paid before it bought.
 */
function paymentBeforeOrder(
  order: { orderNo: string; orderedAt: Date },
  receivedOn: Date,
) {
  const orderedOn = businessDay(order.orderedAt);
  const received = paymentDay(receivedOn);
  return badRequest(
    'PAYMENT_BEFORE_ORDER',
    `A payment received on ${received} cannot pay ${order.orderNo}, which was sold on ${orderedOn}.`,
    { order: order.orderNo, orderedOn, receivedOn: received },
  );
}

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    /**
     * A payment recorded or reversed is told to the other partners (owner
     * 2026-10-25). Optional: a preview's own service tells nobody.
     */
    @Optional()
    @Inject(NotificationsService)
    private notifications?: PartnerNotifier,
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
      /**
       * Without `orderId`: put the money on the shop's unpaid orders, oldest
       * first, in the same transaction (§7). The one definition of "oldest
       * first" — the Record payment dialog and the assistant both ask for it.
       */
      applyOldestFirst?: boolean;
      /** One branch's orders only (§7, 2026-10-25), oldest first. */
      branchId?: string;
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
    // To one branch (§7, 2026-10-25): capped by what that branch owes, and
    // put on its own orders oldest first. Checked before the shop's cap,
    // which it can only be tighter than.
    const branch = data.branchId
      ? await this.payingBranch(data.customerId, data.branchId, data.orderId)
      : null;
    if (branch) {
      const owed = Number(
        await owedByOneBranch(this.prisma, data.customerId, branch.id),
      );
      if (data.amount > owed) {
        throw owed <= 0
          ? badRequest(
              'BRANCH_OWES_NOTHING',
              `The branch ${branch.name} does not owe anything, so there is nothing to pay.`,
              { branch: branch.name },
            )
          : badRequest(
              'PAYMENT_EXCEEDS_BRANCH_OWED',
              `The branch ${branch.name} owes ${owed.toFixed(2)}, so ${Number(data.amount).toFixed(2)} cannot be received against it.`,
              {
                branch: branch.name,
                owed: owed.toFixed(2),
                amount: Number(data.amount).toFixed(2),
              },
            );
      }
    }
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

    const outcome = await this.prisma.$transaction((tx) =>
      this.recordWithin(
        tx,
        {
          customerId: data.customerId,
          amount: data.amount,
          currency: data.currency,
          // A payment with no stated date is one received today; without this
          // an omitted value became an Invalid Date and Prisma rejected the
          // write as an opaque 500.
          //
          // Today where the business is (§7a), not the UTC day: `new Date()`
          // stored in a date column keeps the UTC date, so a payment taken at
          // 00:30 in Cairo landed on yesterday. The walk-in sale dates its
          // payment the same way.
          receivedOn: new Date(data.receivedOn || businessToday()),
          method: data.method,
          reference: data.reference || idempotencyKey,
          orderId: data.orderId,
          // Paying one branch is always oldest first on its orders: money
          // said to be for a branch and left on no order would be for nobody.
          applyOldestFirst:
            !data.orderId && (!!branch || data.applyOldestFirst === true),
          branchId: branch?.id,
        },
        actorId,
      ),
    );

    // Audit rows after the commit — see `allocateToOrder` for why.
    await this.logRecorded(outcome, actorId);
    await this.announcePayment(outcome.payment.id, actorId);

    return { data: outcome.payment };
  }

  /** A payment recorded, told to the other partners, read back after the commit. */
  private async announcePayment(paymentId: string, actorId: string) {
    await tellOtherPartners(
      this.prisma,
      this.notifications,
      actorId,
      async () => {
        const payment = await this.prisma.payment.findUnique({
          where: { id: paymentId },
          select: {
            id: true,
            amount: true,
            method: true,
            customerId: true,
            customer: { select: { displayName: true } },
            allocations: {
              select: { saleOrder: { select: { orderNo: true } } },
            },
          },
        });
        return (
          payment &&
          paymentNews({
            id: payment.id,
            amount: payment.amount,
            method: payment.method,
            customerId: payment.customerId,
            shop: payment.customer.displayName,
            orders: payment.allocations.map((a) => a.saleOrder.orderNo),
          })
        );
      },
    );
  }

  /**
   * Money arriving, inside a transaction the caller owns: the payment, its
   * ledger INFLOW (§9) and, with `orderId`, its allocation through
   * `allocateWithin`. The one definition of what receiving money writes —
   * `create` and the walk-in sale (`SalesService`, §4) both come through here.
   *
   * The caller has already run its own checks (owed, dated, verified); the
   * order's own cap is checked by `allocateWithin`.
   */
  async recordWithin(
    tx: Prisma.TransactionClient,
    data: {
      customerId: string;
      amount: number;
      currency: string;
      receivedOn: Date;
      method?: string;
      reference?: string;
      orderId?: string;
      applyOldestFirst?: boolean;
      branchId?: string;
    },
    actorId: string,
  ) {
    const payment = await tx.payment.create({
      data: {
        customerId: data.customerId,
        amount: data.amount,
        currency: data.currency,
        receivedOn: data.receivedOn,
        method: data.method,
        reference: data.reference,
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

    const allocated: { audit: unknown }[] = [];
    if (data.orderId) {
      allocated.push(
        await this.allocateWithin(
          tx,
          payment,
          data.orderId,
          Number(data.amount),
          { chosenByPayer: true },
        ),
      );
    } else if (data.applyOldestFirst) {
      allocated.push(
        ...(await this.allocateOldestFirst(
          tx,
          payment,
          Number(data.amount),
          data.branchId,
        )),
      );
    }

    return { payment, allocated };
  }

  /**
   * Oldest unpaid orders first — what a shop paying down its balance expects,
   * and the order the instalment logic already applies money in (§7). Each
   * piece goes through `allocateWithin`, so every cap and ownership check
   * still applies; the caller's transaction makes it all or nothing.
   *
   * What is left after every open order is cleared stays on the payment
   * unapplied. The owed check before the transaction makes that unreachable
   * from `create`; it is not invented here as credit (§7a).
   */
  private async allocateOldestFirst(
    tx: Prisma.TransactionClient,
    payment: {
      id: string;
      customerId: string;
      amount: Prisma.Decimal | number;
      status: string;
      receivedOn: Date;
    },
    amount: number,
    /** Only this branch's orders (§7, 2026-10-25). */
    branchId?: string,
  ) {
    // Oldest means sold first — the sale's own day, which can be earlier than
    // the day it was typed in (§4, 2026-10-16) — then created first.
    const open = await tx.saleOrder.findMany({
      where: {
        customerId: payment.customerId,
        ...(branchId ? { branchId } : {}),
        status: { in: [...OWED_STATUSES] },
        outstanding: { gt: 0 },
      },
      orderBy: [{ orderedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, outstanding: true, orderNo: true, orderedAt: true },
    });
    // Only orders sold on or before the day the money came in (§7a).
    const until = endOfBusinessDay(paymentDay(payment.receivedOn));
    const done: { audit: unknown }[] = [];
    // In cents, so 0.1 + 0.2 never leaves a 0.0000001 to allocate.
    let left = Math.round(amount * 100);
    for (const order of open) {
      if (left <= 0) break;
      if (order.orderedAt >= until) {
        // What is left could only go on a sale made after this payment.
        throw paymentBeforeOrder(order, payment.receivedOn);
      }
      const take = Math.min(left, Math.round(Number(order.outstanding) * 100));
      if (take <= 0) continue;
      done.push(
        await this.allocateWithin(tx, payment, order.id, take / 100, {
          chosenByPayer: false,
        }),
      );
      left -= take;
    }
    return done;
  }

  /**
   * The branch a payment is for: this customer's own. An archived branch can
   * still be paid — it keeps its balance until it is settled (§7). Paying one
   * branch and one order at once is two answers to where the money goes.
   */
  private async payingBranch(
    customerId: string,
    branchId: string,
    orderId?: string,
  ) {
    if (orderId) {
      throw badRequest(
        'VALIDATION_FAILED',
        'Send branchId or orderId, not both: the order already says its branch.',
        { fields: 'branchId' },
      );
    }
    const branch = isUuid(branchId)
      ? await this.prisma.customerBranch.findUnique({
          where: { id: branchId },
          select: { id: true, name: true, customerId: true },
        })
      : null;
    if (!branch) throw notFound('customerBranch');
    if (branch.customerId !== customerId) {
      throw badRequest(
        'BRANCH_NOT_THIS_CUSTOMER',
        `The branch ${branch.name} belongs to another customer.`,
        { branch: branch.name },
      );
    }
    return branch;
  }

  /** The audit rows for what `recordWithin` wrote, once it has committed. */
  async logRecorded(
    outcome: {
      payment: { id: string };
      allocated: { audit: unknown }[];
    },
    actorId: string,
  ) {
    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'Payment',
      entityId: outcome.payment.id,
      afterJson: outcome.payment,
    });
    for (const allocated of outcome.allocated) {
      await this.audit.log({
        actorUserId: actorId,
        action: 'ALLOCATE',
        entityType: 'Payment',
        entityId: outcome.payment.id,
        afterJson: allocated.audit,
      });
    }
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
      receivedOn: Date;
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
    // Samples left at a shop are not a sale and owe nothing until the shop
    // decides (§4, samples at shops, 2026-10-18); one returned or written off
    // never will.
    if (isSamplesStatus(order.status)) {
      throw badRequest(
        'SAMPLES_NOT_PAYABLE',
        `Order ${order.orderNo} is samples left at a shop, not a sale, so nothing can be paid on it. Record what the shop decided first.`,
        { order: order.orderNo },
      );
    }
    if (order.status === 'DRAFT') {
      throw badRequest(
        'ORDER_NOT_CONFIRMED',
        `Order ${order.orderNo} is a draft, so it owes nothing yet.`,
        { order: order.orderNo },
      );
    }
    // Not before the sale itself (§7a, 2026-10-16), whichever way the money
    // reaches the order: chosen, oldest first, or the Allocate action.
    if (paymentDay(payment.receivedOn) < businessDay(order.orderedAt)) {
      throw paymentBeforeOrder(order, payment.receivedOn);
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

    // A payment is reversed once. Without this a second reversal put the
    // money back on its orders again, so a shop owed more than it was charged.
    const alreadyReversed = () =>
      badRequest(
        'PAYMENT_ALREADY_REVERSED',
        'This payment has already been reversed.',
      );
    if (payment.status !== 'RECORDED') throw alreadyReversed();

    await this.prisma.$transaction(async (tx) => {
      // Claim the payment first, on its status: of two reversals sent at
      // once, only one finds it still RECORDED.
      const claimed = await tx.payment.updateMany({
        where: { id, status: 'RECORDED' },
        data: { status: 'REVERSED', version: { increment: 1 } },
      });
      if (claimed.count === 0) throw alreadyReversed();

      // Put each allocation back on its order.
      for (const alloc of payment.allocations) {
        const order = await tx.saleOrder.findUnique({
          where: { id: alloc.saleOrderId },
        });
        if (order) {
          await tx.saleOrder.update({
            where: { id: alloc.saleOrderId },
            data: {
              outstanding: { increment: Number(alloc.amount) },
              status: 'PARTIALLY_PAID',
              version: { increment: 1 },
            },
          });
        }
      }
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'REVERSE',
      entityType: 'Payment',
      entityId: id,
      afterJson: { reason },
    });
    await tellOtherPartners(
      this.prisma,
      this.notifications,
      actorId,
      async () => {
        const shop = await this.prisma.customer.findUnique({
          where: { id: payment.customerId },
          select: { displayName: true },
        });
        return reversalNews({
          id,
          amount: payment.amount,
          customerId: payment.customerId,
          shop: shop?.displayName ?? '—',
          reason,
        });
      },
    );

    return { data: { success: true } };
  }
}
