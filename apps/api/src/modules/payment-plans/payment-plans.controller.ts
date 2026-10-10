import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentPlansService } from './payment-plans.service';
import { CreatePaymentPlanDto, CancelPaymentPlanDto } from './dto/payment-plan.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('Payment Plans')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('payment-plans')
export class PaymentPlansController {
  constructor(private plans: PaymentPlansService) {}

  // Customer data — every shop, its balance, what it owes and returned — is
  // the office's. A temporary investor sees only their own cycles (BUSINESS_LOGIC
  // roles, owner 2026-10-10), so the reads refuse them with ROLE_NOT_ALLOWED.
  @Get()
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'List payment plans with their progress' })
  findAll(@Query() query: PaginationDto & { customerId?: string; overdueOnly?: string }) {
    return this.plans.findAll(query);
  }

  @Get('overdue')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'Everything behind schedule right now' })
  overdue(@CurrentUser() user: any) {
    return this.plans.overdueSummary(user?.id ? [user.id] : []);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'A plan with each instalment and its state' })
  findOne(@Param('id') id: string) {
    return this.plans.findOne(id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({
    summary:
      'Agree a schedule against a customer balance. Amounts are whatever was ' +
      'agreed — they need not be equal or weekly.',
  })
  create(@Body() body: CreatePaymentPlanDto, @CurrentUser() user: any) {
    return this.plans.create(body, user?.id);
  }

  @Post(':id/cancel')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Cancel a plan' })
  cancel(@Param('id') id: string, @Body() body: CancelPaymentPlanDto, @CurrentUser() user: any) {
    return this.plans.cancel(id, body.reason, user?.id);
  }
}
