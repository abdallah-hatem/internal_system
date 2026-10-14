import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import {
  COST_RECOVERY_CATEGORIES,
  NOT_OPERATING_EXPENSE,
  OTHER_INCOME_CATEGORIES,
  isCostRecoveryCategory,
  isLenderCategory,
  netOperatingExpenseEgp,
  netOtherIncomeEgp,
  netRecoveredEgp,
  TRANSFER_CATEGORY,
  transferNetEgp,
} from '../../common/ledger-categories';
import { cashPosition } from '../../common/cash-position';
import { cycleLossesEgp } from '../../common/cycle-losses';
import { exchangeDifferenceEgp } from '../../common/lender-debt';
import { owedToLenders } from '../../common/lenders-owed';
import { countLowStock } from '../../common/low-stock';
import { monthBuckets, monthBucketsSince } from '../../common/month-buckets';
import { cyclesVisibleTo, type ScopeViewer } from '../../common/investor-scope';

/**
 * Sale states whose revenue is realised: the goods have left the business, so
 * the sale counts whether or not the customer has finished paying.
 *
 * Draft and cancelled orders must never be counted — a draft is a quote that
 * has reserved nothing, and including them inflates every figure on the page.
 */
const REALISED_SALE_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'] as const;

/** How many events "Recent activity" shows when not told, and at most. */
export const RECENT_ACTIVITY_DEFAULT = 10;
export const RECENT_ACTIVITY_MAX = 50;

/** A count from the query string, kept to 1..RECENT_ACTIVITY_MAX. */
export function recentActivityLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return RECENT_ACTIVITY_DEFAULT;
  return Math.min(Math.floor(n), RECENT_ACTIVITY_MAX);
}

/**
 * One line of "Recent activity". `kind` is a code the web app translates;
 * nothing here is display text.
 */
export type RecentActivityItem = {
  kind: 'SALE' | 'PAYMENT' | 'RECEIPT';
  id: string;
  /** When it happened in the business: order date, day received, receipt. */
  occurredAt: Date;
  /** When it was entered — the tie-break between events on the same day. */
  recordedAt: Date;
  reference: string | null;
  status?: string;
  amount?: number;
  currency?: string;
  quantity?: number;
  /** `isWalkIn`: the shared walk-in record (§4) — named, never linked, by the client. */
  customer?: { id: string; displayName: string; isWalkIn: boolean };
  product?: { id: string; name: string; nameAr: string | null; sku: string };
  cycleId?: string;
};

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async getDashboardKPIs() {
    const D = (v: unknown) =>
      new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
    const money = (v: Prisma.Decimal) => Number(v.toDecimalPlaces(2));

    const REALISED = REALISED_SALE_STATUSES;

    const revenueAgg = await this.prisma.saleOrder.aggregate({
      where: { status: { in: [...REALISED] } },
      _sum: { total: true },
    });

    // Less what came back. Netting returns off cycle profitability but not
    // here left the dashboard and the cycle comparison disagreeing about the
    // same sales.
    const returnsAgg = await this.prisma.saleReturn.aggregate({
      where: { saleOrder: { status: { in: [...REALISED] } } },
      _sum: { refundEgp: true, cogsReversedEgp: true },
    });

    const revenue = D(revenueAgg._sum.total).sub(D(returnsAgg._sum.refundEgp));

    // Cost of the units actually sold, taken from the batch allocation made at
    // the time of sale, so historical costs are never re-priced.
    const cogsAgg = await this.prisma.saleItemAllocation.aggregate({
      where: { saleItem: { saleOrder: { status: { in: [...REALISED] } } } },
      _sum: { cogsEgp: true },
    });
    // Damaged goods reverse no cost, so cogsReversedEgp is zero for those and
    // their cost correctly stays spent.
    const cogs = D(cogsAgg._sum.cogsEgp).sub(
      D(returnsAgg._sum.cogsReversedEgp),
    );

    // Buying stock is not an expense -- it converts cash into inventory, and
    // becomes a cost only when the goods sell. Goods and shipping are already
    // capitalised into batch landed cost, so only other outflows are expenses.
    // Settlement payouts distribute profit already earned; counting them as
    // expenses would subtract the same money twice. Recoveries, and an undone
    // refund's OUTFLOW, are netted in `recovered` below rather than charged as
    // an expense (B5b); other income in `otherIncome` (L6).
    //
    // Read as the outflows and the reversals' inflows, through the one signed
    // reading settlement uses (L6, rule 11): until then a reversed expense
    // stayed in Expenses here for good.
    const expenseOf = async (direction: 'INFLOW' | 'OUTFLOW') => ({
      direction,
      category: '',
      reversalOfId: direction === 'INFLOW' ? 'reversal' : null,
      amount: D(
        (
          await this.prisma.financialTransaction.aggregate({
            where: {
              direction,
              category: { notIn: [...NOT_OPERATING_EXPENSE] },
              ...(direction === 'INFLOW'
                ? { reversalOfId: { not: null } }
                : {}),
            },
            _sum: { amount: true },
          })
        )._sum.amount,
      ),
    });
    const operatingNet = netOperatingExpenseEgp([
      await expenseOf('OUTFLOW'),
      await expenseOf('INFLOW'),
    ]);

    // Other income (L6): raises net profit, is not Revenue, and is shown on
    // its own like recoveries — net of any undone.
    const otherIncomeOf = async (direction: 'INFLOW' | 'OUTFLOW') => ({
      direction,
      category: OTHER_INCOME_CATEGORIES[0],
      amount: D(
        (
          await this.prisma.financialTransaction.aggregate({
            where: {
              direction,
              category: { in: [...OTHER_INCOME_CATEGORIES] },
            },
            _sum: { amount: true },
          })
        )._sum.amount,
      ),
    });
    const otherIncome = netOtherIncomeEgp([
      await otherIncomeOf('INFLOW'),
      await otherIncomeOf('OUTFLOW'),
    ]);
    // Goods lost on the way are an expense with no ledger row (§2, §9): the
    // same figure settlement subtracts, through the one definition.
    // Money recovered (supplier and loss refunds) raises net profit, as it
    // does in settlement and the cycle profitability (§6, rule 11). Until
    // loss refunds the dashboard left it out, so a refund raised a cycle's
    // profit and not the business's. Shown on its own rather than netted
    // into totalExpenses, which would read negative on a refund-heavy month.
    // Net of undone refunds (B5b): their OUTFLOW takes the inflow back,
    // through the signed reading settlement uses too.
    const recoveryOf = async (direction: 'INFLOW' | 'OUTFLOW') => ({
      direction,
      category: COST_RECOVERY_CATEGORIES[0],
      amount: D(
        (
          await this.prisma.financialTransaction.aggregate({
            where: {
              direction,
              category: { in: [...COST_RECOVERY_CATEGORIES] },
            },
            _sum: { amount: true },
          })
        )._sum.amount,
      ),
    });
    const recovered = netRecoveredEgp([
      await recoveryOf('INFLOW'),
      await recoveryOf('OUTFLOW'),
    ]);
    const operatingExpenses = operatingNet.add(
      await cycleLossesEgp(this.prisma, null),
    );

    // Repaying friends at a moved rate (§18): a cost or a gain of the cycles,
    // not an operating expense — shown on its own, and taken off net profit
    // through the one definition settlement reads (rule 11).
    const exchangeDiff = await exchangeDifferenceEgp(this.prisma, null);

    const netProfit = revenue
      .sub(cogs)
      .sub(operatingExpenses)
      .add(recovered)
      .add(otherIncome)
      .sub(exchangeDiff);

    // Cash actually paid out, reported separately from accounting profit
    // (BRD 11). Read with cash in and cash on hand below, through the one
    // definition of which ledger rows are cash: leftover stock moved between
    // cycles (§8, L5) moves none (common/cash-position.ts, rule 11).
    const cash = await cashPosition(this.prisma);
    const cashOut = cash.cashOut;

    const totalRevenue = money(revenue);
    const totalCogs = money(cogs);
    const totalExpenses = money(operatingExpenses);
    const totalCashOut = money(cashOut);

    // Active cycles: status NOT IN ('CLOSED', 'CANCELLED')
    const activeCycles = await this.prisma.importCycle.count({
      where: {
        status: { notIn: ['CLOSED'] },
      },
    });

    // Inventory value: sum of remainingQty * landedUnitCostEgp from InventoryBatch
    const inventoryBatches = await this.prisma.inventoryBatch.findMany({
      select: { remainingQty: true, landedUnitCostEgp: true },
    });
    const inventoryValue = inventoryBatches.reduce((sum, b) => {
      return sum + Number(b.remainingQty) * Number(b.landedUnitCostEgp);
    }, 0);
    // Units on the shelf across every product: the same "stock on hand" the
    // low-stock rule counts — each batch's remaining quantity, summed (§3).
    const unitsInStock = money(
      inventoryBatches.reduce((sum, b) => sum.add(D(b.remainingQty)), D(0)),
    );

    // Receivables: sum of outstanding > 0 from confirmed sales orders
    const receivableOrders = await this.prisma.saleOrder.findMany({
      where: {
        status: { in: ['CONFIRMED', 'PARTIALLY_PAID'] },
        outstanding: { gt: 0 },
      },
      select: { outstanding: true },
    });
    const receivables = receivableOrders.reduce(
      (sum, o) => sum + Number(o.outstanding),
      0,
    );

    // Low stock: the one rule (common/low-stock.ts, BUSINESS_LOGIC §3).
    const lowStockAlerts = await countLowStock(this.prisma);

    // Total customers
    // Money actually in hand, as opposed to money earned.
    //
    // Revenue above is what has been sold; this is what has been collected for
    // it. The two differ by the receivables below, and keeping them apart is
    // the whole point: a good month of selling and an empty till look
    // identical if only one number is shown.
    const collectedAgg = await this.prisma.payment.aggregate({
      where: { status: 'RECORDED' },
      _sum: { amount: true },
    });
    const collected = money(D(collectedAgg._sum.amount));

    // The walk-in record is not a customer the business has (§4).
    const totalCustomers = await this.prisma.customer.count({
      where: { isWalkIn: false },
    });

    // Total active products
    const totalProducts = await this.prisma.product.count({
      where: { status: 'ACTIVE' },
    });

    /**
     * Money actually in hand: everything in, less everything out.
     *
     * This could not be computed honestly until contributions were recorded.
     * The ledger held the purchase going out and nothing for the partners'
     * capital coming in, so netting it gave −62,325 on a cycle that had been
     * settled in full and owed nobody anything — a figure worse than no figure,
     * which is why none was shown.
     *
     * Both directions in one pass rather than two aggregates: a category added
     * on one side and forgotten on the other is exactly how the number drifted
     * last time.
     */
    const { cashIn, cashOnHand } = cash;

    return {
      data: {
        totalRevenue,
        totalCogs,
        totalExpenses,
        /** Supplier and loss refunds, added back in netProfit (§6). */
        totalRecoveredEgp: money(recovered),
        /** Other income recorded by hand, added in netProfit; not Revenue (§9, L6). */
        totalOtherIncomeEgp: money(otherIncome),
        /** Repaying friends at a moved rate, taken off netProfit (§18). */
        exchangeDifferenceEgp: money(exchangeDiff),
        /** What friends are still owed, per currency and in pounds today (§18). */
        owedToLenders: await owedToLenders(this.prisma),
        totalCashOut,
        totalCashIn: money(cashIn),
        cashOnHand: money(cashOnHand),
        collected,
        netProfit: money(netProfit),
        activeCycles,
        inventoryValue,
        unitsInStock,
        receivables,
        lowStockAlerts,
        totalCustomers,
        totalProducts,
      },
    };
  }

  async getRevenueByMonth(months: number = 12) {
    // See `monthBuckets` for why this is not a loop that walks a date forward.
    // In short: `setMonth` is local time, the keys are UTC, and a date carrying
    // a day-of-month cannot be stepped by months — together they dropped the
    // current month from the chart on 24 days of 2026.
    const now = new Date();
    // `months` buckets ending with the current one, so 12 means this month and
    // the eleven before it — not thirteen.
    const keys = monthBuckets(now, months);
    const since = monthBucketsSince(now, months);

    const orders = await this.prisma.saleOrder.findMany({
      where: {
        // Was CONFIRMED/PAID only, so a partially paid order was missing here
        // while the dashboard counted it — the two totals disagreed.
        status: { in: [...REALISED_SALE_STATUSES] },
        orderedAt: { gte: since },
      },
      select: { orderedAt: true, total: true },
      orderBy: { orderedAt: 'asc' },
    });

    // Group by month
    const revenueByMonth: Record<string, number> = {};
    for (const order of orders) {
      const monthKey = order.orderedAt.toISOString().slice(0, 7); // YYYY-MM
      revenueByMonth[monthKey] =
        (revenueByMonth[monthKey] || 0) + Number(order.total);
    }

    // Returns reduce the month they came back in, not the month of the sale:
    // a past month that has already been reported should not change.
    const returns = await this.prisma.saleReturn.findMany({
      where: {
        returnedOn: { gte: since },
        saleOrder: { status: { in: [...REALISED_SALE_STATUSES] } },
      },
      select: { returnedOn: true, refundEgp: true },
    });

    for (const ret of returns) {
      const monthKey = ret.returnedOn.toISOString().slice(0, 7);
      revenueByMonth[monthKey] =
        (revenueByMonth[monthKey] || 0) - Number(ret.refundEgp);
    }

    // Every bucket, including the current month, and zero for the quiet ones.
    const result = keys.map((key) => ({
      month: key,
      revenue: revenueByMonth[key] || 0,
    }));

    return { data: result };
  }

  async getTopProducts(limit: number = 10) {
    const D = (v: unknown) =>
      new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
    const money = (v: Prisma.Decimal) => Number(v.toDecimalPlaces(2));

    const products = await this.prisma.product.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        nameAr: true,
        sku: true,
        saleItems: {
          // Without this filter every draft counts, including abandoned ones,
          // which is how a product showed three million units sold.
          where: { saleOrder: { status: { in: [...REALISED_SALE_STATUSES] } } },
          select: {
            quantity: true,
            lineTotal: true,
            allocations: { select: { cogsEgp: true } },
            returnItems: {
              select: { qty: true, unitPrice: true, cogsReversedEgp: true },
            },
          },
        },
      },
    });

    const ranked = products
      .map((p) => {
        // Sales less what came back: a product with heavy returns is not a
        // top seller, and counting the gross figure would say it was.
        const units = p.saleItems.reduce(
          (sum, i) =>
            i.returnItems.reduce(
              (s2, r) => s2.sub(D(r.qty)),
              sum.add(D(i.quantity)),
            ),
          D(0),
        );
        const revenue = p.saleItems.reduce(
          (sum, i) =>
            i.returnItems.reduce(
              (s2, r) => s2.sub(D(r.unitPrice).mul(D(r.qty))),
              sum.add(D(i.lineTotal)),
            ),
          D(0),
        );
        const cogs = p.saleItems.reduce(
          (sum, i) =>
            i.returnItems.reduce(
              (s2, r) => s2.sub(D(r.cogsReversedEgp)),
              i.allocations.reduce((s2, a) => s2.add(D(a.cogsEgp)), sum),
            ),
          D(0),
        );
        const profit = revenue.sub(cogs);

        return {
          productId: p.id,
          name: p.name,
          nameAr: p.nameAr,
          sku: p.sku,
          totalQuantitySold: Number(units.toDecimalPlaces(3)),
          revenueEgp: money(revenue),
          cogsEgp: money(cogs),
          profitEgp: money(profit),
          // Margin is meaningless without revenue to divide by.
          marginPct: revenue.gt(0)
            ? Number(profit.div(revenue).mul(100).toDecimalPlaces(1))
            : null,
        };
      })
      .sort((a, b) => b.revenueEgp - a.revenueEgp)
      .slice(0, limit);

    return { data: ranked };
  }

  /**
   * Per-cycle economics, for comparing cycles against each other (BRD 11).
   *
   * Revenue and cost are attributed through batch allocations, not through the
   * cycle's own financial transactions: a sale draws stock by FIFO and can span
   * batches from several cycles, so its revenue is deliberately recorded
   * without a cycleId. Reading INFLOW transactions per cycle therefore reported
   * zero revenue for every cycle, including closed ones.
   *
   * Every cycle that has bought something is included. Restricting this to
   * CLOSED cycles made the comparison permanently empty, which defeats the
   * purpose of comparing cycles while they are still running.
   */
  async getCycleProfitability(viewer: ScopeViewer = 'internal') {
    const scope = await cyclesVisibleTo(viewer, this.prisma);
    const D = (v: unknown) =>
      new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
    const money = (v: Prisma.Decimal) => Number(v.toDecimalPlaces(2));

    const cycles = await this.prisma.importCycle.findMany({
      where: scope === null ? undefined : { id: { in: [...scope] } },
      select: {
        id: true,
        code: true,
        status: true,
        originType: true,
        financialTransactions: {
          select: {
            amount: true,
            direction: true,
            category: true,
            reversalOfId: true,
          },
        },
        inventoryBatches: {
          select: {
            receivedQty: true,
            remainingQty: true,
            landedUnitCostEgp: true,
            saleItemAllocations: {
              where: {
                saleItem: {
                  saleOrder: { status: { in: [...REALISED_SALE_STATUSES] } },
                },
              },
              select: {
                qty: true,
                cogsEgp: true,
                saleItem: { select: { quantity: true, lineTotal: true } },
              },
            },
            // Goods returned out of this batch, netted off below.
            //
            // Same status filter as the allocations above. A fully returned
            // order leaves the realised set, so its revenue is already absent
            // — netting its return as well subtracted the same money twice and
            // put cycle revenue 3,000 below the dashboard.
            returnItems: {
              where: {
                saleItem: {
                  saleOrder: { status: { in: [...REALISED_SALE_STATUSES] } },
                },
              },
              select: { qty: true, unitPrice: true, cogsReversedEgp: true },
            },
          },
        },
      },
      orderBy: { code: 'asc' },
    });

    // Goods lost on the way, per cycle: the figure settlement subtracts,
    // read through the one definition (§2, §9; rule 11).
    const withStock = cycles.filter((c) => c.inventoryBatches.length > 0);
    const lossesByCycle = new Map<string, Prisma.Decimal>();
    const exchangeByCycle = new Map<string, Prisma.Decimal>();
    for (const c of withStock) {
      lossesByCycle.set(c.id, await cycleLossesEgp(this.prisma, c.id));
      // Repaying friends at a moved rate (§18), as settlement reads it.
      exchangeByCycle.set(c.id, await exchangeDifferenceEgp(this.prisma, c.id));
    }

    const result = withStock.map((cycle) => {
      let revenue = D(0);
      let cogs = D(0);
      let unitsSold = D(0);
      let unsoldValue = D(0);
      let unitsRemaining = D(0);

      for (const batch of cycle.inventoryBatches) {
        unitsRemaining = unitsRemaining.add(D(batch.remainingQty));
        unsoldValue = unsoldValue.add(
          D(batch.remainingQty).mul(D(batch.landedUnitCostEgp)),
        );

        // A return reverses the sale it came from: fewer units sold, less
        // revenue, and the cost back — except for damaged goods, whose
        // cogsReversedEgp is zero because they never returned to stock.
        for (const ret of batch.returnItems) {
          const qty = D(ret.qty);
          unitsSold = unitsSold.sub(qty);
          revenue = revenue.sub(D(ret.unitPrice).mul(qty));
          cogs = cogs.sub(D(ret.cogsReversedEgp));
        }

        for (const alloc of batch.saleItemAllocations) {
          const qty = D(alloc.qty);
          unitsSold = unitsSold.add(qty);
          cogs = cogs.add(D(alloc.cogsEgp));

          // Price per unit from the line it was sold on, so a line discount
          // is reflected and a part-allocated line is only counted pro rata.
          const lineQty = D(alloc.saleItem.quantity);
          if (lineQty.gt(0)) {
            revenue = revenue.add(
              D(alloc.saleItem.lineTotal).div(lineQty).mul(qty),
            );
          }
        }
      }

      // What the cycle consumed in cash: goods, shipping and fees, less
      // anything a supplier gave back.
      // A refund recovers cost, so it improves the cycle's result even though
      // it changes no batch cost. Supplier refunds and loss refunds alike,
      // net of any undone (B5b), through the one signed reading settlement
      // uses (rule 11). Counting only the inflows kept an undone refund here.
      const supplierRefunds = netRecoveredEgp(cycle.financialTransactions);
      const investment = cycle.financialTransactions
        .filter(
          (t) =>
            t.direction === 'OUTFLOW' &&
            !isCostRecoveryCategory(t.category) &&
            // A friend's loan moving is not what the goods cost: the goods are
            // in `purchase` already, and repaying him would count them twice.
            // What the loan really cost is the exchange difference (§18).
            !isLenderCategory(t.category) &&
            // Leftovers moved between cycles (§8, L5): netted, signed, below.
            t.category !== TRANSFER_CATEGORY,
        )
        .reduce((sum, t) => sum.add(D(t.amount)), D(0))
        // Stock taken on from another cycle is part of what this cycle cost;
        // stock handed on is cost recovered. Signed, so both cycles agree.
        .add(transferNetEgp(cycle.financialTransactions))
        .sub(supplierRefunds)
        .add(exchangeByCycle.get(cycle.id) ?? D(0));

      const losses = lossesByCycle.get(cycle.id) ?? D(0);
      const exchangeDiff = exchangeByCycle.get(cycle.id) ?? D(0);
      // Expenses charged to the cycle and other income credited to it, read
      // as settlement reads them (L6, rule 11). This figure used to leave
      // them out, so a cycle's page and its settlement disagreed by exactly
      // the cycle's expenses.
      const expenses = netOperatingExpenseEgp(cycle.financialTransactions);
      const otherIncome = netOtherIncomeEgp(cycle.financialTransactions);
      const profit = revenue
        .sub(cogs)
        .add(supplierRefunds)
        .sub(losses)
        .sub(exchangeDiff)
        .sub(expenses)
        .add(otherIncome);

      return {
        // So a row can link to its cycle (an investor's dashboard, R1).
        cycleId: cycle.id,
        cycleCode: cycle.code,
        status: cycle.status,
        originType: cycle.originType,
        investment: money(investment),
        supplierRefundsEgp: money(supplierRefunds),
        /** Goods lost on the way, already taken off profit (§2). */
        lossesEgp: money(losses),
        /** Expenses charged to the cycle, already taken off profit (§9, L6). */
        expensesEgp: money(expenses),
        /** Other income credited to the cycle, already in profit (§9, L6). */
        otherIncomeEgp: money(otherIncome),
        /** Repaying friends at a moved rate, already taken off profit (§18). */
        exchangeDifferenceEgp: money(exchangeDiff),
        totalCost: money(cogs),
        totalRevenue: money(revenue),
        profit: money(profit),
        // Return on the cost of goods actually sold; meaningless with no sales.
        roiPct: cogs.gt(0)
          ? Number(profit.div(cogs).mul(100).toDecimalPlaces(1))
          : null,
        unitsSold: Number(unitsSold.toDecimalPlaces(3)),
        unitsRemaining: Number(unitsRemaining.toDecimalPlaces(3)),
        unsoldValueEgp: money(unsoldValue),
      };
    });

    return { data: result };
  }

  /**
   * The dashboard's "Recent activity": the latest things that really happened.
   *
   * The panel used to read the audit log, which is the wrong source twice over.
   * It holds only what was done through the API's services, so data entered any
   * other way — the demo seed, an import, a restore — is real and absent, and
   * the panel read empty on a database full of confirmed sales. And it holds
   * everything that was done, so a draft being saved showed up as activity
   * when a draft counts for nothing (BUSINESS_LOGIC §4).
   *
   * So the feed is built from the records themselves:
   *  - a sale, once it is realised (confirmed, part paid or paid) — never a
   *    draft, never a cancelled order; dated by its order date;
   *  - a customer payment that stands — a reversed one is excluded;
   *  - a stock receipt — a verified batch, the point stock exists.
   *
   * Each source is read to the same depth and merged, so one busy source
   * cannot push the others out of the window by being read deeper.
   */
  async getRecentActivity(limit = RECENT_ACTIVITY_DEFAULT) {
    const take = recentActivityLimit(limit);

    const [sales, payments, receipts] = await Promise.all([
      this.prisma.saleOrder.findMany({
        where: { status: { in: [...REALISED_SALE_STATUSES] } },
        orderBy: [{ orderedAt: 'desc' }, { createdAt: 'desc' }],
        take,
        select: {
          id: true,
          orderNo: true,
          status: true,
          total: true,
          currency: true,
          orderedAt: true,
          createdAt: true,
          customer: { select: { id: true, displayName: true, isWalkIn: true } },
        },
      }),
      this.prisma.payment.findMany({
        where: { status: 'RECORDED' },
        orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }],
        take,
        select: {
          id: true,
          amount: true,
          currency: true,
          method: true,
          receivedOn: true,
          createdAt: true,
          customer: { select: { id: true, displayName: true, isWalkIn: true } },
        },
      }),
      this.prisma.inventoryBatch.findMany({
        // Leftovers moved in from another cycle (§8, L5) were received once,
        // by the cycle that bought them — not a receipt again.
        where: { verificationStatus: 'VERIFIED', transferredFromBatchId: null },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          receivedQty: true,
          createdAt: true,
          cycleId: true,
          product: { select: { id: true, name: true, nameAr: true, sku: true } },
        },
      }),
    ]);

    const events: RecentActivityItem[] = [
      ...sales.map((o) => ({
        kind: 'SALE' as const,
        id: o.id,
        occurredAt: o.orderedAt,
        recordedAt: o.createdAt,
        reference: o.orderNo,
        status: o.status,
        amount: Number(o.total),
        currency: o.currency,
        customer: o.customer,
      })),
      ...payments.map((p) => ({
        kind: 'PAYMENT' as const,
        id: p.id,
        occurredAt: p.receivedOn,
        recordedAt: p.createdAt,
        reference: p.method ?? null,
        amount: Number(p.amount),
        currency: p.currency,
        customer: p.customer,
      })),
      ...receipts.map((b) => ({
        kind: 'RECEIPT' as const,
        id: b.id,
        occurredAt: b.createdAt,
        recordedAt: b.createdAt,
        reference: b.product.sku,
        quantity: Number(b.receivedQty),
        product: b.product,
        cycleId: b.cycleId,
      })),
    ];

    events.sort(
      (a, b) =>
        b.occurredAt.getTime() - a.occurredAt.getTime() ||
        b.recordedAt.getTime() - a.recordedAt.getTime(),
    );

    return { data: events.slice(0, take) };
  }
}
