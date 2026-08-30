import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { CAPITALISED_CATEGORIES } from '../../common/ledger-categories';
import { monthBuckets, monthBucketsSince } from '../../common/month-buckets';

/**
 * Sale states whose revenue is realised: the goods have left the business, so
 * the sale counts whether or not the customer has finished paying.
 *
 * Draft and cancelled orders must never be counted — a draft is a quote that
 * has reserved nothing, and including them inflates every figure on the page.
 */
const REALISED_SALE_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'] as const;

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async getDashboardKPIs() {
    const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
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
    const cogs = D(cogsAgg._sum.cogsEgp).sub(D(returnsAgg._sum.cogsReversedEgp));

    // Buying stock is not an expense -- it converts cash into inventory, and
    // becomes a cost only when the goods sell. Goods and shipping are already
    // capitalised into batch landed cost, so only other outflows are expenses.
    const operatingAgg = await this.prisma.financialTransaction.aggregate({
      where: {
        direction: 'OUTFLOW',
        // Settlement payouts distribute profit already earned; counting them
        // as expenses would subtract the same money twice.
        category: { notIn: [...CAPITALISED_CATEGORIES] },
      },
      _sum: { amount: true },
    });
    const operatingExpenses = D(operatingAgg._sum.amount);

    const netProfit = revenue.sub(cogs).sub(operatingExpenses);

    // Cash actually paid out, reported separately from accounting profit
    // (BRD 11).
    const cashOutAgg = await this.prisma.financialTransaction.aggregate({
      where: { direction: 'OUTFLOW' },
      _sum: { amount: true },
    });
    const cashOut = D(cashOutAgg._sum.amount);

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

    // Low stock alerts: count of products where current stock < minStock
    // Current stock = sum of remainingQty from all batches for the product
    const productsWithMinStock = await this.prisma.product.findMany({
      where: { minStock: { not: null }, status: 'ACTIVE' },
      select: {
        id: true,
        minStock: true,
        inventoryBatches: { select: { remainingQty: true } },
      },
    });
    const lowStockAlerts = productsWithMinStock.filter((p) => {
      const currentStock = p.inventoryBatches.reduce(
        (sum, b) => sum + Number(b.remainingQty),
        0,
      );
      return currentStock < Number(p.minStock!);
    }).length;

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

    const totalCustomers = await this.prisma.customer.count();

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
    const flows = await this.prisma.financialTransaction.groupBy({
      by: ['direction'],
      _sum: { amount: true },
    });
    const flowOf = (d: string) =>
      D(flows.find((f) => f.direction === d)?._sum.amount ?? 0);
    const cashIn = flowOf('INFLOW');
    const cashOnHand = cashIn.sub(flowOf('OUTFLOW'));

    return {
      data: {
        totalRevenue,
        totalCogs,
        totalExpenses,
        totalCashOut,
        totalCashIn: money(cashIn),
        cashOnHand: money(cashOnHand),
        collected,
        netProfit: money(netProfit),
        activeCycles,
        inventoryValue,
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
      revenueByMonth[monthKey] = (revenueByMonth[monthKey] || 0) + Number(order.total);
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
      revenueByMonth[monthKey] = (revenueByMonth[monthKey] || 0) - Number(ret.refundEgp);
    }

    // Every bucket, including the current month, and zero for the quiet ones.
    const result = keys.map((key) => ({ month: key, revenue: revenueByMonth[key] || 0 }));

    return { data: result };
  }

  async getTopProducts(limit: number = 10) {
    const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
    const money = (v: Prisma.Decimal) => Number(v.toDecimalPlaces(2));

    const products = await this.prisma.product.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        sku: true,
        saleItems: {
          // Without this filter every draft counts, including abandoned ones,
          // which is how a product showed three million units sold.
          where: { saleOrder: { status: { in: [...REALISED_SALE_STATUSES] } } },
          select: {
            quantity: true,
            lineTotal: true,
            allocations: { select: { cogsEgp: true } },
            returnItems: { select: { qty: true, unitPrice: true, cogsReversedEgp: true } },
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
            i.returnItems.reduce((s2, r) => s2.sub(D(r.qty)), sum.add(D(i.quantity))),
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
  async getCycleProfitability() {
    const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
    const money = (v: Prisma.Decimal) => Number(v.toDecimalPlaces(2));

    const cycles = await this.prisma.importCycle.findMany({
      select: {
        id: true,
        code: true,
        status: true,
        originType: true,
        financialTransactions: {
          select: { amount: true, direction: true, category: true },
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

    const result = cycles
      .filter((c) => c.inventoryBatches.length > 0)
      .map((cycle) => {
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
              revenue = revenue.add(D(alloc.saleItem.lineTotal).div(lineQty).mul(qty));
            }
          }
        }

        // What the cycle consumed in cash: goods, shipping and fees, less
        // anything a supplier gave back.
        const investment = cycle.financialTransactions
          .filter((t) => t.direction === 'OUTFLOW')
          .reduce((sum, t) => sum.add(D(t.amount)), D(0))
          .sub(
            cycle.financialTransactions
              .filter((t) => t.direction === 'INFLOW' && t.category === 'supplier_refund')
              .reduce((sum, t) => sum.add(D(t.amount)), D(0)),
          );

        // A refund recovers cost, so it improves the cycle's result even though
        // it changes no batch cost.
        const supplierRefunds = cycle.financialTransactions
          .filter((t) => t.direction === 'INFLOW' && t.category === 'supplier_refund')
          .reduce((sum, t) => sum.add(D(t.amount)), D(0));

        const profit = revenue.sub(cogs).add(supplierRefunds);

        return {
          cycleCode: cycle.code,
          status: cycle.status,
          originType: cycle.originType,
          investment: money(investment),
          supplierRefundsEgp: money(supplierRefunds),
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
}
