import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';
import { CreatePaymentPlanDto } from './dto/payment-plan.dto';

const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
const money = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** Sales whose money is genuinely owed. */
const OWED_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID'] as const;

export type InstalmentState = 'PAID' | 'DUE' | 'OVERDUE' | 'UPCOMING';

const PLAN_INCLUDE = {
  customer: { select: { id: true, displayName: true, phone: true } },
  instalments: { orderBy: { sequence: 'asc' } },
} satisfies Prisma.PaymentPlanInclude;

/** Midnight today, for anything that needs a Date rather than a day. */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * The calendar day, as YYYY-MM-DD.
 *
 * Instalment dates are stored as `date` and come back at UTC midnight, while
 * "today" is local. Comparing those as timestamps is wrong by the UTC offset —
 * it made an instalment due today read as overdue. Comparing the day itself
 * sidesteps the offset entirely, which is what a due date actually means:
 * nobody is late until the day is over.
 */
function dayOf(d: Date) {
  return d.toISOString().slice(0, 10);
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
    instalments: { id: string; sequence: number; dueOn: Date; amount: Prisma.Decimal; note: string | null }[],
    paidToDate: Prisma.Decimal,
  ) {
    const today = todayLocalDay();

    let cumulativeDue = D(0);
    let applied = D(0);
    let overdueEgp = D(0);

    const lines = instalments.map((i) => {
      const amount = D(i.amount);
      cumulativeDue = cumulativeDue.add(amount);

      // Money is applied to the earliest instalments first: a shop paying down
      // a running balance clears its oldest promise, not the nearest one.
      const remainingPayment = Prisma.Decimal.max(paidToDate.sub(applied), D(0));
      const coveredHere = Prisma.Decimal.min(remainingPayment, amount);
      applied = applied.add(coveredHere);

      const outstanding = amount.sub(coveredHere);
      const due = dayOf(i.dueOn);

      let state: InstalmentState;
      if (outstanding.lte(0)) state = 'PAID';
      else if (due < today) state = 'OVERDUE';
      else if (due === today) state = 'DUE';
      else state = 'UPCOMING';

      if (state === 'OVERDUE') overdueEgp = overdueEgp.add(outstanding);

      return {
        id: i.id,
        sequence: i.sequence,
        dueOn: i.dueOn,
        amount: money(amount),
        paidEgp: money(coveredHere),
        outstandingEgp: money(outstanding),
        state,
        note: i.note,
      };
    });

    const totalEgp = cumulativeDue;
    const remainingEgp = Prisma.Decimal.max(totalEgp.sub(paidToDate), D(0));
    const nextDue = lines.find((l) => l.state === 'DUE' || l.state === 'UPCOMING') ?? null;

    return {
      instalments: lines,
      totalEgp: money(totalEgp),
      paidEgp: money(Prisma.Decimal.min(paidToDate, totalEgp)),
      remainingEgp: money(remainingEgp),
      overdueEgp: money(overdueEgp),
      isOverdue: overdueEgp.gt(0),
      nextDueOn: nextDue?.dueOn ?? null,
      nextDueEgp: nextDue ? nextDue.outstandingEgp : null,
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

  async findAll(pagination: PaginationDto & { customerId?: string; overdueOnly?: string }) {
    const { cursor, customerId } = pagination;
    const limit = pageSize(pagination.limit);

    const plans = await this.prisma.paymentPlan.findMany({
      where: { ...(customerId ? { customerId } : {}), status: { not: 'CANCELLED' } },
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      orderBy: { createdAt: 'desc' },
      include: PLAN_INCLUDE,
    });

    const hasMore = plans.length > limit;
    const page = hasMore ? plans.slice(0, limit) : plans;

    const data = await Promise.all(
      page.map(async (plan) => ({
        ...plan,
        ...this.evaluate(plan.instalments, await this.paidSince(plan.customerId, plan.agreedOn)),
      })),
    );

    const filtered =
      pagination.overdueOnly === 'true' ? data.filter((p) => p.isOverdue) : data;

    return {
      data: filtered,
      meta: { nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null, limit },
    };
  }

  async findOne(id: string) {
    const plan = await this.prisma.paymentPlan.findUnique({
      where: { id },
      include: PLAN_INCLUDE,
    });
    if (!plan) throw new NotFoundException('Payment plan not found');

    return {
      data: {
        ...plan,
        ...this.evaluate(plan.instalments, await this.paidSince(plan.customerId, plan.agreedOn)),
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
      select: { id: true, displayName: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const active = await this.prisma.paymentPlan.findFirst({
      where: { customerId: dto.customerId, status: 'ACTIVE' },
      select: { id: true, reference: true },
    });
    if (active) {
      throw new BadRequestException(
        `${customer.displayName} already has an active plan (${active.reference}). ` +
          'Cancel it before agreeing another, or two schedules will claim the same payments.',
      );
    }

    const agreedOn = dto.agreedOn ? new Date(dto.agreedOn) : startOfToday();
    const sorted = [...dto.instalments].sort(
      (a, b) => new Date(a.dueOn).getTime() - new Date(b.dueOn).getTime(),
    );
    const total = sorted.reduce((s, i) => s.add(D(i.amount)), D(0));

    // What the shop actually owes across its open sales. The plan may cover
    // less (a part payment arrangement) but promising more than is owed is
    // almost always a typo.
    const owedAgg = await this.prisma.saleOrder.aggregate({
      where: { customerId: dto.customerId, status: { in: [...OWED_STATUSES] } },
      _sum: { outstanding: true },
    });
    const owed = D(owedAgg._sum?.outstanding);
    if (owed.gt(0) && total.gt(owed)) {
      throw new BadRequestException(
        `The instalments total ${total.toFixed(2)} EGP but ${customer.displayName} ` +
          `only owes ${owed.toFixed(2)} EGP.`,
      );
    }

    const plan = await this.prisma.$transaction(async (tx) => {
      const seq = await tx.paymentPlan.count();
      return tx.paymentPlan.create({
        data: {
          customerId: dto.customerId,
          reference: `PLAN-${new Date().getFullYear()}-${String(seq + 1).padStart(4, '0')}`,
          totalEgp: money(total),
          agreedOn,
          note: dto.note,
          createdBy: actorId,
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
      },
    });

    return { data: { ...plan, ...this.evaluate(plan.instalments, D(0)) } };
  }

  async cancel(id: string, reason: string, actorId?: string) {
    const plan = await this.prisma.paymentPlan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Payment plan not found');
    if (plan.status === 'CANCELLED') {
      throw new BadRequestException('This plan is already cancelled');
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

  /**
   * Everything overdue right now, and a notification for anything newly so.
   *
   * The BRD scopes V1 to flagging and telling someone (19): nothing here blocks
   * a sale or charges a penalty.
   */
  async overdueSummary(notifyUserIds: string[] = []) {
    const plans = await this.prisma.paymentPlan.findMany({
      where: { status: 'ACTIVE' },
      include: PLAN_INCLUDE,
    });

    const evaluated = await Promise.all(
      plans.map(async (plan) => ({
        plan,
        ...this.evaluate(plan.instalments, await this.paidSince(plan.customerId, plan.agreedOn)),
      })),
    );

    const overdue = evaluated.filter((p) => p.isOverdue);

    if (overdue.length > 0 && notifyUserIds.length > 0) {
      for (const p of overdue) {
        // One notification per plan per day at most: re-raising it on every
        // dashboard load would bury everything else in the bell.
        const since = startOfToday();
        const already = await this.prisma.notification.findFirst({
          where: {
            eventType: 'PAYMENT_OVERDUE',
            createdAt: { gte: since },
            payloadJson: { path: ['planId'], equals: p.plan.id },
          },
          select: { id: true },
        });
        if (already) continue;

        await this.notifications.createForMultipleUsers(notifyUserIds, {
          eventType: 'PAYMENT_OVERDUE',
          title:
            `${p.plan.customer.displayName} is ${p.overdueEgp} EGP behind on ${p.plan.reference}`,
          payload: {
            planId: p.plan.id,
            customerId: p.plan.customerId,
            overdueEgp: p.overdueEgp,
          },
        });
      }
    }

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
}
