import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LendersService } from './lenders.service';
import {
  CreateFinancingDto,
  CreateLenderDto,
  CreateLenderPlanDto,
  CreateRepaymentDto,
  ReasonDto,
  UpdateLenderDto,
} from './dto/lender.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import type { Viewer } from '../../common/investor-scope';
import { LENDER_READ_ROLES, LENDER_WRITE_ROLES } from './lender-roles';

/**
 * A friend who pays a supplier for us, repaid in pounds (BUSINESS_LOGIC §18).
 *
 * Every write moves money and is a core partner's (CLAUDE.md rule 12). The
 * lenders themselves are the office's to read; a temporary investor sees a
 * friend's payment only on his own cycle's order and cycle page.
 */
@ApiTags('Lenders')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('lenders')
export class LendersController {
  constructor(private lenders: LendersService) {}

  @Get()
  @Roles(...LENDER_READ_ROLES)
  @ApiOperation({ summary: 'Lenders, with what each is still owed' })
  list() {
    return this.lenders.list();
  }

  @Get(':id')
  @Roles(...LENDER_READ_ROLES)
  @ApiOperation({
    summary: 'A lender: what he paid for, repayments, plans, still owed',
  })
  findOne(@Param('id') id: string) {
    return this.lenders.findOne(id);
  }

  @Post()
  @Roles(...LENDER_WRITE_ROLES)
  @ApiOperation({ summary: 'Add a lender' })
  create(@Body() body: CreateLenderDto, @CurrentUser() user: Viewer) {
    return this.lenders.create(body, user.id);
  }

  @Put(':id')
  @Roles(...LENDER_WRITE_ROLES)
  @ApiOperation({ summary: "Correct a lender's name, phone or notes" })
  update(
    @Param('id') id: string,
    @Body() body: UpdateLenderDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.lenders.update(id, body, user.id);
  }

  @Delete(':id')
  @Roles(...LENDER_WRITE_ROLES)
  @ApiOperation({ summary: 'Delete a lender with no payment still on record' })
  remove(@Param('id') id: string, @CurrentUser() user: Viewer) {
    return this.lenders.remove(id, user.id);
  }
}

@ApiTags('Lenders')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('purchases')
export class PurchaseFinancingController {
  constructor(private lenders: LendersService) {}

  // Read where the order can be read: an investor's own cycles only.
  @Get(':id/financings')
  @ApiOperation({
    summary: 'Who paid how much of this order, and what is owed',
  })
  forOrder(@Param('id') id: string, @CurrentUser() user: Viewer) {
    return this.lenders.forOrder(id, user);
  }

  @Post(':id/financings')
  @Roles(...LENDER_WRITE_ROLES)
  @ApiOperation({ summary: 'A friend paid all or part of this order' })
  finance(
    @Param('id') id: string,
    @Body() body: CreateFinancingDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.lenders.finance(id, body, user.id);
  }
}

@ApiTags('Lenders')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('cycles')
export class CycleFinancingController {
  constructor(private lenders: LendersService) {}

  @Get(':id/financing')
  @ApiOperation({
    summary: "Friends' payments on this cycle's orders, and who is owed",
  })
  forCycle(@Param('id') id: string, @CurrentUser() user: Viewer) {
    return this.lenders.forCycle(id, user);
  }
}

@ApiTags('Lenders')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller()
export class LenderMoneyController {
  constructor(private lenders: LendersService) {}

  @Get('lender-financings/:id/quote')
  @Roles(...LENDER_READ_ROLES)
  @ApiOperation({
    summary: 'What is owed and the pounds that pay it off at a rate',
  })
  quote(@Param('id') id: string, @Query('rateToEgp') rate: string) {
    return this.lenders.quote(id, rate);
  }

  @Post('lender-financings/:id/remove')
  @Roles(...LENDER_WRITE_ROLES)
  @ApiOperation({
    summary: "Remove a friend's payment while nothing is repaid",
  })
  remove(
    @Param('id') id: string,
    @Body() body: ReasonDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.lenders.removeFinancing(id, body.reason, user.id);
  }

  @Post('lender-financings/:id/repayments')
  @Roles(...LENDER_WRITE_ROLES)
  @ApiOperation({ summary: 'Repay a friend in pounds at that day’s rate' })
  repay(
    @Param('id') id: string,
    @Body() body: CreateRepaymentDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.lenders.repay(id, body, user.id);
  }

  @Post('lender-financings/:id/plan')
  @Roles(...LENDER_WRITE_ROLES)
  @ApiOperation({ summary: 'Agree a repayment schedule in his currency' })
  plan(
    @Param('id') id: string,
    @Body() body: CreateLenderPlanDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.lenders.createPlan(id, body, user.id);
  }

  @Post('lender-repayments/:id/reverse')
  @Roles(...LENDER_WRITE_ROLES)
  @ApiOperation({ summary: 'Reverse a repayment, once, with a reason' })
  reverse(
    @Param('id') id: string,
    @Body() body: ReasonDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.lenders.reverseRepayment(id, body.reason, user.id);
  }

  @Post('lender-plans/:id/cancel')
  @Roles(...LENDER_WRITE_ROLES)
  @ApiOperation({ summary: 'Cancel a repayment plan' })
  cancelPlan(
    @Param('id') id: string,
    @Body() body: ReasonDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.lenders.cancelPlan(id, body.reason, user.id);
  }
}
