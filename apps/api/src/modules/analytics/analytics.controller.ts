import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('analytics')
export class AnalyticsController {
  constructor(private analyticsService: AnalyticsService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get dashboard KPIs' })
  getDashboardKPIs() {
    return this.analyticsService.getDashboardKPIs();
  }

  @Get('revenue-by-month')
  @ApiOperation({ summary: 'Get revenue grouped by month' })
  getRevenueByMonth(@Query('months') months?: string) {
    return this.analyticsService.getRevenueByMonth(
      months ? parseInt(months, 10) : 12,
    );
  }

  @Get('top-products')
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

  @Get('cycle-profitability')
  @ApiOperation({ summary: 'Get profitability per closed cycle' })
  getCycleProfitability() {
    return this.analyticsService.getCycleProfitability();
  }
}
