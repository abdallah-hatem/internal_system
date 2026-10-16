import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { nextReferenceNumber, pad } from '../../common/references';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PaginationDto,
  pageSize,
  cursorPage,
} from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';
import {
  CreatePaymentPlanDto,
  CreateSaleContractPlanDto,
} from './dto/payment-plan.dto';
import { isUuid } from '../../common/uuid';
import { businessDay, businessToday } from '../../common/dates';
import { formatMoney } from '../../common/money';
import { dayOf, evaluateSchedule } from '../../common/instalment-schedule';

import { badRequest, notFound } from '../../common/api-error';
import { assertVerified } from '../../common/verified-customer';
import { owedBy } from '../../common/customer-balance';
import {
  overdueNotificationsToSend,
  type OverdueInstalment,
} from '../../common/overdue-notifications';
const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export type { InstalmentState } from '../../common/instalment-schedule';

const PLAN_INCLUDE = {
  customer: { select: { id: true, displayName: true, phone: true } },
  instalments: { orderBy: { sequence: 'asc' } },
  // The sale a contract plan was agreed for (§7, 2026-10-16), so the plans
  // list can name it and open its contract.
  saleOrder: { select: { id: true, orderNo: true } },
} satisfies Prisma.PaymentPlanInclude;

/** Midnight today, for anything that needs a Date rather than a day. */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function todayLocalDay() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

@Injectable()
export class PaymentPlansService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  /**
   * Work out where a plan stands.
   *
   * Progress is measured cumulatively, not instalment by instalment. What
   * matters on any date is whether the shop has paid at least what it had
   * promised by then — so a shop that pays 1,000 late but 5,000 early is square,
   * and only a genuine shortfall counts as overdue. Matching payments to
   * individual instalments would flag that shop as late on a debt it had
   * already covered.
   */
  private evaluate(
    instalments: {
      id: string;
      sequence: number;
      dueOn: Date;
      amount: Prisma.Decimal;
      note: string | null;
    }[],
    paidToDate: Prisma.Decimal,
  ) {
    // The one cumulative reading (common/instalment-schedule.ts), shared with
    // a lender's plan (§18) so the two never disagree about who is late.
    const s = evaluateSchedule(instalments, paidToDate, todayLocalDay());
    const lines = s.lines.map((l) => ({
      id: l.instalment.id,
      sequence: l.instalment.sequence,
      dueOn: l.instalment.dueOn,
      amount: l.amount,
      paidEgp: l.paid,
      outstandingEgp: l.outstanding,
      state: l.state,
      note: l.instalment.note,
    }));
    return {
      instalments: lines,
      totalEgp: s.total,
      paidEgp: s.paid,
      remainingEgp: s.remaining,
      overdueEgp: s.overdue,
      isOverdue: s.isOverdue,
      nextDueOn: s.nextDue?.instalment.dueOn ?? null,
      nextDueEgp: s.nextDue ? s.nextDue.outstanding : null,
    };
  }

  /** Everything this customer has paid since the plan was agreed. */
  private async paidSince(customerId: string, since: Date) {
    const agg = await this.prisma.payment.aggregate({
      where: { customerId, status: 'RECORDED', receivedOn: { gte: since } },
      _sum: { amount: true },
    });
    return D(agg._sum.amount);
  }

  async findAll(
    pagination: PaginationDto & { customerId?: string; overdueOnly?: string },
  ) {
    const { cursor, customerId } = pagination;
    const limit = pageSize(pagination.limit);

    const plans = await this.prisma.paymentPlan.findMany({
      where: {
        ...(customerId ? { customerId } : {}),
        status: { not: 'CANCELLED' },
      },
      ...cursorPage(cursor, limit),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: PLAN_INCLUDE,
    });

    const hasMore = plans.length > limit;
    const page = hasMore ? plans.slice(0, limit) : plans;

    const data = await Promise.all(
      page.map(async (plan) => ({
        ...plan,
        ...this.evaluate(
          plan.instalments,
          await this.paidSince(plan.customerId, plan.agreedOn),
        ),
      })),
    );

    const filtered =
      pagination.overdueOnly === 'true'
        ? data.filter((p) => p.isOverdue)
        : data;

    return {
      data: filtered,
      meta: {
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        limit,
      },
    };
  }

  async findOne(id: string) {
    const plan = await this.prisma.paymentPlan.findUnique({
      where: { id },
      include: PLAN_INCLUDE,
    });
    if (!plan) throw notFound('paymentPlan');

    return {
      data: {
        ...plan,
        ...this.evaluate(
          plan.instalments,
          await this.paidSince(plan.customerId, plan.agreedOn),
        ),
      },
    };
  }

  /**
   * Agree a schedule for clearing a shop's balance.
   *
   * The plan covers the customer's running balance rather than one sale: a shop
   * thinks in terms of what it owes in total, and pays against that.
   */
  async create(dto: CreatePaymentPlanDto, actorId?: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
      select: { id: true, displayName: true, verificationStatus: true },
    });
    if (!customer) throw notFound('customer');

    return this.agree(
      {
        customer,
        instalments: dto.instalments,
        agreedOn: dto.agreedOn ? new Date(dto.agreedOn) : startOfToday(),
        note: dto.note,
      },
      actorId,
    );
  }

  /**
   * The plan behind a sale's contract (BUSINESS_LOGIC §7, 2026-10-16): the
   * Contract button on the sale order popup schedules what is still owed on
   * that one sale, and the plan names the sale.
   *
   * The plan is an ordinary plan in every other way — the same rules below
   * (verified shop, one active plan per shop, never more than the shop owes)
   * and the same cumulative reading of who is behind. On top of those, a sale
   * contract must schedule exactly the sale's outstanding amount, in EGP, from
   * today on.
   */
  async createForSale(
    saleOrderId: string,
    dto: CreateSaleContractPlanDto,
    actorId?: string,
  ) {
    if (!isUuid(saleOrderId)) throw notFound('saleOrder');
    const sale = await this.prisma.saleOrder.findUnique({
      where: { id: saleOrderId },
      select: {
        id: true,
        orderNo: true,
        status: true,
        currency: true,
        outstanding: true,
        customer: {
          select: {
            id: true,
            displayName: true,
            verificationStatus: true,
            isWalkIn: true,
          },
        },
        paymentPlan: { select: { id: true, reference: true, status: true } },
      },
    });
    if (!sale) throw notFound('saleOrder');

    // A draft owes nothing yet, a paid sale has nothing left, and a cancelled
    // or returned one is not a debt (§4).
    if (sale.status !== 'CONFIRMED' && sale.status !== 'PARTIALLY_PAID') {
      throw badRequest(
        'SALE_CONTRACT_NOT_OPEN',
        `Order ${sale.orderNo} is ${sale.status}; only a confirmed or partly paid sale can be sold on instalments.`,
        { order: sale.orderNo, status: sale.status },
      );
    }
    // Plans are kept in EGP (totalEgp, and the payments they are read against).
    if (sale.currency !== 'EGP') {
      throw badRequest(
        'SALE_CONTRACT_NOT_EGP',
        `Order ${sale.orderNo} is in ${sale.currency}; instalment contracts are in EGP.`,
        { order: sale.orderNo, currency: sale.currency },
      );
    }
    const owed = money(D(sale.outstanding));
    // A walk-in paid as it was sold and has no account to owe on (§4).
    if (owed.lte(0) || sale.customer.isWalkIn) {
      throw badRequest(
        'SALE_CONTRACT_NOTHING_OWED',
        `Nothing is outstanding on order ${sale.orderNo}, so there is nothing to put on instalments.`,
        { order: sale.orderNo },
      );
    }
    const existing = sale.paymentPlan;
    if (existing && existing.status !== 'CANCELLED') {
      throw badRequest(
        'SALE_HAS_PLAN',
        `Order ${sale.orderNo} already has its instalment plan (${existing.reference}).`,
        { order: sale.orderNo, reference: existing.reference },
      );
    }

    // A promise to pay is about the days to come. Today is allowed: an
    // instalment taken at signing is the first one, dated today.
    const today = businessToday();
    for (const i of dto.instalments) {
      const day = businessDay(i.dueOn);
      if (day < today) {
        throw badRequest(
          'INSTALMENT_DUE_IN_PAST',
          `An instalment cannot fall due in the past (${day}).`,
          { day },
        );
      }
    }

    const total = dto.instalments.reduce((s, i) => s.add(D(i.amount)), D(0));
    if (!money(total).eq(owed)) {
      throw badRequest(
        'CONTRACT_SUM_MISMATCH',
        `The instalments total ${formatMoney(total)} EGP but ${formatMoney(owed)} EGP is outstanding on order ${sale.orderNo}.`,
        {
          order: sale.orderNo,
          total: formatMoney(total),
          owed: formatMoney(owed),
        },
      );
    }

    return this.agree(
      {
        customer: sale.customer,
        instalments: dto.instalments,
        agreedOn: startOfToday(),
        note: dto.note,
        saleOrderId: sale.id,
        // A cancelled plan lets go of its sale, so the sale can have another.
        releasePlanId: existing?.id,
      },
      actorId,
    );
  }

  /**
   * The rules every plan is agreed under, whichever door it came through.
   */
  private async agree(
    input: {
      customer: { id: string; displayName: string; verificationStatus: string };
      instalments: CreatePaymentPlanDto['instalments'];
      agreedOn: Date;
      note?: string;
      saleOrderId?: string;
      releasePlanId?: string;
    },
    actorId?: string,
  ) {
    const { customer } = input;
    assertVerified(customer);

    const active = await this.prisma.paymentPlan.findFirst({
      where: { customerId: customer.id, status: 'ACTIVE' },
      select: { id: true, reference: true },
    });
    if (active) {
      throw badRequest(
        'CUSTOMER_HAS_ACTIVE_PLAN',
        `${customer.displayName} already has an active plan (${active.reference}). ` +
          'Cancel it before agreeing another, or two schedules will claim the same payments.',
        { customer: customer.displayName, reference: active.reference },
      );
    }

    const sorted = [...input.instalments].sort(
      (a, b) => new Date(a.dueOn).getTime() - new Date(b.dueOn).getTime(),
    );
    const total = sorted.reduce((s, i) => s.add(D(i.amount)), D(0));

    // What the shop actually owes across its open sales. The plan may cover
    // less (a part payment arrangement) but promising more than is owed is
    // almost always a typo.
    const owed = D(await owedBy(this.prisma, customer.id));

    /**
     * A plan schedules a debt, so there has to be one.
     *
     * The check below was guarded on `owed.gt(0)`, which meant a customer who
     * owed nothing skipped it entirely and any plan at all was accepted. The
     * system then contradicted itself: the plan existed, and every payment into
     * it was refused with "does not owe anything, so there is nothing to pay".
     * Agreed and unusable, with nothing explaining why.
     */
    if (owed.lte(0)) {
      throw badRequest(
        'NOTHING_TO_SCHEDULE',
        `${customer.displayName} does not owe anything, so there is no debt to schedule.`,
        { customer: customer.displayName },
      );
    }

    if (total.gt(owed)) {
      throw badRequest(
        'INSTALMENTS_EXCEED_OWED',
        `The instalments total ${formatMoney(total)} EGP but ${customer.displayName} ` +
          `only owes ${formatMoney(owed)} EGP.`,
        {
          total: formatMoney(total),
          customer: customer.displayName,
          owed: formatMoney(owed),
        },
      );
    }

    const plan = await this.prisma.$transaction(async (tx) => {
      if (input.releasePlanId) {
        await tx.paymentPlan.update({
          where: { id: input.releasePlanId },
          data: { saleOrderId: null },
        });
      }
      const year = new Date().getFullYear();
      const last = await tx.paymentPlan.findFirst({
        where: { reference: { startsWith: `PLAN-${year}` } },
        orderBy: { reference: 'desc' },
        select: { reference: true },
      });
      return tx.paymentPlan.create({
        data: {
          customerId: customer.id,
          reference: `PLAN-${year}-${pad(nextReferenceNumber(last?.reference, 4), 4)}`,
          totalEgp: money(total),
          agreedOn: input.agreedOn,
          note: input.note,
          createdBy: actorId,
          ...(input.saleOrderId ? { saleOrderId: input.saleOrderId } : {}),
          instalments: {
            create: sorted.map((i, idx) => ({
              sequence: idx + 1,
              dueOn: new Date(i.dueOn),
              amount: money(D(i.amount)),
              note: i.note,
            })),
          },
        },
        include: PLAN_INCLUDE,
      });
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'PaymentPlan',
      entityId: plan.id,
      afterJson: {
        reference: plan.reference,
        customer: customer.displayName,
        totalEgp: total.toFixed(2),
        instalments: sorted.length,
        ...(input.saleOrderId ? { saleOrderId: input.saleOrderId } : {}),
      },
    });

    return { data: { ...plan, ...this.evaluate(plan.instalments, D(0)) } };
  }

  /**
   * A sale's instalment contract, built live from the sale and its plan
   * (BUSINESS_LOGIC §7, 2026-10-16) — nothing about the contract is stored.
   *
   * "Remaining in instalments" is the plan's total, the amount agreed at
   * signing, and "paid at signing" is the sale's total less it. Neither moves
   * as instalments come in: a reprinted contract says what was signed.
   */
  async saleContract(saleOrderId: string) {
    if (!isUuid(saleOrderId)) throw notFound('saleOrder');
    const sale = await this.prisma.saleOrder.findUnique({
      where: { id: saleOrderId },
      select: {
        id: true,
        orderNo: true,
        currency: true,
        total: true,
        customer: { select: { id: true, displayName: true, phone: true } },
        items: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            quantity: true,
            unitPrice: true,
            discount: true,
            lineTotal: true,
            product: { select: { name: true, nameAr: true, sku: true } },
          },
        },
        paymentPlan: {
          select: {
            id: true,
            reference: true,
            status: true,
            agreedOn: true,
            totalEgp: true,
            instalments: {
              orderBy: { sequence: 'asc' },
              select: { id: true, sequence: true, dueOn: true, amount: true },
            },
          },
        },
      },
    });
    if (!sale) throw notFound('saleOrder');
    const plan = sale.paymentPlan;
    if (!plan || plan.status === 'CANCELLED') {
      throw badRequest(
        'SALE_HAS_NO_PLAN',
        `Order ${sale.orderNo} has no instalment plan, so it has no contract.`,
        { order: sale.orderNo },
      );
    }

    const total = money(D(sale.total));
    const remaining = money(D(plan.totalEgp));
    return {
      data: {
        saleId: sale.id,
        orderNo: sale.orderNo,
        number: `CT-${sale.orderNo}`,
        date: dayOf(plan.agreedOn),
        currency: sale.currency,
        customer: sale.customer,
        lines: sale.items.map((i) => ({
          id: i.id,
          product: i.product.name,
          productAr: i.product.nameAr,
          sku: i.product.sku,
          quantity: D(i.quantity).toString(),
          unitPrice: money(D(i.unitPrice)).toFixed(2),
          discount: money(D(i.discount)).toFixed(2),
          lineTotal: money(D(i.lineTotal)).toFixed(2),
        })),
        total: total.toFixed(2),
        paidAtSigning: total.sub(remaining).toFixed(2),
        remaining: remaining.toFixed(2),
        plan: {
          id: plan.id,
          reference: plan.reference,
          status: plan.status,
          instalments: plan.instalments.map((i) => ({
            id: i.id,
            sequence: i.sequence,
            dueOn: dayOf(i.dueOn),
            amount: money(D(i.amount)).toFixed(2),
          })),
        },
      },
    };
  }

  async cancel(id: string, reason: string, actorId?: string) {
    const plan = await this.prisma.paymentPlan.findUnique({ where: { id } });
    if (!plan) throw notFound('paymentPlan');
    if (plan.status === 'CANCELLED') {
      throw badRequest(
        'PLAN_ALREADY_CANCELLED',
        'This plan is already cancelled',
      );
    }

    const updated = await this.prisma.paymentPlan.update({
      where: { id },
      data: { status: 'CANCELLED', note: reason },
      include: PLAN_INCLUDE,
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CANCEL',
      entityType: 'PaymentPlan',
      entityId: id,
      beforeJson: { status: plan.status },
      afterJson: { status: 'CANCELLED', reason },
    });

    return { data: updated };
  }

  /** Every active plan, evaluated as of today. */
  private async evaluateActive() {
    const plans = await this.prisma.paymentPlan.findMany({
      where: { status: 'ACTIVE' },
      include: PLAN_INCLUDE,
    });
    return Promise.all(
      plans.map(async (plan) => ({
        plan,
        ...this.evaluate(
          plan.instalments,
          await this.paidSince(plan.customerId, plan.agreedOn),
        ),
      })),
    );
  }

  /**
   * Everything overdue right now. Only reads: who is told, and when, is
   * `notifyOverdue`'s job (BUSINESS_LOGIC §7, 2026-10-11).
   *
   * The BRD scopes V1 to flagging and telling someone (19): nothing here blocks
   * a sale or charges a penalty.
   */
  async overdueSummary() {
    const overdue = (await this.evaluateActive()).filter((p) => p.isOverdue);

    return {
      data: {
        totalOverdueEgp: overdue.reduce((s, p) => s + Number(p.overdueEgp), 0),
        plans: overdue.map((p) => ({
          id: p.plan.id,
          reference: p.plan.reference,
          customer: p.plan.customer,
          overdueEgp: p.overdueEgp,
          remainingEgp: p.remainingEgp,
          nextDueOn: p.nextDueOn,
        })),
      },
    };
  }

  /**
   * Tell every active core partner about each instalment that has fallen
   * behind — once per instalment, ever (BUSINESS_LOGIC §7, DECIDED 2026-10-11).
   *
   * Run daily by the scheduler (`GET /jobs/overdue-payments` on Vercel, the
   * `@Cron` on a host with a process). It used to run only when somebody
   * opened `GET /payment-plans/overdue`, telling only that person, at most once
   * per plan per day — and the office app never opens it.
   *
   * Running it twice in a day, or every day for a month, sends nothing new: what
   * was already sent is read back from the notifications' `instalmentId`.
   */
  async notifyOverdue() {
    const evaluated = await this.evaluateActive();

    const overdue: OverdueInstalment[] = evaluated.flatMap((p) =>
      p.instalments
        .filter((i) => i.state === 'OVERDUE')
        .map((i) => ({
          instalmentId: i.id,
          planId: p.plan.id,
          customerId: p.plan.customerId,
          customer: p.plan.customer.displayName,
          reference: p.plan.reference,
          dueOn: dayOf(i.dueOn),
          outstandingEgp: i.outstandingEgp.toFixed(2),
        })),
    );
    if (overdue.length === 0)
      return { overdueInstalments: 0, notifications: 0 };

    const partners = await this.prisma.user.findMany({
      where: { role: 'CORE_PARTNER', status: 'ACTIVE' },
      select: { id: true },
    });
    const partnerIds = partners.map((u) => u.id);
    if (partnerIds.length === 0) {
      return { overdueInstalments: overdue.length, notifications: 0 };
    }

    // Nothing can have been sent about an instalment before it was due, so
    // the earliest due day bounds what has to be read back.
    const earliest = overdue.reduce(
      (min, o) => (o.dueOn < min ? o.dueOn : min),
      overdue[0].dueOn,
    );
    const previous = await this.prisma.notification.findMany({
      where: {
        eventType: 'PAYMENT_OVERDUE',
        userId: { in: partnerIds },
        createdAt: { gte: new Date(`${earliest}T00:00:00Z`) },
      },
      select: { userId: true, payloadJson: true },
    });
    const alreadySent = previous.flatMap((n) => {
      const id = (n.payloadJson as { instalmentId?: unknown } | null)
        ?.instalmentId;
      return typeof id === 'string'
        ? [{ userId: n.userId, instalmentId: id }]
        : [];
    });

    let notifications = 0;
    for (const { instalment, userIds } of overdueNotificationsToSend(
      overdue,
      partnerIds,
      alreadySent,
    )) {
      await this.notifications.createForMultipleUsers(userIds, {
        eventType: 'PAYMENT_OVERDUE',
        code: 'INSTALMENT_OVERDUE',
        params: {
          customer: instalment.customer,
          amount: formatMoney(instalment.outstandingEgp),
          reference: instalment.reference,
          dueOn: instalment.dueOn,
        },
        payload: {
          planId: instalment.planId,
          instalmentId: instalment.instalmentId,
          customerId: instalment.customerId,
          dueOn: instalment.dueOn,
          outstandingEgp: instalment.outstandingEgp,
        },
      });
      notifications += userIds.length;
    }

    return { overdueInstalments: overdue.length, notifications };
  }
}
