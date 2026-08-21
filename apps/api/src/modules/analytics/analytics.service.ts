import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

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
    const revenue = D(revenueAgg._sum.total);

    // Cost of the units actually sold, taken from the batch allocation made at
    // the time of sale, so historical costs are never re-priced.
    const cogsAgg = await this.prisma.saleItemAllocation.aggregate({
      where: { saleItem: { saleOrder: { status: { in: [...REALISED] } } } },
      _sum: { cogsEgp: true },
    });
    const cogs = D(cogsAgg._sum.cogsEgp);

    // Buying stock is not an expense -- it converts cash into inventory, and
    // becomes a cost only when the goods sell. Goods and shipping are already
    // capitalised into batch landed cost, so only other outflows are expenses.
    const operatingAgg = await this.prisma.financialTransaction.aggregate({
      where: {
        direction: 'OUTFLOW',
        // Settlement payouts distribute profit already earned; counting them
        // as expenses would subtract the same money twice.
        category: { notIn: ['purchase', 'shipping', 'settlement'] },
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
    const totalCustomers = await this.prisma.customer.count();

    // Total active products
    const totalProducts = await this.prisma.product.count({
      where: { status: 'ACTIVE' },
    });

    return {
      data: {
        totalRevenue,
        totalCogs,
        totalExpenses,
        totalCashOut,
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
    const since = new Date();
    since.setMonth(since.getMonth() - months);

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

    // Fill in missing months with 0
    const result: { month: string; revenue: number }[] = [];
    const cursor = new Date(since);
    while (cursor <= new Date()) {
      const key = cursor.toISOString().slice(0, 7);
      result.push({ month: key, revenue: revenueByMonth[key] || 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }

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
          },
        },
      },
    });

    const ranked = products
      .map((p) => {
        const units = p.saleItems.reduce((sum, i) => sum.add(D(i.quantity)), D(0));
        const revenue = p.saleItems.reduce((sum, i) => sum.add(D(i.lineTotal)), D(0));
        const cogs = p.saleItems.reduce(
          (sum, i) => i.allocations.reduce((s2, a) => s2.add(D(a.cogsEgp)), sum),
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

        // What the cycle consumed in cash: goods, shipping and any fees.
        const investment = cycle.financialTransactions
          .filter((t) => t.direction === 'OUTFLOW')
          .reduce((sum, t) => sum.add(D(t.amount)), D(0));

        const profit = revenue.sub(cogs);

        return {
          cycleCode: cycle.code,
          status: cycle.status,
          originType: cycle.originType,
          investment: money(investment),
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
