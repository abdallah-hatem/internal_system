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
