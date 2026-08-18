import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async getDashboardKPIs() {
    // Total revenue: confirmed+paid sales orders total
    const revenueAgg = await this.prisma.saleOrder.aggregate({
      where: { status: { in: ['CONFIRMED', 'PAID'] } },
      _sum: { total: true },
    });
    const totalRevenue = Number(revenueAgg._sum.total ?? 0);

    // Total expenses: OUTFLOW FinancialTransactions where category is purchase/shipping/fees
    // (money going out to pay for goods, shipping, and customs fees)
    const expenseAgg = await this.prisma.financialTransaction.aggregate({
      where: {
        direction: 'OUTFLOW',
        category: { in: ['purchase', 'shipping', 'fees'] },
      },
      _sum: { amount: true },
    });
    const totalExpenses = Number(expenseAgg._sum.amount ?? 0);

    const netProfit = totalRevenue - totalExpenses;

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
        totalExpenses,
        netProfit,
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
        status: { in: ['CONFIRMED', 'PAID'] },
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
    const products = await this.prisma.product.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        sku: true,
        saleItems: { select: { quantity: true } },
      },
    });

    const ranked = products
      .map((p) => ({
        productId: p.id,
        name: p.name,
        sku: p.sku,
        totalQuantitySold: p.saleItems.reduce(
          (sum, item) => sum + Number(item.quantity),
          0,
        ),
      }))
      .sort((a, b) => b.totalQuantitySold - a.totalQuantitySold)
      .slice(0, limit);

    return { data: ranked };
  }

  async getCycleProfitability() {
    const cycles = await this.prisma.importCycle.findMany({
      where: { status: 'CLOSED' },
      select: {
        code: true,
        financialTransactions: {
          select: { amount: true, direction: true, category: true },
        },
        settlements: {
          select: { lines: { select: { amount: true, feeAmount: true } } },
        },
      },
    });

    const result = cycles.map((cycle) => {
      // Total cost = sum of OUTFLOW transactions (purchases, shipping, fees)
      const totalCost = cycle.financialTransactions
        .filter((t) => t.direction === 'OUTFLOW')
        .reduce((sum, t) => sum + Number(t.amount), 0);

      // Total revenue = sum of INFLOW transactions
      const totalRevenue = cycle.financialTransactions
        .filter((t) => t.direction === 'INFLOW')
        .reduce((sum, t) => sum + Number(t.amount), 0);

      return {
        cycleCode: cycle.code,
        totalCost,
        totalRevenue,
        profit: totalRevenue - totalCost,
      };
    });

    return { data: result };
  }
}
