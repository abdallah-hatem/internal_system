import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CostingService } from '../costing/costing.service';
import { badRequest, notFound } from '../../common/api-error';
import { formatMoney } from '../../common/money';
import { isUuid } from '../../common/uuid';
import { lockCycle } from '../../common/shipment-load';
import {
  assertNotFuture,
  businessDay,
  businessToday,
} from '../../common/dates';
import {
  assertInScope,
  cyclesVisibleTo,
  type ScopeViewer,
} from '../../common/investor-scope';
import {
  availableToFinanceEgp,
  financingCap,
  financingTerms,
  orderTotalEgp,
  owedOn,
  planRepayment,
  settlingEgp,
} from '../../common/lender-math';
import { parseCurrencyCode, parseRateToEgp } from '../../common/fx-rate';
import {
  STANDING_FINANCING,
  STANDING_REPAYMENT,
  cycleFinancedEgp,
  owedOnCycle,
} from '../../common/lender-debt';
import { dayOf, evaluateSchedule } from '../../common/instalment-schedule';
import { overdueNotificationsToSend } from '../../common/overdue-notifications';
import type {
  CreateFinancingDto,
  CreateLenderDto,
  UpdateLenderDto,
  CreateLenderPlanDto,
  CreateRepaymentDto,
} from './dto/lender.dto';

type Db = Prisma.TransactionClient;

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);
const m2 = (v: Prisma.Decimal.Value) => D(v).toFixed(2);

/**
 * A cycle in these states takes no new friend's payment (§18 guess): it is
 * being split, was split, or never ordered anything (§15).
 */
const CLOSED_FOR_FINANCING = ['SETTLEMENT', 'CLOSED', 'CANCELLED'];
/** A repayment on a cycle already split is not undone here (§18 guess). */
const SETTLED = ['SETTLEMENT', 'CLOSED'];

const FINANCING_INCLUDE = {
  lender: { select: { id: true, name: true, phone: true } },
  purchaseOrder: {
    select: { id: true, reference: true, orderedOn: true, currency: true },
  },
  cycle: { select: { id: true, code: true, status: true } },
  repayments: { orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }] },
  plans: {
    where: { status: 'ACTIVE' },
    include: { instalments: { orderBy: { sequence: 'asc' } } },
  },
} satisfies Prisma.LenderFinancingInclude;

type FinancingRow = Prisma.LenderFinancingGetPayload<{
  include: typeof FINANCING_INCLUDE;
}>;

/** The Cairo day a value names, as a date column wants it. */
const asDay = (value: string | undefined) =>
  new Date(`${value ? businessDay(value) : businessToday()}T00:00:00Z`);

@Injectable()
export class LendersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private costing: CostingService = new CostingService(prisma),
  ) {}

  /**
   * What friends may still pay towards a cycle (§18, 2026-10-16): its cost —
   * goods, legs, expenses charged to it — less what they already paid, in
   * pounds. Read by the order's and the cycle's summaries alike.
   */
  private async cycleRoom(cycleId: string) {
    const cost = await this.costing.cycleCost(cycleId);
    const financedEgp = await cycleFinancedEgp(this.prisma, cycleId);
    return {
      cycleGoodsEgp: m2(cost.goodsEgp),
      cycleShippingEgp: m2(cost.shippingEgp),
      cycleExpensesEgp: m2(cost.expensesEgp),
      cycleCostEgp: m2(cost.totalEgp),
      cycleFinancedEgp: m2(financedEgp),
      /** What a friend's payment on any of the cycle's orders may still be. */
      availableEgp: m2(availableToFinanceEgp(cost.totalEgp, financedEgp)),
    };
  }

  // ─── Reading ────────────────────────────────────────────────────────

  /** One financing as every screen shows it: what he paid, what is owed, how. */
  private view(f: FinancingRow) {
    const standing = f.repayments.filter((r) => r.reversedAt === null);
    const owed = owedOn(f.amount, standing);
    const repaid = D(f.amount).sub(owed);
    const plan = f.plans[0] ?? null;
    return {
      id: f.id,
      lender: f.lender,
      purchaseOrder: f.purchaseOrder,
      cycle: f.cycle,
      currency: f.currency,
      amount: m2(f.amount),
      fxRateToEgp: D(f.fxRateToEgp).toFixed(4),
      amountEgp: m2(f.amountEgp),
      paidOn: dayOf(f.paidOn),
      note: f.note,
      removedAt: f.removedAt,
      removalReason: f.removalReason,
      repaid: m2(repaid),
      owed: m2(owed),
      paidEgp: m2(standing.reduce((s, r) => s.add(r.amountEgp), D(0))),
      exchangeDiffEgp: m2(
        standing.reduce((s, r) => s.add(r.exchangeDiffEgp), D(0)),
      ),
      repayments: f.repayments.map((r) => ({
        id: r.id,
        paidOn: dayOf(r.paidOn),
        amountEgp: m2(r.amountEgp),
        rateToEgp: D(r.rateToEgp).toFixed(4),
        cleared: m2(r.cleared),
        clearedAtOrderRateEgp: m2(r.clearedAtOrderRateEgp),
        exchangeDiffEgp: m2(r.exchangeDiffEgp),
        note: r.note,
        reversedAt: r.reversedAt,
        reversalReason: r.reversalReason,
      })),
      plan: plan ? this.evaluatePlan(plan, standing) : null,
    };
  }

  /**
   * A plan evaluated by the one schedule reading customer plans use (§7):
   * cumulative, earliest first; what counts is what repayments dated on or
   * after the plan's day cleared.
   */
  private evaluatePlan(
    plan: FinancingRow['plans'][number],
    standing: readonly { paidOn: Date; cleared: Prisma.Decimal }[],
  ) {
    const agreed = dayOf(plan.agreedOn);
    const paid = standing
      .filter((r) => dayOf(r.paidOn) >= agreed)
      .reduce((s, r) => s.add(r.cleared), D(0));
    const s = evaluateSchedule(plan.instalments, paid, businessToday());
    return {
      id: plan.id,
      agreedOn: agreed,
      note: plan.note,
      total: m2(s.total),
      paid: m2(s.paid),
      remaining: m2(s.remaining),
      overdue: m2(s.overdue),
      isOverdue: s.isOverdue,
      instalments: s.lines.map((l) => ({
        id: l.instalment.id,
        sequence: l.instalment.sequence,
        dueOn: dayOf(l.instalment.dueOn),
        amount: m2(l.amount),
        paid: m2(l.paid),
        outstanding: m2(l.outstanding),
        state: l.state,
      })),
    };
  }

  /** What is owed, per currency, across these views. */
  private owedByCurrency(
    views: { currency: string; owed: string; removedAt: Date | null }[],
  ) {
    const by = new Map<string, Prisma.Decimal>();
    for (const v of views) {
      if (v.removedAt) continue;
      by.set(v.currency, (by.get(v.currency) ?? D(0)).add(v.owed));
    }
    return [...by.entries()]
      .filter(([, owed]) => owed.gt(0))
      .map(([currency, owed]) => ({ currency, owed: m2(owed) }));
  }

  async list() {
    const lenders = await this.prisma.lender.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: {
        financings: {
          where: STANDING_FINANCING,
          include: FINANCING_INCLUDE,
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return {
      data: lenders.map((l) => {
        const financings = l.financings.map((f) => this.view(f));
        return {
          id: l.id,
          name: l.name,
          phone: l.phone,
          notes: l.notes,
          financingCount: financings.length,
          owed: this.owedByCurrency(financings),
          overdue: financings.some((f) => f.plan?.isOverdue),
        };
      }),
    };
  }

  async findOne(id: string) {
    if (!isUuid(id)) throw notFound('lender');
    const lender = await this.prisma.lender.findUnique({
      where: { id },
      include: {
        financings: {
          include: FINANCING_INCLUDE,
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!lender || lender.deletedAt) throw notFound('lender');
    const financings = lender.financings.map((f) => this.view(f));
    return {
      data: {
        id: lender.id,
        name: lender.name,
        phone: lender.phone,
        notes: lender.notes,
        owed: this.owedByCurrency(financings),
        financings,
      },
    };
  }

  /** Who paid how much of one order, and what is still owed (§18). */
  async forOrder(purchaseOrderId: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(purchaseOrderId)) throw notFound('purchaseOrder');
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      select: {
        id: true,
        cycleId: true,
        currency: true,
        fxRateToEgp: true,
        items: { select: { lineTotal: true } },
      },
    });
    if (!po) throw notFound('purchaseOrder');
    assertInScope(
      await cyclesVisibleTo(viewer, this.prisma),
      po.cycleId,
      'purchaseOrder',
    );
    const rows = await this.prisma.lenderFinancing.findMany({
      where: { purchaseOrderId, ...STANDING_FINANCING },
      include: FINANCING_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    const financings = rows.map((f) => this.view(f));
    const total = po.items.reduce((s, i) => s.add(i.lineTotal), D(0));
    // Friends may pay in different currencies (§18, 2026-10-16), so what they
    // paid of the order is told in pounds, the unit the cap compares in.
    const totalEgp = orderTotalEgp(
      po.items.map((i) => i.lineTotal),
      po.fxRateToEgp,
    );
    const financedEgp = rows.reduce((s, f) => s.add(f.amountEgp), D(0));
    return {
      data: {
        currency: po.currency,
        fxRateToEgp: D(po.fxRateToEgp).toFixed(4),
        orderTotal: m2(total),
        orderTotalEgp: m2(totalEgp),
        /** What friends paid of this order. */
        financedEgp: m2(financedEgp),
        // The cap is the cycle's cost, not the order's (§18, 2026-10-16):
        // `availableEgp` is what a friend may still pay on this order,
        // which is what is left of the whole cycle's cost.
        ...(await this.cycleRoom(po.cycleId)),
        financings,
      },
    };
  }

  /** Every friend's payment on a cycle's orders, and who is still owed. */
  async forCycle(cycleId: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(cycleId)) throw notFound('cycle');
    assertInScope(await cyclesVisibleTo(viewer, this.prisma), cycleId);
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
      select: { id: true },
    });
    if (!cycle) throw notFound('cycle');
    const rows = await this.prisma.lenderFinancing.findMany({
      where: { cycleId, ...STANDING_FINANCING },
      include: FINANCING_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    const owed = await owedOnCycle(this.prisma, cycleId);
    return {
      data: {
        financedEgp: m2(await cycleFinancedEgp(this.prisma, cycleId)),
        ...(await this.cycleRoom(cycleId)),
        owed: owed.map((o) => ({
          lenderId: o.lenderId,
          lender: o.lender,
          currency: o.currency,
          owed: m2(o.owed),
        })),
        financings: rows.map((f) => this.view(f)),
      },
    };
  }

  /** What is owed now and the pounds that pay it off at `rate` (§18). */
  async quote(financingId: string, rate: unknown) {
    const f = await this.standingFinancing(this.prisma, financingId);
    const r = Number(rate);
    if (!Number.isFinite(r) || r <= 0) {
      throw badRequest(
        'RATE_NOT_POSITIVE',
        'An exchange rate must be greater than zero.',
      );
    }
    const owed = owedOn(f.amount, f.repayments);
    return {
      data: {
        currency: f.currency,
        owed: m2(owed),
        rateToEgp: D(r).toFixed(4),
        settlingEgp: m2(settlingEgp(owed, r)),
      },
    };
  }

  // ─── Writing ────────────────────────────────────────────────────────

  async create(dto: CreateLenderDto, actorId: string) {
    const name = dto.name?.trim();
    if (!name) {
      throw badRequest('LENDER_NAME_REQUIRED', 'A lender needs a name.');
    }
    const lender = await this.prisma.lender.create({
      data: {
        name,
        phone: dto.phone?.trim() || null,
        notes: dto.notes?.trim() || null,
        createdBy: actorId,
      },
    });
    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'Lender',
      entityId: lender.id,
      afterJson: { name: lender.name },
    });
    return { data: lender };
  }

  /** His name, phone and notes, corrected (owner, 2026-10-18). Money is untouched. */
  async update(id: string, dto: UpdateLenderDto, actorId: string) {
    if (!isUuid(id)) throw notFound('lender');
    const name = dto.name?.trim();
    if (!name) {
      throw badRequest('LENDER_NAME_REQUIRED', 'A lender needs a name.');
    }
    const before = await this.prisma.lender.findUnique({ where: { id } });
    if (!before || before.deletedAt) throw notFound('lender');
    const lender = await this.prisma.lender.update({
      where: { id },
      data: {
        name,
        phone: dto.phone?.trim() || null,
        notes: dto.notes?.trim() || null,
      },
    });
    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE',
      entityType: 'Lender',
      entityId: id,
      beforeJson: {
        name: before.name,
        phone: before.phone,
        notes: before.notes,
      },
      afterJson: {
        name: lender.name,
        phone: lender.phone,
        notes: lender.notes,
      },
    });
    return { data: lender };
  }

  /**
   * Delete a lender added by mistake (owner, 2026-10-18). Refused while any
   * payment of his still stands: deleting him would erase a debt and the cost
   * it carries on the cycle. Remove those payments first (each with its
   * reason), then delete him. He is hidden, not erased, so a removed payment's
   * history still says whose it was.
   */
  async remove(id: string, actorId: string) {
    if (!isUuid(id)) throw notFound('lender');
    const lender = await this.prisma.lender.findUnique({
      where: { id },
      include: {
        _count: { select: { financings: { where: STANDING_FINANCING } } },
      },
    });
    if (!lender || lender.deletedAt) throw notFound('lender');
    const standing = lender._count.financings;
    if (standing > 0) {
      throw badRequest(
        'LENDER_HAS_FINANCINGS',
        `${lender.name} still has ${standing} payment(s) on record. Remove them first.`,
        { count: standing, name: lender.name },
      );
    }
    await this.prisma.lender.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await this.audit.log({
      actorUserId: actorId,
      action: 'DELETE',
      entityType: 'Lender',
      entityId: id,
      beforeJson: { name: lender.name },
    });
    return { data: { id } };
  }

  /**
   * A friend paid all or part of this order (§18). His money paying our
   * supplier comes into the ledger at his own rate — the rate on the day he
   * paid, in the currency he paid in (2026-10-16); nothing leaves an account
   * of ours. Left out, both are the order's, as before.
   *
   * What friends paid is capped in pounds at the cycle's cost still unpaid
   * by friends (§18, owner 2026-10-16): every order's goods, every leg and
   * every expense charged to the cycle, less every friend's payment standing
   * on it. A friend who paid an order by card paid its shipping and the card
   * fee in the same sum. Two friends can pay in two currencies, so no other
   * unit compares them.
   */
  async finance(
    purchaseOrderId: string,
    dto: CreateFinancingDto,
    actorId: string,
  ) {
    if (!isUuid(purchaseOrderId)) throw notFound('purchaseOrder');
    if (!isUuid(dto.lenderId)) throw notFound('lender');
    // Here as well as in the DTO: the assistant calls this method directly
    // (§16), and a guard only in the DTO would let it record a zero.
    const asked = D(dto.amount);
    if (!asked.isFinite() || asked.lte(0)) {
      throw badRequest(
        'AMOUNT_NOT_POSITIVE',
        'The amount must be greater than zero.',
      );
    }
    assertNotFuture(dto.paidOn, 'LENDER_PAID');
    // Checked here as well as in the DTO: the assistant calls this directly.
    const askedCurrency = parseCurrencyCode(dto.currency);
    const askedRate = parseRateToEgp(dto.fxRateToEgp);

    const [po, lender] = await Promise.all([
      this.prisma.purchaseOrder.findUnique({
        where: { id: purchaseOrderId },
        select: { id: true, cycleId: true },
      }),
      this.prisma.lender.findFirst({
        where: { id: dto.lenderId, deletedAt: null },
        select: { id: true, name: true },
      }),
    ]);
    if (!po) throw notFound('purchaseOrder');
    if (!lender) throw notFound('lender');

    const id = randomUUID();
    const created = await this.prisma.$transaction(async (tx) => {
      // Under the cycle's lock: two friends recorded at once on one order
      // both read the same "already financed" without it.
      await lockCycle(tx, po.cycleId);
      const order = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: purchaseOrderId },
        include: {
          cycle: { select: { id: true, code: true, status: true } },
          items: { select: { lineTotal: true } },
          lenderFinancings: {
            where: STANDING_FINANCING,
            select: { lenderId: true },
          },
        },
      });
      if (CLOSED_FOR_FINANCING.includes(order.cycle.status)) {
        throw badRequest(
          'CYCLE_CLOSED_FOR_FINANCING',
          `Cycle ${order.cycle.code} is ${order.cycle.status}; a friend's payment cannot be recorded on it.`,
          { cycle: order.cycle.code, status: order.cycle.status },
        );
      }
      if (order.lenderFinancings.some((f) => f.lenderId === lender.id)) {
        throw badRequest(
          'LENDER_ALREADY_FINANCES_ORDER',
          `${lender.name} already paid for ${order.reference}. Remove that and record it again to change it.`,
          { lender: lender.name, reference: order.reference },
        );
      }
      // An order with no lines bought nothing, so nobody paid for it. The API
      // no longer makes one (PO_NEEDS_ITEM); drafts from before that may exist.
      if (order.items.length === 0) {
        throw badRequest(
          'FINANCING_ORDER_EMPTY',
          `${order.reference} has no lines, so there is nothing a friend could have paid for.`,
          { reference: order.reference },
        );
      }
      // The currency he paid in: any the business keeps a rate for, EGP, or
      // the order's own (§18, 2026-10-16). Checked before the rate — no rate
      // typed makes an unknown currency known.
      const paidIn = askedCurrency ?? order.currency;
      if (paidIn !== 'EGP' && paidIn !== order.currency) {
        const known = await tx.currencyRate.findUnique({
          where: { code: paidIn },
          select: { rateToEgp: true },
        });
        if (!known || known.rateToEgp === null) {
          throw badRequest(
            'NO_RATE_RECORDED',
            `No exchange rate has been recorded for ${paidIn}.`,
            { currency: paidIn },
          );
        }
      }
      // His day's rate; the order's when he named neither (common/lender-math,
      // the one definition).
      const { currency, rate } = financingTerms({
        currency: paidIn,
        rate: askedRate,
        orderCurrency: order.currency,
        orderRate: order.fxRateToEgp,
        orderReference: order.reference,
      });

      const amount = D(dto.amount);
      // Read in the transaction, under the cycle's lock: the cost and every
      // friend's payment on the cycle, not only this order's.
      const [cost, onCycle] = await Promise.all([
        this.costing.cycleCost(order.cycleId, { db: tx }),
        tx.lenderFinancing.findMany({
          where: { cycleId: order.cycleId, ...STANDING_FINANCING },
          select: { amount: true, fxRateToEgp: true },
        }),
      ]);
      const {
        exceeds,
        costEgp,
        financedEgp,
        availableEgp,
        addingEgp: amountEgp,
      } = financingCap({
        cost,
        standing: onCycle.map((f) => ({
          amount: f.amount,
          rate: f.fxRateToEgp,
        })),
        adding: { amount, rate },
      });
      if (exceeds) {
        throw badRequest(
          'FINANCING_EXCEEDS_CYCLE_COST',
          `${formatMoney(amountEgp)} EGP is more than is left of cycle ${order.cycle.code}'s cost: ` +
            `it cost ${formatMoney(costEgp)} EGP (goods, shipping and the expenses charged to it), ` +
            `friends already paid ${formatMoney(financedEgp)} EGP, so ${formatMoney(availableEgp)} EGP is left.`,
          {
            amount: formatMoney(amountEgp),
            cycle: order.cycle.code,
            cost: formatMoney(costEgp),
            financed: formatMoney(financedEgp),
            available: formatMoney(availableEgp),
          },
        );
      }

      const ledger = await tx.financialTransaction.create({
        data: {
          type: 'LENDER_FINANCING',
          category: 'lender_financing',
          direction: 'INFLOW',
          amount: amountEgp,
          currency: 'EGP',
          fxRateToEgp: rate,
          ...(currency !== 'EGP'
            ? { originalAmount: amount, originalCurrency: currency }
            : {}),
          cycleId: order.cycleId,
          relatedType: 'LENDER_FINANCING',
          relatedId: id,
          reason: `${lender.name} paid ${formatMoney(amount)} ${currency} of ${order.reference}`,
          // The ledger dates a row by the day it happened, not the day it was
          // typed in: without this a payment entered weeks later sat on the
          // day of entry (owner, 2026-10-16).
          occurredOn: asDay(dto.paidOn),
          createdBy: actorId,
        },
      });
      return tx.lenderFinancing.create({
        data: {
          id,
          lenderId: lender.id,
          purchaseOrderId,
          cycleId: order.cycleId,
          currency,
          amount,
          fxRateToEgp: rate,
          amountEgp,
          paidOn: asDay(dto.paidOn),
          note: dto.note?.trim() || null,
          createdBy: actorId,
          ledgerTransactionId: ledger.id,
        },
        include: FINANCING_INCLUDE,
      });
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'LenderFinancing',
      entityId: created.id,
      afterJson: {
        lender: lender.name,
        purchaseOrderId,
        amount: m2(created.amount),
        currency: created.currency,
        amountEgp: m2(created.amountEgp),
      },
    });
    return { data: this.view(created) };
  }

  /** Taken back while nothing stands repaid; the ledger inflow is balanced. */
  async removeFinancing(id: string, reason: string, actorId: string) {
    if (!reason?.trim()) {
      throw badRequest(
        'REVERSAL_REASON_REQUIRED',
        "A reason is required to remove a friend's payment.",
      );
    }
    const f = await this.findFinancing(this.prisma, id);
    await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, f.cycleId);
      const now = await tx.lenderFinancing.findUniqueOrThrow({
        where: { id },
        include: {
          repayments: { where: STANDING_REPAYMENT, select: { id: true } },
          lender: { select: { name: true } },
        },
      });
      if (now.removedAt) {
        throw badRequest(
          'FINANCING_REMOVED',
          "This friend's payment was already removed.",
        );
      }
      if (now.repayments.length > 0) {
        throw badRequest(
          'FINANCING_HAS_REPAYMENTS',
          `${now.lender.name} has been repaid on this; reverse those repayments before removing it.`,
          { lender: now.lender.name, repayments: now.repayments.length },
        );
      }
      const balancing = await tx.financialTransaction.create({
        data: {
          type: 'LENDER_FINANCING',
          category: 'lender_financing',
          direction: 'OUTFLOW',
          amount: now.amountEgp,
          currency: 'EGP',
          fxRateToEgp: now.fxRateToEgp,
          cycleId: now.cycleId,
          relatedType: 'LENDER_FINANCING',
          relatedId: now.id,
          reversalOfId: now.ledgerTransactionId,
          reason: `Removed: ${reason.trim()}`,
          // On the day of the payment it cancels, so that day's figures net
          // to nothing instead of one month showing it and another taking it
          // back (owner, 2026-10-16).
          occurredOn: now.paidOn,
          createdBy: actorId,
        },
      });
      await tx.lenderPlan.updateMany({
        where: { financingId: id, status: 'ACTIVE' },
        data: { status: 'CANCELLED', cancelReason: reason.trim() },
      });
      await tx.lenderFinancing.update({
        where: { id },
        data: {
          removedAt: new Date(),
          removedBy: actorId,
          removalReason: reason.trim(),
          removalTransactionId: balancing.id,
        },
      });
    });
    await this.audit.log({
      actorUserId: actorId,
      action: 'REVERSE',
      entityType: 'LenderFinancing',
      entityId: id,
      afterJson: { removed: true, reason: reason.trim() },
    });
    const after = await this.prisma.lenderFinancing.findUniqueOrThrow({
      where: { id },
      include: FINANCING_INCLUDE,
    });
    return { data: this.view(after) };
  }

  /**
   * Pounds paid to him on a day at that day's rate (§18): clears pounds ÷ rate
   * of the debt (common/lender-math.ts).
   *
   * No account of ours is named: the business keeps none (§18; money accounts
   * removed by the owner 2026-10-14). A body that sends one is refused by the
   * global pipe as an unknown field.
   */
  async repay(financingId: string, dto: CreateRepaymentDto, actorId: string) {
    const f = await this.findFinancing(this.prisma, financingId);
    assertNotFuture(dto.paidOn, 'LENDER_REPAID');
    const paidOn = asDay(dto.paidOn);
    if (dayOf(paidOn) < dayOf(f.paidOn)) {
      throw badRequest(
        'LENDER_REPAYMENT_BEFORE_FINANCING',
        `He paid the supplier on ${dayOf(f.paidOn)}; a repayment cannot be dated before that.`,
        { paidOn: dayOf(f.paidOn) },
      );
    }

    const id = randomUUID();
    const created = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, f.cycleId);
      const now = await tx.lenderFinancing.findUniqueOrThrow({
        where: { id: financingId },
        include: {
          lender: { select: { name: true } },
          purchaseOrder: { select: { reference: true } },
          repayments: { where: STANDING_REPAYMENT },
        },
      });
      if (now.removedAt) {
        throw badRequest(
          'FINANCING_REMOVED',
          "This friend's payment was removed; there is nothing to repay.",
        );
      }
      const plan = planRepayment(
        {
          amount: now.amount,
          amountEgp: now.amountEgp,
          financingRate: now.fxRateToEgp,
        },
        now.repayments,
        dto.amountEgp,
        dto.rateToEgp,
      );
      const amountEgp = D(dto.amountEgp);
      const ledger = await tx.financialTransaction.create({
        data: {
          type: 'LENDER_REPAYMENT',
          category: 'lender_repayment',
          direction: 'OUTFLOW',
          amount: amountEgp,
          currency: 'EGP',
          fxRateToEgp: dto.rateToEgp,
          cycleId: now.cycleId,
          relatedType: 'LENDER_REPAYMENT',
          relatedId: id,
          reason:
            `Repaid ${now.lender.name} ${formatMoney(plan.cleared)} ${now.currency} ` +
            `of ${now.purchaseOrder.reference} at ${dto.rateToEgp}`,
          // The day he was repaid, as for his payment above.
          occurredOn: paidOn,
          createdBy: actorId,
        },
      });
      return tx.lenderRepayment.create({
        data: {
          id,
          financingId,
          paidOn,
          amountEgp,
          rateToEgp: dto.rateToEgp,
          cleared: plan.cleared,
          clearedAtOrderRateEgp: plan.clearedAtOrderRateEgp,
          exchangeDiffEgp: plan.exchangeDiffEgp,
          note: dto.note?.trim() || null,
          createdBy: actorId,
          ledgerTransactionId: ledger.id,
        },
      });
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'LenderRepayment',
      entityId: created.id,
      afterJson: {
        financingId,
        amountEgp: m2(created.amountEgp),
        rateToEgp: D(created.rateToEgp).toFixed(4),
        cleared: m2(created.cleared),
        exchangeDiffEgp: m2(created.exchangeDiffEgp),
      },
    });
    return { data: await this.financingView(financingId) };
  }

  /** Undone, never deleted (§9): a balancing inflow, once, with a reason. */
  async reverseRepayment(id: string, reason: string, actorId: string) {
    if (!reason?.trim()) {
      throw badRequest(
        'REVERSAL_REASON_REQUIRED',
        'A reason is required to reverse a repayment.',
      );
    }
    if (!isUuid(id)) throw notFound('lenderRepayment');
    const r = await this.prisma.lenderRepayment.findUnique({
      where: { id },
      include: { financing: { select: { cycleId: true } } },
    });
    if (!r) throw notFound('lenderRepayment');

    await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, r.financing.cycleId);
      const now = await tx.lenderRepayment.findUniqueOrThrow({
        where: { id },
        include: {
          financing: {
            include: { cycle: { select: { code: true, status: true } } },
          },
        },
      });
      if (now.reversedAt) {
        throw badRequest(
          'LENDER_REPAYMENT_ALREADY_REVERSED',
          'This repayment was already reversed. Reversing again would count it twice.',
        );
      }
      if (SETTLED.includes(now.financing.cycle.status)) {
        throw badRequest(
          'LENDER_CYCLE_SETTLED',
          `Cycle ${now.financing.cycle.code} is settled; reverse the settlement before undoing a repayment on it.`,
          { cycle: now.financing.cycle.code },
        );
      }
      const balancing = await tx.financialTransaction.create({
        data: {
          type: 'LENDER_REPAYMENT',
          category: 'lender_repayment',
          direction: 'INFLOW',
          amount: now.amountEgp,
          currency: 'EGP',
          fxRateToEgp: now.rateToEgp,
          cycleId: now.financing.cycleId,
          relatedType: 'LENDER_REPAYMENT',
          relatedId: now.id,
          reversalOfId: now.ledgerTransactionId,
          reason: `Reversed: ${reason.trim()}`,
          // On the day of the repayment it undoes, as a removed payment above.
          occurredOn: now.paidOn,
          createdBy: actorId,
        },
      });
      await tx.lenderRepayment.update({
        where: { id },
        data: {
          reversedAt: new Date(),
          reversedBy: actorId,
          reversalReason: reason.trim(),
          reversalTransactionId: balancing.id,
        },
      });
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'REVERSE',
      entityType: 'LenderRepayment',
      entityId: id,
      afterJson: { reason: reason.trim() },
    });
    return { data: await this.financingView(r.financingId) };
  }

  /** A schedule in his currency, the §7 habit (§18). One active at a time. */
  async createPlan(
    financingId: string,
    dto: CreateLenderPlanDto,
    actorId: string,
  ) {
    const f = await this.findFinancing(this.prisma, financingId);
    const plan = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, f.cycleId);
      const now = await tx.lenderFinancing.findUniqueOrThrow({
        where: { id: financingId },
        include: {
          repayments: { where: STANDING_REPAYMENT, select: { cleared: true } },
          plans: { where: { status: 'ACTIVE' }, select: { id: true } },
          lender: { select: { name: true } },
        },
      });
      if (now.removedAt) {
        throw badRequest(
          'FINANCING_REMOVED',
          "This friend's payment was removed.",
        );
      }
      const owed = owedOn(now.amount, now.repayments);
      if (owed.lte(0)) {
        throw badRequest(
          'LENDER_NOTHING_OWED',
          `${now.lender.name} is owed nothing on this, so there is nothing to schedule.`,
          { lender: now.lender.name },
        );
      }
      if (now.plans.length > 0) {
        throw badRequest(
          'LENDER_PLAN_EXISTS',
          'This already has an active plan. Cancel it before agreeing another.',
        );
      }
      const sorted = [...dto.instalments].sort((a, b) =>
        a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0,
      );
      const total = sorted.reduce((s, i) => s.add(i.amount), D(0));
      if (total.gt(owed)) {
        throw badRequest(
          'LENDER_PLAN_EXCEEDS_OWED',
          `The instalments total ${formatMoney(total)} ${now.currency} but only ${formatMoney(owed)} is owed.`,
          {
            total: formatMoney(total),
            owed: formatMoney(owed),
            currency: now.currency,
          },
        );
      }
      return tx.lenderPlan.create({
        data: {
          financingId,
          agreedOn: asDay(dto.agreedOn),
          note: dto.note?.trim() || null,
          createdBy: actorId,
          instalments: {
            create: sorted.map((i, idx) => ({
              sequence: idx + 1,
              dueOn: new Date(`${i.dueOn.slice(0, 10)}T00:00:00Z`),
              amount: D(i.amount),
            })),
          },
        },
      });
    });
    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'LenderPlan',
      entityId: plan.id,
      afterJson: { financingId, instalments: dto.instalments.length },
    });
    return { data: await this.financingView(financingId) };
  }

  async cancelPlan(id: string, reason: string, actorId: string) {
    if (!reason?.trim()) {
      throw badRequest(
        'REVERSAL_REASON_REQUIRED',
        'A reason is required to cancel a plan.',
      );
    }
    if (!isUuid(id)) throw notFound('lenderPlan');
    const plan = await this.prisma.lenderPlan.findUnique({ where: { id } });
    if (!plan) throw notFound('lenderPlan');
    if (plan.status === 'CANCELLED') {
      throw badRequest(
        'PLAN_ALREADY_CANCELLED',
        'This plan is already cancelled',
      );
    }
    await this.prisma.lenderPlan.update({
      where: { id },
      data: { status: 'CANCELLED', cancelReason: reason.trim() },
    });
    await this.audit.log({
      actorUserId: actorId,
      action: 'CANCEL',
      entityType: 'LenderPlan',
      entityId: id,
      afterJson: { reason: reason.trim() },
    });
    return { data: await this.financingView(plan.financingId) };
  }

  // ─── Overdue (the daily job, §7 / §18) ─────────────────────────────

  /**
   * Tell every active core partner about each lender instalment that has
   * fallen behind — once per instalment, ever — by the same rule a shop's
   * plan is told (`overdueNotificationsToSend`). Run by the existing morning
   * job; no cron of its own.
   */
  async notifyOverdue() {
    const plans = await this.prisma.lenderPlan.findMany({
      where: { status: 'ACTIVE', financing: STANDING_FINANCING },
      include: {
        instalments: { orderBy: { sequence: 'asc' } },
        financing: {
          include: {
            lender: { select: { name: true } },
            purchaseOrder: { select: { reference: true } },
            repayments: {
              where: STANDING_REPAYMENT,
              select: { paidOn: true, cleared: true },
            },
          },
        },
      },
    });

    const overdue = plans.flatMap((plan) => {
      const agreed = dayOf(plan.agreedOn);
      const paid = plan.financing.repayments
        .filter((r) => dayOf(r.paidOn) >= agreed)
        .reduce((s, r) => s.add(r.cleared), D(0));
      return evaluateSchedule(plan.instalments, paid, businessToday())
        .lines.filter((l) => l.state === 'OVERDUE')
        .map((l) => ({
          instalmentId: l.instalment.id,
          planId: plan.id,
          financingId: plan.financingId,
          lenderId: plan.financing.lenderId,
          lender: plan.financing.lender.name,
          reference: plan.financing.purchaseOrder.reference,
          currency: plan.financing.currency,
          dueOn: dayOf(l.instalment.dueOn),
          outstanding: m2(l.outstanding),
        }));
    });
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
    const earliest = overdue.reduce(
      (min, o) => (o.dueOn < min ? o.dueOn : min),
      overdue[0].dueOn,
    );
    const previous = await this.prisma.notification.findMany({
      where: {
        eventType: 'LENDER_OVERDUE',
        userId: { in: partnerIds },
        createdAt: { gte: new Date(`${earliest}T00:00:00Z`) },
      },
      select: { userId: true, payloadJson: true },
    });
    const alreadySent = previous.flatMap((n) => {
      const iid = (n.payloadJson as { instalmentId?: unknown } | null)
        ?.instalmentId;
      return typeof iid === 'string'
        ? [{ userId: n.userId, instalmentId: iid }]
        : [];
    });

    let notifications = 0;
    for (const { instalment, userIds } of overdueNotificationsToSend(
      overdue,
      partnerIds,
      alreadySent,
    )) {
      await this.notifications.createForMultipleUsers(userIds, {
        eventType: 'LENDER_OVERDUE',
        code: 'LENDER_INSTALMENT_OVERDUE',
        params: {
          lender: instalment.lender,
          amount: formatMoney(instalment.outstanding),
          currency: instalment.currency,
          reference: instalment.reference,
          dueOn: instalment.dueOn,
        },
        payload: {
          lenderId: instalment.lenderId,
          financingId: instalment.financingId,
          planId: instalment.planId,
          instalmentId: instalment.instalmentId,
          dueOn: instalment.dueOn,
        },
      });
      notifications += userIds.length;
    }
    return { overdueInstalments: overdue.length, notifications };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private async findFinancing(db: Db | PrismaService, id: string) {
    if (!isUuid(id)) throw notFound('lenderFinancing');
    const f = await db.lenderFinancing.findUnique({
      where: { id },
      include: { repayments: { where: STANDING_REPAYMENT } },
    });
    if (!f) throw notFound('lenderFinancing');
    return f;
  }

  private async standingFinancing(db: Db | PrismaService, id: string) {
    const f = await this.findFinancing(db, id);
    if (f.removedAt) {
      throw badRequest(
        'FINANCING_REMOVED',
        "This friend's payment was removed.",
      );
    }
    return f;
  }

  private async financingView(id: string) {
    const f = await this.prisma.lenderFinancing.findUniqueOrThrow({
      where: { id },
      include: FINANCING_INCLUDE,
    });
    return this.view(f);
  }
}
