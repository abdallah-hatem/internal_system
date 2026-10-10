import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
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
  @ApiOperation({ summary: 'Get top products by quantity sold' })
  getTopProducts(@Query('limit') limit?: string) {
    return this.analyticsService.getTopProducts(
      limit ? parseInt(limit, 10) : 10,
    );
  }

  /**
   * Latest confirmed sales, payments and stock receipts. Restricted to the
   * roles that may list sales and payments themselves — a temporary investor
   * or a shop could otherwise read every customer's orders through the
   * dashboard instead of the sales page that refuses them.
   */
  @Get('recent-activity')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({
    summary: 'Latest confirmed sales, payments and stock receipts',
  })
  getRecentActivity(@Query('limit') limit?: string) {
    return this.analyticsService.getRecentActivity(
      limit === undefined ? undefined : Number(limit),
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
