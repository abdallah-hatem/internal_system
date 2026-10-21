import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  AnalyticsService,
  TOP_PRODUCTS_BY,
  type TopProductsBy,
} from './analytics.service';
import { badRequest } from '../../common/api-error';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { Viewer } from '../../common/investor-scope';

@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('analytics')
export class AnalyticsController {
  constructor(private analyticsService: AnalyticsService) {}

  // Business-wide figures — revenue, cash, profit, what sells — are the
  // partners' and the office's. A temporary investor sees only their own
  // cycles (BUSINESS_LOGIC roles, owner 2026-10-10), so these refuse them with
  // ROLE_NOT_ALLOWED; their cycles' profitability is below, scoped.

  @Get('dashboard')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'Get dashboard KPIs' })
  getDashboardKPIs() {
    return this.analyticsService.getDashboardKPIs();
  }

  /**
   * Sales, cost of goods sold, expenses and net profit for a run of Cairo
   * days (`from`, `to`, both included, YYYY-MM-DD, either left out; none is
   * all time) — the dashboard's own computation, cut to the period — with
   * expenses by category and net profit by month (owner 2026-10-18).
   */
  @Get('profit-and-loss')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'Profit and loss for a period of days' })
  getProfitAndLoss(@Query('from') from?: unknown, @Query('to') to?: unknown) {
    return this.analyticsService.getProfitAndLoss(from, to);
  }

  @Get('revenue-by-month')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'Get revenue grouped by month' })
  getRevenueByMonth(@Query('months') months?: string) {
    return this.analyticsService.getRevenueByMonth(
      months ? parseInt(months, 10) : 12,
    );
  }

  @Get('top-products')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'Top products, by revenue (default) or units sold' })
  getTopProducts(@Query('limit') limit?: string, @Query('by') by?: string) {
    if (by !== undefined && !TOP_PRODUCTS_BY.includes(by as TopProductsBy)) {
      throw badRequest(
        'VALIDATION_FAILED',
        `by must be one of ${TOP_PRODUCTS_BY.join(', ')}, not "${by}".`,
        {
          fields: 'by',
        },
      );
    }
    const n = limit ? parseInt(limit, 10) : 10;
    return this.analyticsService.getTopProducts(
      Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 10,
      (by as TopProductsBy | undefined) ?? 'revenue',
    );
  }

  /** The sale that brought in the most and the one that sent out the most units, net of returns. */
  @Get('top-orders')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({
    summary: 'The sale with the most revenue and the one with the most units',
  })
  getTopOrders() {
    return this.analyticsService.getTopOrders();
  }

  /** Every role; an investor gets only the cycles they participate in. */
  @Get('cycle-profitability')
  @ApiOperation({
    summary:
      'Profitability per cycle with stock (an investor: their cycles only)',
  })
  getCycleProfitability(@CurrentUser() user: Viewer) {
    return this.analyticsService.getCycleProfitability(user);
  }
}
