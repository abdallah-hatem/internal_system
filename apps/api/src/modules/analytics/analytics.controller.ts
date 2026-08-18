import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';

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
    return this.analyticsService.getRevenueByMonth(months ? parseInt(months, 10) : 12);
  }

  @Get('top-products')
  @ApiOperation({ summary: 'Get top products by quantity sold' })
  getTopProducts(@Query('limit') limit?: string) {
    return this.analyticsService.getTopProducts(limit ? parseInt(limit, 10) : 10);
  }

  @Get('cycle-profitability')
  @ApiOperation({ summary: 'Get profitability per closed cycle' })
  getCycleProfitability() {
    return this.analyticsService.getCycleProfitability();
  }
}
