import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import {
  distributeCycleProfit,
  summarizeCyclePnl,
  ParticipantInput,
} from './settlement-math';

/** Sale states whose stock has genuinely left the business. */
const REALISED_ORDER_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'] as const;

/**
 * Ledger categories already capitalised into batch landed cost. Counting them
 * as period expenses too would charge the cycle twice.
 */
const CAPITALISED_CATEGORIES = ['purchase', 'shipping'];

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
          investor: { select: { id: true, email: true } },
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
                investor: { select: { id: true, email: true } },
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
                investor: { select: { id: true, email: true } },
              },
            },
          },
        },
      },
    });
    if (!settlement) throw new NotFoundException('Settlement not found');
    return { data: settlement };
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
    if (!cycle) throw new NotFoundException('Cycle not found');

    const participants = await this.prisma.cycleParticipant.findMany({
      where: { cycleId },
      orderBy: { createdAt: 'asc' },
    });
    if (participants.length === 0) {
      throw new BadRequestException('No participants found for this cycle');
    }

    // A settled cycle must not be silently recalculated underneath the
    // partners; only a draft may be superseded.
    const locked = await this.prisma.settlement.findFirst({
      where: { cycleId, status: { in: ['APPROVED', 'PAID'] } },
    });
    if (locked) {
      throw new BadRequestException(
        `Cycle already has a ${locked.status} settlement. Reverse it before recalculating.`,
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
    const expenses = expenseTxns.reduce(
      (s, t) => s.add(t.amount),
      new Prisma.Decimal(0),
    );

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
        `${unitsRemaining.toFixed(3)} units are still in stock (${pnl.unsoldValue.toFixed(2)} EGP at landed cost). Their cost stays with the cycle until they sell, so this profit covers sold units only.`,
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

  async approve(id: string) {
    const settlement = await this.prisma.settlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundException('Settlement not found');
    if (settlement.status !== 'DRAFT') {
      throw new BadRequestException('Only DRAFT settlements can be approved');
    }

    const updated = await this.prisma.settlement.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
      },
      include: {
        cycle: { select: { id: true, code: true, status: true } },
      },
    });

    return { data: updated };
  }

  async markPaid(id: string) {
    const settlement = await this.prisma.settlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundException('Settlement not found');
    if (settlement.status !== 'APPROVED') {
      throw new BadRequestException('Only APPROVED settlements can be marked as paid');
    }

    const updated = await this.prisma.settlement.update({
      where: { id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
      },
      include: {
        cycle: { select: { id: true, code: true, status: true } },
      },
    });

    return { data: updated };
  }

  async reverse(id: string, reason: string) {
    const settlement = await this.prisma.settlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundException('Settlement not found');
    if (settlement.status === 'REVERSED') {
      throw new BadRequestException('Settlement is already reversed');
    }

    const updated = await this.prisma.settlement.update({
      where: { id },
      data: {
        status: 'REVERSED',
      },
      include: {
        cycle: { select: { id: true, code: true, status: true } },
      },
    });

    return { data: updated };
  }
}
