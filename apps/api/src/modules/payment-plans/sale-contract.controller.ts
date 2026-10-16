import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentPlansService } from './payment-plans.service';
import { CreateSaleContractPlanDto } from './dto/payment-plan.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';

/**
 * A sale's instalment contract (BUSINESS_LOGIC §7, 2026-10-16): the Contract
 * button on the sale order popup agrees a plan for what is outstanding on the
 * sale, and the contract is printed from the sale and that plan.
 *
 * Under the sale's own path, beside SalesController, but here: the plan is
 * the payment-plan engine's, and it is agreed by the one service that agrees
 * every plan. Reading the contract is the sales roles'; agreeing the plan is
 * whoever may agree a plan today — the same roles as `POST /payment-plans`.
 */
@ApiTags('Sales')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
@Controller('sales/orders')
export class SaleContractController {
  constructor(private plans: PaymentPlansService) {}

  @Post(':id/contract-plan')
  @Roles('CORE_PARTNER')
  @ApiOperation({
    summary:
      "Agree the instalment plan for what is outstanding on a confirmed or partly paid EGP sale. The instalments must add up to the outstanding amount and fall due today or later; the shop may have no other active plan.",
  })
  createPlan(
    @Param('id') id: string,
    @Body() body: CreateSaleContractPlanDto,
    @CurrentUser() user: { id?: string } | undefined,
  ) {
    return this.plans.createForSale(id, body, user?.id);
  }

  @Get(':id/contract')
  @ApiOperation({
    summary:
      "The sale's instalment contract, built from the sale and its plan: the shop, the goods, the totals and the schedule. Refused for a sale with no plan.",
  })
  contract(@Param('id') id: string) {
    return this.plans.saleContract(id);
  }
}
