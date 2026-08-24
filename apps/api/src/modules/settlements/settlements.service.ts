import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import {
  distributeCycleProfit,
  summarizeCyclePnl,
  ParticipantInput,
} from './settlement-math';
import { formatMoney, formatQty } from '../../common/money';

import { badRequest, notFound } from '../../common/api-error';
/** Sale states whose stock has genuinely left the business. */
const REALISED_ORDER_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'] as const;

/**
 * Ledger categories that are not operating expenses of the cycle.
 *
 * `purchase` and `shipping` are already capitalised into batch landed cost, so
 * counting them again would charge the cycle twice.
 *
 * `settlement` is the distribution of profit already earned, plus any reversal
 * of one. Treating a payout as an expense re-charges the cycle for its own
 * profit: a settled cycle recalculated afterwards turned an 11,620 profit into
 * a 100,871 loss, and every later settlement would inherit the error.
 *
 * `contribution` is capital moving between the partners and the cycle, in
 * either direction. Lowering someone's contribution posts an outflow — capital
 * handed back — and without this that outflow was read as an operating expense
 * and came straight off the cycle's profit. The partners would have paid for
 * their own money being returned.
 */
const CAPITALISED_CATEGORIES = ['purchase', 'shipping', 'settlement', 'contribution'];

/**
 * Money recovered from a supplier. It does not re-price batches already costed
 * — units sold keep the cost they were sold at — so it lands as a reduction of
 * the cycle's expenses, which is to say a gain.
 */
const COST_RECOVERY_CATEGORIES = ['supplier_refund'];

const SETTLEMENT_INCLUDE = {
  cycle: { select: { id: true, code: true, status: true } },
  lines: {
    include: {
      participant: {
        include: {
          partner: {
            select: {
              id: true,
              email: true,
              partner: { select: { id: true, displayName: true } },
            },
          },
          investor: {
                  select: {
                    id: true,
                    email: true,
                    // An investor may also hold a partner record; prefer that
                    // name so the settlement table does not show a bare email
                    // next to properly named partners.
                    partner: { select: { id: true, displayName: true } },
                  },
                },
        },
      },
    },
  },
} as const;

@Injectable()
export class SettlementsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll(
    query: PaginationDto & {
      cycleId?: string;
      status?: string;
    },
  ) {
    const { cursor, limit: rawLimit = 20, cycleId, status } = query;
    const limit = pageSize(rawLimit);

    const where: any = {};
    if (cycleId) where.cycleId = cycleId;
    if (status) where.status = status;

    const items = await this.prisma.settlement.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        cycle: { select: { id: true, code: true, status: true } },
        lines: {
          include: {
            participant: {
              include: {
                partner: {
                  select: {
                    id: true,
                    email: true,
                    partner: { select: { id: true, displayName: true } },
                  },
                },
                investor: {
                  select: {
                    id: true,
                    email: true,
                    // An investor may also hold a partner record; prefer that
                    // name so the settlement table does not show a bare email
                    // next to properly named partners.
                    partner: { select: { id: true, displayName: true } },
                  },
                },
              },
            },
          },
        },
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

  async findOne(id: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: {
        cycle: { select: { id: true, code: true, status: true } },
        lines: {
          include: {
            participant: {
              include: {
                partner: {
                  select: {
                    id: true,
                    email: true,
                    partner: { select: { id: true, displayName: true } },
                  },
                },
                investor: {
                  select: {
                    id: true,
                    email: true,
                    // An investor may also hold a partner record; prefer that
                    // name so the settlement table does not show a bare email
                    // next to properly named partners.
                    partner: { select: { id: true, displayName: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!settlement) throw notFound('settlement');
    return { data: settlement };
  }

  /**
   * The cycle's profit as it stands, and how it would split today.
   *
   * Exactly the arithmetic `calculate` uses, lifted out so a cycle still
   * selling can be asked what it has earned so far without writing a
   * settlement. A projection that used its own maths would drift from the
   * settlement it is meant to predict, which is worse than not showing one.
   *
   * Nothing here writes, and it deliberately does not check for a locked
   * settlement — asking is not recalculating.
   */
  async project(cycleId: string) {
    const participants = await this.prisma.cycleParticipant.findMany({
      where: { cycleId },
      orderBy: { createdAt: 'asc' },
    });
    if (participants.length === 0) return null;

    // --- Revenue and COGS from this cycle's batches ------------------------
    const allocations = await this.prisma.saleItemAllocation.findMany({
      where: {
        inventoryBatch: { cycleId },
        saleItem: {
          saleOrder: { status: { in: [...REALISED_ORDER_STATUSES] } },
        },
      },
      include: { saleItem: true },
    });

    const allocationInputs = allocations.map((a) => {
      const qty = new Prisma.Decimal(a.qty);
      const itemQty = new Prisma.Decimal(a.saleItem.quantity);
      // Use the line total so a line-level discount is reflected in revenue.
      const unitPrice = itemQty.gt(0)
        ? new Prisma.Decimal(a.saleItem.lineTotal).div(itemQty)
        : new Prisma.Decimal(0);
      return { qty, unitPrice, cogs: new Prisma.Decimal(a.cogsEgp) };
    });

    // Goods that came back. Netted as negative allocations rather than by
    // editing the sale, so history survives (BRD 9) and the arithmetic stays
    // in one place.
    //
    // A damaged return reverses the revenue but reverses no cost, because the
    // stock never went back on the shelf: cogsReversedEgp is zero for those,
    // and the cost stays spent as a write-off.
    const returnItems = await this.prisma.saleReturnItem.findMany({
      where: {
        inventoryBatch: { cycleId },
        // Must match the allocation filter above: a fully returned order is no
        // longer realised, so its revenue is already excluded and netting its
        // return too would subtract the same money twice.
        saleItem: { saleOrder: { status: { in: [...REALISED_ORDER_STATUSES] } } },
      },
      select: { qty: true, unitPrice: true, cogsReversedEgp: true },
    });

    for (const r of returnItems) {
      allocationInputs.push({
        qty: new Prisma.Decimal(r.qty).neg(),
        unitPrice: new Prisma.Decimal(r.unitPrice),
        cogs: new Prisma.Decimal(r.cogsReversedEgp).neg(),
      });
    }

    // --- Stock still on the shelf -----------------------------------------
    const batches = await this.prisma.inventoryBatch.findMany({
      where: { cycleId },
      select: { remainingQty: true, landedUnitCostEgp: true },
    });
    const unitsRemaining = batches.reduce(
      (s, b) => s.add(b.remainingQty),
      new Prisma.Decimal(0),
    );
    const unsoldValue = batches.reduce(
      (s, b) => s.add(new Prisma.Decimal(b.remainingQty).mul(b.landedUnitCostEgp)),
      new Prisma.Decimal(0),
    );

    // --- Expenses not already inside landed cost ---------------------------
    const expenseTxns = await this.prisma.financialTransaction.findMany({
      where: {
        cycleId,
        direction: 'OUTFLOW',
        category: { notIn: CAPITALISED_CATEGORIES },
      },
      select: { amount: true },
    });
    // Money recovered from suppliers reduces what the cycle cost. It is netted
    // here rather than by re-pricing batches: units already sold keep the cost
    // they were sold at, and a settlement may already have been agreed on it.
    const recoveryTxns = await this.prisma.financialTransaction.findMany({
      where: {
        cycleId,
        direction: 'INFLOW',
        category: { in: COST_RECOVERY_CATEGORIES },
      },
      select: { amount: true },
    });

    const expenses = expenseTxns
      .reduce((s, t) => s.add(t.amount), new Prisma.Decimal(0))
      .sub(recoveryTxns.reduce((s, t) => s.add(t.amount), new Prisma.Decimal(0)));

    const pnl = summarizeCyclePnl({
      allocations: allocationInputs,
      expenses,
      unsoldValue,
      unitsRemaining,
    });

    // --- Distribute -------------------------------------------------------
    const participantInputs: ParticipantInput[] = participants.map((p) => ({
      id: p.id,
      type: p.participantType === 'TEMP_INVESTOR' ? 'TEMP_INVESTOR' : 'CORE_PARTNER',
      contribution: new Prisma.Decimal(p.contributionAmount),
      customProfitPct: p.customProfitPct ? new Prisma.Decimal(p.customProfitPct) : null,
      investorFeePct: p.investorFeePct ? new Prisma.Decimal(p.investorFeePct) : null,
    }));

    const distribution = distributeCycleProfit(participantInputs, pnl.grossProfit);
    return { pnl, distribution, participants };
  }

  /**
   * What `calculate` would produce, without producing it.
   *
   * Lets a cycle still selling be asked what it has earned so far — which the
   * partners page needs, and which anyone about to settle wants to see before
   * they commit to it.
   */
  async preview(cycleId: string) {
    const cycle = await this.prisma.importCycle.findUnique({ where: { id: cycleId } });
    if (!cycle) throw notFound('cycle');

    const projected = await this.project(cycleId);
    if (!projected) {
      throw badRequest('CYCLE_NO_PARTICIPANTS', 'No participants found for this cycle');
    }

    return {
      data: {
        cycleId,
        cycleCode: cycle.code,
        status: cycle.status,
        revenueEgp: projected.pnl.revenue.toFixed(2),
        cogsEgp: projected.pnl.cogs.toFixed(2),
        expensesEgp: projected.pnl.expenses.toFixed(2),
        grossProfitEgp: projected.pnl.grossProfit.toFixed(2),
        unsoldValueEgp: projected.pnl.unsoldValue.toFixed(2),
        fullySold: projected.pnl.fullySold,
        lines: projected.distribution.lines.map((l) => ({
          participantId: l.participantId,
          type: l.type,
          sharePct: l.sharePct.toFixed(4),
          netProfitEgp: l.netProfit.toFixed(2),
          feeReceivedEgp: l.feeReceived.toFixed(2),
          capitalReturnEgp: l.capitalReturn.toFixed(2),
          payoutEgp: l.payout.toFixed(2),
        })),
      },
    };
  }

  /**
   * Work out what each participant is owed for a cycle.
   *
   * Revenue and COGS are taken from the units actually drawn out of this
   * cycle's batches, so a sale spanning several cycles credits each one for
   * the part it supplied. Capital and profit stay separate components, and a
   * temporary investor's fee comes out of that investor's profit.
   */
  async calculate(cycleId: string, actorId?: string) {
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
    });
    if (!cycle) throw notFound('cycle');

    const participants = await this.prisma.cycleParticipant.findMany({
      where: { cycleId },
      orderBy: { createdAt: 'asc' },
    });
    if (participants.length === 0) {
      throw badRequest('CYCLE_NO_PARTICIPANTS', 'No participants found for this cycle');
    }

    // A settled cycle must not be silently recalculated underneath the
    // partners; only a draft may be superseded.
    const locked = await this.prisma.settlement.findFirst({
      where: { cycleId, status: { in: ['APPROVED', 'PAID'] } },
    });
    if (locked) {
      throw badRequest(
        'SETTLEMENT_LOCKED',
        `Cycle already has a ${locked.status} settlement. Reverse it before recalculating.`,
        { status: locked.status },
      );
    }

    // --- Revenue and COGS from this cycle's batches ------------------------
    const allocations = await this.prisma.saleItemAllocation.findMany({
      where: {
        inventoryBatch: { cycleId },
        saleItem: {
          saleOrder: { status: { in: [...REALISED_ORDER_STATUSES] } },
        },
      },
      include: { saleItem: true },
    });

    const allocationInputs = allocations.map((a) => {
      const qty = new Prisma.Decimal(a.qty);
      const itemQty = new Prisma.Decimal(a.saleItem.quantity);
      // Use the line total so a line-level discount is reflected in revenue.
      const unitPrice = itemQty.gt(0)
        ? new Prisma.Decimal(a.saleItem.lineTotal).div(itemQty)
        : new Prisma.Decimal(0);
      return { qty, unitPrice, cogs: new Prisma.Decimal(a.cogsEgp) };
    });

    // Goods that came back. Netted as negative allocations rather than by
    // editing the sale, so history survives (BRD 9) and the arithmetic stays
    // in one place.
    //
    // A damaged return reverses the revenue but reverses no cost, because the
    // stock never went back on the shelf: cogsReversedEgp is zero for those,
    // and the cost stays spent as a write-off.
    const returnItems = await this.prisma.saleReturnItem.findMany({
      where: {
        inventoryBatch: { cycleId },
        // Must match the allocation filter above: a fully returned order is no
        // longer realised, so its revenue is already excluded and netting its
        // return too would subtract the same money twice.
        saleItem: { saleOrder: { status: { in: [...REALISED_ORDER_STATUSES] } } },
      },
      select: { qty: true, unitPrice: true, cogsReversedEgp: true },
    });

    for (const r of returnItems) {
      allocationInputs.push({
        qty: new Prisma.Decimal(r.qty).neg(),
        unitPrice: new Prisma.Decimal(r.unitPrice),
        cogs: new Prisma.Decimal(r.cogsReversedEgp).neg(),
      });
    }

    // --- Stock still on the shelf -----------------------------------------
    const batches = await this.prisma.inventoryBatch.findMany({
      where: { cycleId },
      select: { remainingQty: true, landedUnitCostEgp: true },
    });
    const unitsRemaining = batches.reduce(
      (s, b) => s.add(b.remainingQty),
      new Prisma.Decimal(0),
    );
    const unsoldValue = batches.reduce(
      (s, b) => s.add(new Prisma.Decimal(b.remainingQty).mul(b.landedUnitCostEgp)),
      new Prisma.Decimal(0),
    );

    // --- Expenses not already inside landed cost ---------------------------
    const expenseTxns = await this.prisma.financialTransaction.findMany({
      where: {
        cycleId,
        direction: 'OUTFLOW',
        category: { notIn: CAPITALISED_CATEGORIES },
      },
      select: { amount: true },
    });
    // Money recovered from suppliers reduces what the cycle cost. It is netted
    // here rather than by re-pricing batches: units already sold keep the cost
    // they were sold at, and a settlement may already have been agreed on it.
    const recoveryTxns = await this.prisma.financialTransaction.findMany({
      where: {
        cycleId,
        direction: 'INFLOW',
        category: { in: COST_RECOVERY_CATEGORIES },
      },
      select: { amount: true },
    });

    const expenses = expenseTxns
      .reduce((s, t) => s.add(t.amount), new Prisma.Decimal(0))
      .sub(recoveryTxns.reduce((s, t) => s.add(t.amount), new Prisma.Decimal(0)));

    const pnl = summarizeCyclePnl({
      allocations: allocationInputs,
      expenses,
      unsoldValue,
      unitsRemaining,
    });

    // --- Distribute -------------------------------------------------------
    const participantInputs: ParticipantInput[] = participants.map((p) => ({
      id: p.id,
      type: p.participantType === 'TEMP_INVESTOR' ? 'TEMP_INVESTOR' : 'CORE_PARTNER',
      contribution: new Prisma.Decimal(p.contributionAmount),
      customProfitPct: p.customProfitPct ? new Prisma.Decimal(p.customProfitPct) : null,
      investorFeePct: p.investorFeePct ? new Prisma.Decimal(p.investorFeePct) : null,
    }));

    const distribution = distributeCycleProfit(participantInputs, pnl.grossProfit);

    const warnings: string[] = [];
    if (!pnl.fullySold) {
      warnings.push(
        `${formatQty(unitsRemaining)} units are still in stock (${formatMoney(pnl.unsoldValue)} EGP at landed cost). Their cost stays with the cycle until they sell, so this profit covers sold units only.`,
      );
    }
    if (allocationInputs.length === 0) {
      warnings.push('This cycle has no realised sales yet.');
    }

    // --- Persist -----------------------------------------------------------
    const settlement = await this.prisma.$transaction(async (tx) => {
      // Supersede any existing draft rather than stacking duplicates.
      const drafts = await tx.settlement.findMany({
        where: { cycleId, status: 'DRAFT' },
        select: { id: true },
      });
      if (drafts.length > 0) {
        const ids = drafts.map((d) => d.id);
        await tx.settlementLine.deleteMany({ where: { settlementId: { in: ids } } });
        await tx.settlement.deleteMany({ where: { id: { in: ids } } });
      }

      const created = await tx.settlement.create({
        data: {
          cycleId,
          status: 'DRAFT',
          calculatedAt: new Date(),
          revenueEgp: pnl.revenue,
          cogsEgp: pnl.cogs,
          expensesEgp: pnl.expenses,
          grossProfitEgp: pnl.grossProfit,
          unsoldValueEgp: pnl.unsoldValue,
          unitsSold: pnl.unitsSold,
          unitsRemaining: pnl.unitsRemaining,
        },
      });

      for (const line of distribution.lines) {
        await tx.settlementLine.create({
          data: {
            settlementId: created.id,
            participantId: line.participantId,
            component: 'CAPITAL_RETURN',
            amount: line.capitalReturn,
          },
        });
        await tx.settlementLine.create({
          data: {
            settlementId: created.id,
            participantId: line.participantId,
            component: 'PROFIT_SHARE',
            amount: line.netProfit,
          },
        });
        if (line.investorFee.gt(0)) {
          await tx.settlementLine.create({
            data: {
              settlementId: created.id,
              participantId: line.participantId,
              component: 'INVESTOR_FEE',
              amount: line.investorFee.neg(),
              feeAmount: line.investorFee,
            },
          });
        }
        if (line.feeReceived.gt(0)) {
          await tx.settlementLine.create({
            data: {
              settlementId: created.id,
              participantId: line.participantId,
              component: 'INVESTOR_FEE_RECEIVED',
              amount: line.feeReceived,
              feeAmount: line.feeReceived,
            },
          });
        }
      }

      return tx.settlement.findUnique({
        where: { id: created.id },
        include: SETTLEMENT_INCLUDE,
      });
    });

    if (actorId) {
      await this.audit.log({
        actorUserId: actorId,
        action: 'CALCULATE',
        entityType: 'Settlement',
        entityId: settlement!.id,
        afterJson: {
          cycleId,
          revenue: pnl.revenue.toFixed(2),
          cogs: pnl.cogs.toFixed(2),
          expenses: pnl.expenses.toFixed(2),
          grossProfit: pnl.grossProfit.toFixed(2),
        },
      });
    }

    return {
      data: settlement,
      summary: {
        revenueEgp: pnl.revenue.toFixed(2),
        cogsEgp: pnl.cogs.toFixed(2),
        expensesEgp: pnl.expenses.toFixed(2),
        grossProfitEgp: pnl.grossProfit.toFixed(2),
        unsoldValueEgp: pnl.unsoldValue.toFixed(2),
        unitsSold: pnl.unitsSold.toFixed(3),
        unitsRemaining: pnl.unitsRemaining.toFixed(3),
        fullySold: pnl.fullySold,
        capitalReturned: distribution.totals.capitalReturned.toFixed(2),
        feesRedistributed: distribution.totals.feesRedistributed.toFixed(2),
        totalPayout: distribution.totals.payout.toFixed(2),
      },
      warnings,
    };
  }

  /**
   * Approve the figures. The cycle moves to SETTLEMENT so it is visibly no
   * longer trading while the payout is arranged.
   */
  async approve(id: string, actorId?: string) {
    const settlement = await this.prisma.settlement.findUnique({ where: { id } });
    if (!settlement) throw notFound('settlement');
    if (settlement.status !== 'DRAFT') {
      throw badRequest('ONLY_DRAFT_APPROVABLE', 'Only DRAFT settlements can be approved');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Update the cycle first: the settlement is read back with its cycle
      // included, so doing it the other way round returns a stale status.
      await tx.importCycle.update({
        where: { id: settlement.cycleId },
        data: { status: 'SETTLEMENT' },
      });

      return tx.settlement.update({
        where: { id },
        data: { status: 'APPROVED', approvedAt: new Date() },
        include: SETTLEMENT_INCLUDE,
      });
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'APPROVE',
      entityType: 'Settlement',
      entityId: id,
      beforeJson: { status: 'DRAFT' },
      afterJson: { status: 'APPROVED' },
    });

    return { data: updated };
  }

  /**
   * Record that the participants have been paid, and close the cycle.
   *
   * Marking a settlement paid used to flip a status and nothing else, so the
   * money left the business without ever appearing in the ledger. Each
   * participant's capital return and profit share are written as outflows, in
   * the same transaction as the status change, so the two can never disagree.
   *
   * The cycle closes here. Unsold stock keeps its cost with the cycle, so
   * closing while stock remains understates what the cycle really cost;
   * `acceptRemainingStock` makes that an explicit decision rather than an
   * accident (BRD 19 leaves the policy open).
   */
  async markPaid(
    id: string,
    actorId?: string,
    opts: { acceptRemainingStock?: boolean } = {},
  ) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: {
        lines: { include: { participant: true } },
        cycle: { select: { id: true, code: true, currency: true } },
      },
    });
    if (!settlement) throw notFound('settlement');
    if (settlement.status !== 'APPROVED') {
      throw badRequest('ONLY_APPROVED_PAYABLE', 'Only APPROVED settlements can be marked as paid');
    }

    const unitsRemaining = new Prisma.Decimal(settlement.unitsRemaining ?? 0);
    if (unitsRemaining.gt(0) && !opts.acceptRemainingStock) {
      throw badRequest(
        'CYCLE_HAS_UNSOLD_STOCK',
        `Cycle ${settlement.cycle.code} still holds ${formatQty(unitsRemaining)} units ` +
          `worth ${formatMoney(settlement.unsoldValueEgp)} EGP at landed cost. ` +
          'Closing now writes that cost off against this cycle. ' +
          'Sell the remaining stock first, or confirm explicitly to accept it.',
        {
          cycle: settlement.cycle.code,
          units: formatQty(unitsRemaining),
          value: formatMoney(settlement.unsoldValueEgp),
        },
      );
    }

    // What each participant actually receives: capital back, their profit share
    // (already net of any fee charged to them), and any fee they receive.
    //
    // The INVESTOR_FEE line is a memo of what was deducted — the deduction is
    // already inside that participant's PROFIT_SHARE. Counting it again here
    // makes the payouts disagree with both the settlement screen and
    // settlement-math, and the total stops reconciling to capital plus profit.
    const PAYABLE_COMPONENTS = ['CAPITAL_RETURN', 'PROFIT_SHARE', 'INVESTOR_FEE_RECEIVED'];

    const payouts = new Map<string, Prisma.Decimal>();
    for (const line of settlement.lines) {
      if (!PAYABLE_COMPONENTS.includes(line.component)) continue;
      const key = line.participantId;
      payouts.set(
        key,
        (payouts.get(key) ?? new Prisma.Decimal(0)).add(new Prisma.Decimal(line.amount)),
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const [participantId, amount] of payouts) {
        if (amount.isZero()) continue;
        const participant = settlement.lines.find(
          (l) => l.participantId === participantId,
        )?.participant;

        await tx.financialTransaction.create({
          data: {
            type: 'SETTLEMENT_PAYOUT',
            category: 'settlement',
            // A negative net would be the participant owing the business.
            direction: amount.gt(0) ? 'OUTFLOW' : 'INFLOW',
            amount: amount.abs().toDecimalPlaces(2),
            currency: 'EGP',
            cycleId: settlement.cycleId,
            relatedType: 'SETTLEMENT',
            relatedId: settlement.id,
            reason:
              `Settlement of ${settlement.cycle.code}: capital and profit paid to ` +
              `${participant?.participantType === 'TEMP_INVESTOR' ? 'investor' : 'partner'}`,
            createdBy: actorId,
          },
        });
      }

      await tx.importCycle.update({
        where: { id: settlement.cycleId },
        data: { status: 'CLOSED', closedOn: new Date() },
      });

      return tx.settlement.update({
        where: { id },
        data: { status: 'PAID', paidAt: new Date() },
        include: SETTLEMENT_INCLUDE,
      });
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'PAY',
      entityType: 'Settlement',
      entityId: id,
      beforeJson: { status: 'APPROVED' },
      afterJson: {
        status: 'PAID',
        cycleClosed: true,
        payouts: [...payouts.entries()].map(([participantId, amount]) => ({
          participantId,
          amount: amount.toFixed(2),
        })),
        acceptedRemainingStock: opts.acceptRemainingStock ?? false,
      },
    });

    return { data: updated };
  }

  /**
   * Undo a settlement.
   *
   * Financial history is never rewritten (BRD 10), so this writes reversing
   * entries against whatever was paid rather than deleting or editing the
   * originals, and reopens the cycle for selling.
   */
  async reverse(id: string, reason: string, actorId?: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { cycle: { select: { id: true, code: true } } },
    });
    if (!settlement) throw notFound('settlement');
    if (settlement.status === 'REVERSED') {
      throw badRequest('SETTLEMENT_ALREADY_REVERSED', 'Settlement is already reversed');
    }
    if (!reason?.trim()) {
      throw badRequest('SETTLEMENT_REASON_REQUIRED', 'A reason is required to reverse a settlement');
    }

    const paid = await this.prisma.financialTransaction.findMany({
      where: {
        relatedType: 'SETTLEMENT',
        relatedId: settlement.id,
        type: 'SETTLEMENT_PAYOUT',
      },
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const original of paid) {
        await tx.financialTransaction.create({
          data: {
            type: 'SETTLEMENT_REVERSAL',
            category: 'settlement',
            // Mirror the original so the pair nets to zero.
            direction: original.direction === 'OUTFLOW' ? 'INFLOW' : 'OUTFLOW',
            amount: original.amount,
            currency: original.currency,
            cycleId: original.cycleId,
            relatedType: 'SETTLEMENT',
            relatedId: settlement.id,
            reason: `Reversal of ${settlement.cycle.code} settlement: ${reason}`,
            createdBy: actorId,
          },
        });
      }

      // A reversed settlement means the cycle is trading again.
      await tx.importCycle.update({
        where: { id: settlement.cycleId },
        data: { status: 'SELLING', closedOn: null },
      });

      return tx.settlement.update({
        where: { id },
        data: { status: 'REVERSED' },
        include: SETTLEMENT_INCLUDE,
      });
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'REVERSE',
      entityType: 'Settlement',
      entityId: id,
      beforeJson: { status: settlement.status },
      afterJson: { status: 'REVERSED', reason, entriesReversed: paid.length },
    });

    return { data: updated };
  }
}
