import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PaginationDto,
  pageSize,
  cursorPage,
} from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CostingService } from '../costing/costing.service';
import {
  distributeCycleProfit,
  summarizeCyclePnl,
  ParticipantInput,
} from './settlement-math';
import { formatMoney, formatQty } from '../../common/money';

import { badRequest, notFound } from '../../common/api-error';
import { fundingChangedSince } from '../../common/funding-lock';
import {
  COST_RECOVERY_CATEGORIES,
  NOT_OPERATING_EXPENSE,
  OTHER_INCOME_CATEGORIES,
  netOperatingExpenseEgp,
  netOtherIncomeEgp,
  netRecoveredEgp,
} from '../../common/ledger-categories';
import { cycleWriteOffsEgp } from '../../common/cycle-losses';
import { assertCycleHasNoSamplesOut } from '../../common/samples-out';
import { lockCycle } from '../../common/shipment-load';
import { assertShipmentAccounted } from '../../common/shipment-accounted';
import {
  assertLendersRepaid,
  exchangeDifferenceEgp,
} from '../../common/lender-debt';
import {
  assertInScope,
  cycleIdWhere,
  cyclesVisibleTo,
  ownParticipantIds,
  type ScopeViewer,
} from '../../common/investor-scope';
import { isUuid } from '../../common/uuid';
import { settlementWarnings } from './settlement-warnings';
import { unsoldStock } from '../../common/unsold-stock';
import { assertDayRange, businessDay, businessToday } from '../../common/dates';
import { RUNNING_COST_SHARE_CATEGORY } from '../../common/ledger-categories';
import {
  buildPayoutBreakdown,
  cycleCostLines,
  type PayoutBreakdown,
} from '../../common/payout-breakdown';
import {
  fixRunningCostShares,
  loadRunningCosts,
  periodOf,
  planRunningCostCharges,
  summariseRunningCosts,
  thisQuarter,
  type PlannedCharge,
} from '../../common/running-costs';
import { cycleTransfersOutEgp } from '../../common/stock-transfers';

/**
 * What a participant is actually handed: capital back, their profit share
 * (already net of any fee charged to them), any fee they receive, and — since
 * L7 — less the running costs his payout took (RUNNING_COSTS, negative).
 *
 * The INVESTOR_FEE line is a memo of what was deducted — the deduction is
 * already inside that participant's PROFIT_SHARE. Counting it again makes the
 * payouts disagree with both the settlement screen and settlement-math, and
 * the total stops reconciling to capital plus profit.
 */
const PAYABLE_COMPONENTS = [
  'CAPITAL_RETURN',
  'PROFIT_SHARE',
  'INVESTOR_FEE_RECEIVED',
  'RUNNING_COSTS',
];

/**
 * One payout at a time takes running costs (§8, L7): two settlements paid at
 * the same moment would each read the same costs as waiting and charge them
 * twice. A transaction-scoped advisory lock — released on commit or rollback.
 */
const RUNNING_COSTS_LOCK = 7_000_000_007;

/** Sum the payable lines per participant. */
function payableByParticipant(
  lines: {
    participantId: string;
    component: string;
    amount: Prisma.Decimal.Value;
  }[],
): Map<string, Prisma.Decimal> {
  const payouts = new Map<string, Prisma.Decimal>();
  for (const line of lines) {
    if (!PAYABLE_COMPONENTS.includes(line.component)) continue;
    payouts.set(
      line.participantId,
      (payouts.get(line.participantId) ?? new Prisma.Decimal(0)).add(
        new Prisma.Decimal(line.amount),
      ),
    );
  }
  return payouts;
}

/**
 * Each core partner's payout on a settlement, by user — what his share of the
 * running costs may take from (§8, L7). A temporary investor is not in it, so
 * is never charged; nor is a core partner's own money put in as an investor.
 */
function corePartnerPayouts(
  lines: {
    participantId: string;
    component: string;
    amount: Prisma.Decimal.Value;
    participant: { participantType: string; partnerUserId: string | null };
  }[],
) {
  const payouts = payableByParticipant(lines);
  const capacities = new Map<string, Prisma.Decimal>();
  const participantOf = new Map<string, string>();
  for (const l of lines) {
    const userId = l.participant.partnerUserId;
    if (l.participant.participantType !== 'CORE_PARTNER' || !userId) continue;
    if (participantOf.has(userId)) continue;
    participantOf.set(userId, l.participantId);
    capacities.set(
      userId,
      payouts.get(l.participantId) ?? new Prisma.Decimal(0),
    );
  }
  return { capacities, participantOf };
}
/** Sale states whose stock has genuinely left the business. */
const REALISED_ORDER_STATUSES = [
  'CONFIRMED',
  'PARTIALLY_PAID',
  'PAID',
] as const;

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
    private costing: CostingService = new CostingService(prisma),
  ) {}

  async findAll(
    query: PaginationDto & {
      cycleId?: string;
      status?: string;
    },
    viewer: ScopeViewer = 'internal',
  ) {
    const { cursor, limit: rawLimit = 20, cycleId, status } = query;
    const limit = pageSize(rawLimit);

    const where: Prisma.SettlementWhereInput = {};
    // An investor: their cycles' settlements, and on each only their own
    // lines; the settlement's totals are the cycle's, which they may see (R1).
    const cycleFilter = cycleIdWhere(
      await cyclesVisibleTo(viewer, this.prisma),
      cycleId,
    );
    if (cycleFilter) where.cycleId = cycleFilter;
    if (status) where.status = status as Prisma.SettlementWhereInput['status'];
    const own = await ownParticipantIds(viewer, this.prisma);

    const items = await this.prisma.settlement.findMany({
      where,
      ...cursorPage(cursor, limit),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        cycle: { select: { id: true, code: true, status: true } },
        lines: {
          ...(own ? { where: { participantId: { in: [...own] } } } : {}),
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
    const page = hasMore ? items.slice(0, limit) : items;
    // Each payout laid out line by line (§8, L7) — an investor's only for the
    // lines he may see, which are the only ones loaded.
    const breakdowns = await this.breakdownsFor(page);
    const data = page.map((s) => ({ ...s, breakdown: breakdowns.get(s.id) }));
    return {
      data,
      meta: {
        nextCursor: hasMore ? data[data.length - 1].id : null,
        limit,
      },
    };
  }

  async findOne(id: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(id)) throw notFound('settlement');
    const own = await ownParticipantIds(viewer, this.prisma);
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: {
        cycle: { select: { id: true, code: true, status: true } },
        lines: {
          ...(own ? { where: { participantId: { in: [...own] } } } : {}),
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
    // Another cycle's settlement reads as missing to an investor (R1).
    assertInScope(
      await cyclesVisibleTo(viewer, this.prisma),
      settlement.cycleId,
      'settlement',
    );
    const breakdowns = await this.breakdownsFor([settlement]);
    return {
      data: { ...settlement, breakdown: breakdowns.get(settlement.id) },
    };
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
        saleItem: {
          saleOrder: { status: { in: [...REALISED_ORDER_STATUSES] } },
        },
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

    // Prices lowered after the sale (§4, 2026-10-22), this cycle's share, as
    // stored — the figure the dashboard takes off too. Written as the held
    // units taken back at what was lowered and handed out again at nothing,
    // so revenue drops by exactly that and units sold and cost stay put.
    const adjustmentItems = await this.prisma.salePriceAdjustmentItem.findMany({
      where: {
        inventoryBatch: { cycleId },
        adjustment: {
          saleOrder: { status: { in: [...REALISED_ORDER_STATUSES] } },
        },
      },
      select: { qty: true, amountEgp: true },
    });
    for (const a of adjustmentItems) {
      const qty = new Prisma.Decimal(a.qty);
      if (qty.lte(0)) continue;
      allocationInputs.push(
        {
          qty: qty.neg(),
          unitPrice: new Prisma.Decimal(a.amountEgp).div(qty),
          cogs: new Prisma.Decimal(0),
        },
        { qty, unitPrice: new Prisma.Decimal(0), cogs: new Prisma.Decimal(0) },
      );
    }

    // --- Stock still on the shelf -----------------------------------------
    // Leftovers moved to another cycle (§8, L5) have left these batches, so
    // they are no longer here — and the moved batch on the cycle that took
    // them is that cycle's own stock. One reading (common/unsold-stock.ts).
    const { unitsRemaining, unsoldValue } = await unsoldStock(
      this.prisma,
      cycleId,
    );

    // --- Expenses not already inside landed cost ---------------------------
    // Both directions: a reversed expense (money back in, pointing at it) is
    // taken off again, through the one signed reading the cycle page and the
    // dashboard use (L6, rule 11). Recoveries and other income are netted
    // below, not charged here.
    const expenseTxns = await this.prisma.financialTransaction.findMany({
      where: {
        cycleId,
        category: { notIn: [...NOT_OPERATING_EXPENSE] },
      },
      select: {
        amount: true,
        direction: true,
        category: true,
        reversalOfId: true,
      },
    });
    // Other income charged to the cycle raises its profit (§9, L6), net of
    // any undone.
    const otherIncomeTxns = await this.prisma.financialTransaction.findMany({
      where: {
        cycleId,
        category: { in: [...OTHER_INCOME_CATEGORIES] },
      },
      select: { amount: true, direction: true, category: true },
    });
    // Money recovered from suppliers reduces what the cycle cost. It is netted
    // here rather than by re-pricing batches: units already sold keep the cost
    // they were sold at, and a settlement may already have been agreed on it.
    // Both directions: an undone refund's OUTFLOW takes its inflow back
    // (B5b), through the one signed reading analytics uses too (rule 11).
    const recoveryTxns = await this.prisma.financialTransaction.findMany({
      where: {
        cycleId,
        category: { in: [...COST_RECOVERY_CATEGORIES] },
      },
      select: { amount: true, direction: true, category: true },
    });

    // Goods lost on the way are a loss against the cycle (§2, §8). No money
    // moved when they were marked, so they are not in the ledger and are
    // added here on purpose — through the one definition analytics reads too
    // (§9, rule 11).
    // Samples the shops kept or lost (§4, samples at shops) are the same
    // kind of cost — goods paid for that will never sell — through the one
    // definition the dashboard and the P&L read too.
    const writeOffs = await cycleWriteOffsEgp(this.prisma, cycleId);
    const losses = writeOffs.total;

    // What repaying a friend in pounds cost beyond his payment at the order's
    // rate (§18): a cost when the dirham rose, a gain when it fell. Read from
    // the repayments through the one definition analytics reads too.
    const exchangeDiff = await exchangeDifferenceEgp(this.prisma, cycleId);

    const expenses = netOperatingExpenseEgp(expenseTxns)
      .sub(netRecoveredEgp(recoveryTxns))
      .sub(netOtherIncomeEgp(otherIncomeTxns))
      .add(losses)
      .add(exchangeDiff);

    // The same figures, line by line, so the payout can explain itself (§8,
    // L7). From these very rows — they add up to `expenses` exactly.
    const costLines = cycleCostLines({
      expenseRows: expenseTxns,
      recoveryRows: recoveryTxns,
      otherIncomeRows: otherIncomeTxns,
      lossesEgp: writeOffs.lostOnTheWay,
      samplesWrittenOffEgp: writeOffs.samplesWrittenOff,
      exchangeDifferenceEgp: exchangeDiff,
    });

    const pnl = summarizeCyclePnl({
      allocations: allocationInputs,
      expenses,
      unsoldValue,
      unitsRemaining,
    });

    // --- Distribute -------------------------------------------------------
    const participantInputs: ParticipantInput[] = participants.map((p) => ({
      id: p.id,
      type:
        p.participantType === 'TEMP_INVESTOR'
          ? 'TEMP_INVESTOR'
          : 'CORE_PARTNER',
      contribution: new Prisma.Decimal(p.contributionAmount),
      customProfitPct: p.customProfitPct
        ? new Prisma.Decimal(p.customProfitPct)
        : null,
      investorFeePct: p.investorFeePct
        ? new Prisma.Decimal(p.investorFeePct)
        : null,
    }));

    // No contributions and no agreed split refuses (`CYCLE_NOT_FUNDED`),
    // a cycle a friend paid for included (owner 2026-10-19, §18): the
    // partners' shares of repaying him are their contributions.
    const distribution = distributeCycleProfit(
      participantInputs,
      pnl.grossProfit,
    );
    return {
      pnl,
      distribution,
      participants,
      lossesEgp: losses,
      exchangeDifferenceEgp: exchangeDiff,
      costLines,
      hasAllocations: allocationInputs.length > 0,
    };
  }

  /**
   * Of these cycles, the ones with anything that can move the profit
   * `project` works out: a sale or return drawn from their stock (samples
   * written off included), a ledger row in a category it reads, goods lost on
   * the way, a repayment to a friend. Each query is a superset of what
   * `project` reads, so a cycle left out projects a profit of exactly zero —
   * and asking it costs ten queries for that zero. Four queries for the lot.
   *
   * Kept beside `project` on purpose: a new input there must be added here.
   */
  async cyclesWithProfitActivity(cycleIds: string[]): Promise<Set<string>> {
    if (cycleIds.length === 0) return new Set();
    const [batches, ledger, losses, repayments] = await Promise.all([
      this.prisma.inventoryBatch.findMany({
        where: {
          cycleId: { in: cycleIds },
          OR: [
            { saleItemAllocations: { some: {} } },
            { returnItems: { some: {} } },
            { priceAdjustmentItems: { some: {} } },
          ],
        },
        select: { cycleId: true },
        distinct: ['cycleId'],
      }),
      this.prisma.financialTransaction.findMany({
        where: {
          cycleId: { in: cycleIds },
          OR: [
            { category: { notIn: [...NOT_OPERATING_EXPENSE] } },
            { category: { in: [...OTHER_INCOME_CATEGORIES] } },
            { category: { in: [...COST_RECOVERY_CATEGORIES] } },
          ],
        },
        select: { cycleId: true },
        distinct: ['cycleId'],
      }),
      this.prisma.shipmentLoss.findMany({
        where: { leg: { cycleId: { in: cycleIds } } },
        select: { leg: { select: { cycleId: true } } },
      }),
      this.prisma.lenderRepayment.findMany({
        where: { financing: { cycleId: { in: cycleIds } } },
        select: { financing: { select: { cycleId: true } } },
      }),
    ]);
    return new Set<string>([
      ...batches.map((b) => b.cycleId),
      ...ledger.map((t) => t.cycleId as string),
      ...losses.map((l) => l.leg.cycleId),
      ...repayments.map((r) => r.financing.cycleId),
    ]);
  }

  /**
   * What `calculate` would produce, without producing it.
   *
   * Lets a cycle still selling be asked what it has earned so far — which the
   * partners page needs, and which anyone about to settle wants to see before
   * they commit to it.
   */
  async preview(cycleId: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(cycleId)) throw notFound('cycle');
    assertInScope(await cyclesVisibleTo(viewer, this.prisma), cycleId);
    const own = await ownParticipantIds(viewer, this.prisma);
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
    });
    if (!cycle) throw notFound('cycle');

    const projected = await this.project(cycleId);
    if (!projected) {
      throw badRequest(
        'CYCLE_NO_PARTICIPANTS',
        'No participants found for this cycle',
      );
    }

    return {
      data: {
        cycleId,
        cycleCode: cycle.code,
        status: cycle.status,
        revenueEgp: projected.pnl.revenue.toFixed(2),
        cogsEgp: projected.pnl.cogs.toFixed(2),
        expensesEgp: projected.pnl.expenses.toFixed(2),
        /** Goods lost on the way, already inside expensesEgp (§2). */
        lossesEgp: projected.lossesEgp.toFixed(2),
        /** Repaying friends at a moved rate (§18), already inside expensesEgp. */
        exchangeDifferenceEgp: projected.exchangeDifferenceEgp.toFixed(2),
        /** expensesEgp line by line (§8, L7); the lines sum to it. */
        costs: projected.costLines,
        grossProfitEgp: projected.pnl.grossProfit.toFixed(2),
        unsoldValueEgp: projected.pnl.unsoldValue.toFixed(2),
        fullySold: projected.pnl.fullySold,
        // An investor: their own payout line only (R1).
        lines: projected.distribution.lines
          .filter((l) => own === null || own.includes(l.participantId))
          .map((l) => ({
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
      throw badRequest(
        'CYCLE_NO_PARTICIPANTS',
        'No participants found for this cycle',
      );
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

    // Not while any of its units are out at shops as samples (DECIDED, owner
    // 2026-10-18): they are neither sold nor on the shelf, so the profit
    // would be a guess.
    await assertCycleHasNoSamplesOut(this.prisma, cycleId, cycle.code);

    // The same arithmetic `preview` shows, so what a partner was shown is
    // what is settled — losses on the way included (§8).
    const projected = await this.project(cycleId);
    if (!projected) {
      throw badRequest(
        'CYCLE_NO_PARTICIPANTS',
        'No participants found for this cycle',
      );
    }
    const { pnl, distribution } = projected;
    const unitsRemaining = pnl.unitsRemaining;

    const warnings = settlementWarnings({
      fullySold: pnl.fullySold,
      unitsRemaining,
      unsoldValue: pnl.unsoldValue,
      hasAllocations: projected.hasAllocations,
    });

    // --- Persist -----------------------------------------------------------
    const settlement = await this.prisma.$transaction(async (tx) => {
      // Under the cycle's lock, which Approve takes too: a Calculate and an
      // Approve racing on one cycle run one after the other, never with the
      // draft deleted underneath the approval (that answered 500, P2025).
      await lockCycle(tx, cycleId);
      // Approved while this was being worked out: not superseded after all.
      const settledMeanwhile = await tx.settlement.findFirst({
        where: { cycleId, status: { in: ['APPROVED', 'PAID'] } },
        select: { status: true },
      });
      if (settledMeanwhile) {
        throw badRequest(
          'SETTLEMENT_LOCKED',
          `Cycle already has a ${settledMeanwhile.status} settlement. Reverse it before recalculating.`,
          { status: settledMeanwhile.status },
        );
      }
      // Supersede any existing draft rather than stacking duplicates.
      const drafts = await tx.settlement.findMany({
        where: { cycleId, status: 'DRAFT' },
        select: { id: true },
      });
      if (drafts.length > 0) {
        const ids = drafts.map((d) => d.id);
        await tx.settlementLine.deleteMany({
          where: { settlementId: { in: ids } },
        });
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
          // Kept with the figures, so an approved or paid settlement explains
          // itself exactly as it was agreed (§8, L7).
          costBreakdown: {
            costs: projected.costLines,
          } as unknown as Prisma.InputJsonValue,
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
        /** Goods lost on the way, already inside expensesEgp (§2). */
        lossesEgp: projected.lossesEgp.toFixed(2),
        /** Repaying friends at a moved rate (§18), already inside expensesEgp. */
        exchangeDifferenceEgp: projected.exchangeDifferenceEgp.toFixed(2),
        costs: projected.costLines,
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
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
    });
    if (!settlement) throw notFound('settlement');
    if (settlement.status !== 'DRAFT') {
      throw badRequest(
        'ONLY_DRAFT_APPROVABLE',
        'Only DRAFT settlements can be approved',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Every unit ordered received or marked lost first (§8, amendment 5):
      // the same gate the plain transition to SETTLEMENT runs, under the
      // cycle's lock so a loss taken back cannot slip in between.
      await lockCycle(tx, settlement.cycleId);
      // Read again under the lock: a Calculate that finished while this
      // waited has replaced the draft (gone: not found, with its code — the
      // new draft is the one to approve) or another Approve got there first.
      const current = await tx.settlement.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!current) throw notFound('settlement');
      if (current.status !== 'DRAFT') {
        throw badRequest(
          'ONLY_DRAFT_APPROVABLE',
          'Only DRAFT settlements can be approved',
        );
      }
      // Funding changed after this draft was calculated (owner 2026-10-18):
      // its split is no longer the cycle's. Calculating again supersedes it.
      if (
        settlement.calculatedAt &&
        (await fundingChangedSince(
          tx,
          settlement.cycleId,
          settlement.calculatedAt,
        ))
      ) {
        throw badRequest(
          'SETTLEMENT_STALE_FUNDING',
          'The funding changed after this settlement was calculated. Calculate it again before approving.',
        );
      }
      await assertShipmentAccounted(tx, settlement.cycleId);
      // And no friend still owed (§18) — the gate the transition runs too.
      const cycle = await tx.importCycle.findUnique({
        where: { id: settlement.cycleId },
        select: { code: true },
      });
      await assertLendersRepaid(
        tx,
        settlement.cycleId,
        cycle?.code ?? settlement.cycleId,
      );
      // And no samples out at a shop (§4, samples at shops).
      await assertCycleHasNoSamplesOut(
        tx,
        settlement.cycleId,
        cycle?.code ?? settlement.cycleId,
      );

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
      throw badRequest(
        'ONLY_APPROVED_PAYABLE',
        'Only APPROVED settlements can be marked as paid',
      );
    }

    // Samples left at a shop after approval stop the payout too (§4).
    await assertCycleHasNoSamplesOut(
      this.prisma,
      settlement.cycleId,
      settlement.cycle.code,
    );

    // What the cycle holds NOW, not what it held when the figures were
    // calculated: leftovers moved to another cycle after approval (§8, L5)
    // have left, and paying out must not ask to write them off.
    const { unitsRemaining, unsoldValue } = await unsoldStock(
      this.prisma,
      settlement.cycleId,
    );
    if (unitsRemaining.gt(0) && !opts.acceptRemainingStock) {
      throw badRequest(
        'CYCLE_HAS_UNSOLD_STOCK',
        `Cycle ${settlement.cycle.code} still holds ${formatQty(unitsRemaining)} units ` +
          `worth ${formatMoney(unsoldValue)} EGP at landed cost. ` +
          'Closing now writes that cost off against this cycle. ' +
          'Sell the remaining stock first, or confirm explicitly to accept it.',
        {
          cycle: settlement.cycle.code,
          units: formatQty(unitsRemaining),
          value: formatMoney(unsoldValue),
          // So the refusal can offer "Move leftovers" for this cycle (L5).
          cycleId: settlement.cycleId,
        },
      );
    }

    const charged: PlannedCharge[] = [];
    const payouts = new Map<string, Prisma.Decimal>();

    const updated = await this.prisma.$transaction(async (tx) => {
      // One payout at a time takes running costs, and this one is still
      // payable once it holds the lock (a second click waits, then refuses).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUNNING_COSTS_LOCK})`;
      const fresh = await tx.settlement.findUnique({
        where: { id },
        select: { status: true },
      });
      if (fresh?.status !== 'APPROVED') {
        throw badRequest(
          'ONLY_APPROVED_PAYABLE',
          'Only APPROVED settlements can be marked as paid',
        );
      }

      // --- His share of the running costs (§8, owner 2026-10-11; L7) -------
      // Each core partner on this cycle: his equal share of the general
      // running costs still waiting, oldest first, as far as this payout
      // covers. The cycle's profit is not touched — it comes off his payout.
      // Shares fixed first: any cost seen for the first time gets its shares
      // stored now, over the partners of its own day (§8, review 2026-10-12).
      const state = await fixRunningCostShares(tx);
      const { capacities, participantOf } = corePartnerPayouts(
        settlement.lines,
      );
      const plan = planRunningCostCharges({ ...state, capacities });
      const costDay = new Map(state.costs.map((c) => [c.id, c.day]));
      const takenBy = new Map<string, Prisma.Decimal>();
      for (const c of plan) {
        takenBy.set(
          c.partnerUserId,
          (takenBy.get(c.partnerUserId) ?? new Prisma.Decimal(0)).add(c.amount),
        );
      }

      for (const [userId, total] of takenBy) {
        const participantId = participantOf.get(userId)!;
        const mine = plan.filter((c) => c.partnerUserId === userId);
        const period = periodOf(mine.map((c) => costDay.get(c.costEntryId)!));
        for (const c of mine) {
          await tx.runningCostCharge.create({
            data: {
              costEntryId: c.costEntryId,
              settlementId: settlement.id,
              participantId,
              partnerUserId: userId,
              amount: c.amount,
            },
          });
          charged.push(c);
        }
        // On the settlement, beside his capital and profit: what he is paid
        // is the sum of its payable lines (PAYABLE_COMPONENTS).
        await tx.settlementLine.create({
          data: {
            settlementId: settlement.id,
            participantId,
            component: 'RUNNING_COSTS',
            amount: total.neg(),
          },
        });
        // In the ledger: the deduction, so the payout row below (the cash
        // actually handed over) and his record agree. Not cash, not an
        // expense — the cost was an expense when it was recorded
        // (`running_cost_share`, ledger-categories.ts).
        await tx.financialTransaction.create({
          data: {
            type: 'RUNNING_COST_CHARGE',
            category: RUNNING_COST_SHARE_CATEGORY,
            direction: 'INFLOW',
            amount: total,
            currency: 'EGP',
            cycleId: settlement.cycleId,
            relatedType: 'SETTLEMENT',
            relatedId: settlement.id,
            reason:
              `Settlement of ${settlement.cycle.code}: share of running costs ` +
              `${period ? `${period.from} – ${period.to} ` : ''}taken from the partner's payout`,
            createdBy: actorId,
          },
        });
      }

      // --- What each participant is handed ---------------------------------
      const userOf = new Map(
        [...participantOf.entries()].map(([userId, pid]) => [pid, userId]),
      );
      for (const [participantId, amount] of payableByParticipant(
        settlement.lines,
      )) {
        const userId = userOf.get(participantId);
        const taken = userId ? takenBy.get(userId) : undefined;
        const net = taken ? amount.sub(taken) : amount;
        payouts.set(participantId, net);
        if (net.isZero()) continue;
        const participant = settlement.lines.find(
          (l) => l.participantId === participantId,
        )?.participant;

        await tx.financialTransaction.create({
          data: {
            type: 'SETTLEMENT_PAYOUT',
            category: 'settlement',
            // A negative net would be the participant owing the business.
            direction: net.gt(0) ? 'OUTFLOW' : 'INFLOW',
            amount: net.abs().toDecimalPlaces(2),
            currency: 'EGP',
            cycleId: settlement.cycleId,
            relatedType: 'SETTLEMENT',
            relatedId: settlement.id,
            reason:
              `Settlement of ${settlement.cycle.code}: capital and profit paid to ` +
              `${participant?.participantType === 'TEMP_INVESTOR' ? 'investor' : 'partner'}` +
              (taken ? ', less his share of running costs' : ''),
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
        runningCostsCharged: charged.map((c) => ({
          costEntryId: c.costEntryId,
          partnerUserId: c.partnerUserId,
          amount: c.amount.toFixed(2),
        })),
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
      throw badRequest(
        'SETTLEMENT_ALREADY_REVERSED',
        'Settlement is already reversed',
      );
    }
    if (!reason?.trim()) {
      throw badRequest(
        'SETTLEMENT_REASON_REQUIRED',
        'A reason is required to reverse a settlement',
      );
    }

    // The payouts, and the running-cost deductions taken from them (L7).
    const paid = await this.prisma.financialTransaction.findMany({
      where: {
        relatedType: 'SETTLEMENT',
        relatedId: settlement.id,
        type: { in: ['SETTLEMENT_PAYOUT', 'RUNNING_COST_CHARGE'] },
      },
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const original of paid) {
        await tx.financialTransaction.create({
          data: {
            type:
              original.type === 'RUNNING_COST_CHARGE'
                ? 'RUNNING_COST_CHARGE_REVERSAL'
                : 'SETTLEMENT_REVERSAL',
            category: original.category,
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

      // The running costs its payouts took are waiting again (§8, L7). The
      // rows stay, marked released: history is not rewritten.
      await tx.runningCostCharge.updateMany({
        where: { settlementId: settlement.id, releasedAt: null },
        data: { releasedAt: new Date() },
      });

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

  /**
   * Each settlement laid out line by line (§8 "a payout explains itself",
   * L7), from its own stored figures and lines — nothing recomputed beside it.
   *
   * Running costs: a paid settlement shows the charges its payouts took (a
   * reversed one, the charges it put back); a draft or approved one shows what
   * paying it now would take, through the very plan Mark paid runs.
   */
  async breakdownsFor<
    S extends {
      id: string;
      cycleId: string;
      status: string;
      revenueEgp: Prisma.Decimal | null;
      cogsEgp: Prisma.Decimal | null;
      expensesEgp: Prisma.Decimal | null;
      grossProfitEgp: Prisma.Decimal | null;
      costBreakdown: Prisma.JsonValue | null;
      lines: {
        participantId: string;
        component: string;
        amount: Prisma.Decimal;
        participant: { participantType: string; partnerUserId: string | null };
      }[];
    },
  >(settlements: S[]): Promise<Map<string, PayoutBreakdown>> {
    const out = new Map<string, PayoutBreakdown>();
    if (settlements.length === 0) return out;

    const settledIds = settlements
      .filter((s) => s.status === 'PAID' || s.status === 'REVERSED')
      .map((s) => s.id);
    const taken = settledIds.length
      ? await this.prisma.runningCostCharge.findMany({
          where: { settlementId: { in: settledIds } },
          select: {
            settlementId: true,
            participantId: true,
            amount: true,
            releasedAt: true,
            costEntry: { select: { occurredOn: true, createdAt: true } },
          },
        })
      : [];

    const open = settlements.filter(
      (s) => s.status === 'DRAFT' || s.status === 'APPROVED',
    );
    const state = open.length ? await loadRunningCosts(this.prisma) : null;

    const leftovers = new Map<string, Prisma.Decimal>();
    for (const cycleId of new Set(settlements.map((s) => s.cycleId))) {
      leftovers.set(cycleId, await cycleTransfersOutEgp(this.prisma, cycleId));
    }

    for (const s of settlements) {
      const running = new Map<
        string,
        { amountEgp: Prisma.Decimal; from: string | null; to: string | null }
      >();
      const add = (
        participantId: string,
        amount: Prisma.Decimal,
        day: string,
      ) => {
        const prev = running.get(participantId);
        const days = [day, prev?.from, prev?.to].filter(
          (d): d is string => !!d,
        );
        const period = periodOf(days);
        running.set(participantId, {
          amountEgp: (prev?.amountEgp ?? new Prisma.Decimal(0)).add(amount),
          from: period?.from ?? null,
          to: period?.to ?? null,
        });
      };

      if (state) {
        const { capacities, participantOf } = corePartnerPayouts(s.lines);
        const dayOf = new Map(state.costs.map((c) => [c.id, c.day]));
        for (const c of planRunningCostCharges({ ...state, capacities })) {
          add(
            participantOf.get(c.partnerUserId)!,
            c.amount,
            dayOf.get(c.costEntryId)!,
          );
        }
      }
      for (const c of taken) {
        if (c.settlementId !== s.id) continue;
        // Paid: what stands. Reversed: what was put back.
        if ((s.status === 'PAID') !== (c.releasedAt === null)) continue;
        add(
          c.participantId,
          new Prisma.Decimal(c.amount),
          c.costEntry.occurredOn
            ? c.costEntry.occurredOn.toISOString().slice(0, 10)
            : businessDay(c.costEntry.createdAt),
        );
      }

      out.set(
        s.id,
        buildPayoutBreakdown({
          settlement: s,
          lines: s.lines,
          runningCosts: running,
          leftoversMovedEgp: leftovers.get(s.cycleId) ?? new Prisma.Decimal(0),
        }),
      );
    }
    return out;
  }

  /**
   * The Partners page's Running costs section (§8, L7): for a period, what
   * was spent by category, what payouts have taken of it, what is still
   * waiting, and each core partner's share. The period is the days the costs
   * were spent, both ends included; this quarter, in Cairo, when none is given.
   */
  async runningCosts(query: { from?: string; to?: string }) {
    const { from, to } =
      query.from || query.to
        ? { from: query.from, to: query.to }
        : thisQuarter(businessToday());
    assertDayRange(from, to);

    const state = await loadRunningCosts(this.prisma);
    const costs = state.costs.filter(
      (c) => (!from || c.day >= from) && (!to || c.day <= to),
    );
    const summary = summariseRunningCosts({ ...state, costs });
    const all = summariseRunningCosts(state);
    const money = (v: Prisma.Decimal) => v.toFixed(2);

    return {
      data: {
        from: from ?? null,
        to: to ?? null,
        spentEgp: money(summary.spentEgp),
        chargedEgp: money(summary.chargedEgp),
        waitingEgp: money(summary.waitingEgp),
        /** Everything still waiting, whatever the period: what the next payouts will take. */
        waitingAllTimeEgp: money(all.waitingEgp),
        byCategory: summary.byCategory.map((c) => ({
          category: c.category,
          spentEgp: money(c.spentEgp),
        })),
        partners: summary.partners.map((p) => ({
          userId: p.userId,
          name: p.name,
          shareEgp: money(p.shareEgp),
          chargedEgp: money(p.chargedEgp),
          waitingEgp: money(p.waitingEgp),
          takesResidual: p.takesResidual,
          active: p.active,
        })),
      },
    };
  }
}
