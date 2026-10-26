import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import type { Viewer } from '../../common/investor-scope';
import { PartnerAccountsService } from './partner-accounts.service';
import {
  ContributeFromAccountsDto,
  CreateAdvanceDto,
  CreateWithdrawalDto,
  FundingTargetDto,
  ReverseMovementDto,
} from './dto/partner-account.dto';

/**
 * Who may read and change the partners' running accounts (§8, 2026-10-25;
 * CLAUDE.md §12): the core partners, and nobody else — it is their money.
 * GUESS: any core partner may record for any partner, as the office enters
 * every partner's records today.
 */
export const PARTNER_ACCOUNT_ROLES = ['CORE_PARTNER'] as const;

@ApiTags('Partner accounts')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(...PARTNER_ACCOUNT_ROLES)
@Controller('partner-accounts')
export class PartnerAccountsController {
  constructor(private accounts: PartnerAccountsService) {}

  @Get()
  @Roles(...PARTNER_ACCOUNT_ROLES)
  @ApiOperation({
    summary: "Each core partner's running account and its movements",
  })
  list() {
    return this.accounts.list();
  }

  @Post(':partnerUserId/advances')
  @Roles(...PARTNER_ACCOUNT_ROLES)
  @ApiOperation({
    summary: 'He paid a supplier for a cycle from his own pocket',
  })
  advance(
    @Param('partnerUserId') partnerUserId: string,
    @Body() body: CreateAdvanceDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.accounts.recordAdvance(partnerUserId, body, user.id);
  }

  @Post(':partnerUserId/withdrawals')
  @Roles(...PARTNER_ACCOUNT_ROLES)
  @ApiOperation({ summary: 'Money he took out of his account' })
  withdraw(
    @Param('partnerUserId') partnerUserId: string,
    @Body() body: CreateWithdrawalDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.accounts.withdraw(partnerUserId, body, user.id);
  }

  @Post(':partnerUserId/movements/:movementId/reverse')
  @Roles(...PARTNER_ACCOUNT_ROLES)
  @ApiOperation({
    summary: 'Reverse a movement on his account, once, with a reason',
  })
  reverse(
    @Param('partnerUserId') partnerUserId: string,
    @Param('movementId') movementId: string,
    @Body() body: ReverseMovementDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.accounts.reverse(
      partnerUserId,
      movementId,
      body.reason,
      user.id,
    );
  }
}

@ApiTags('Partner accounts')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(...PARTNER_ACCOUNT_ROLES)
@Controller('cycles')
export class CycleAccountFundingController {
  constructor(private accounts: PartnerAccountsService) {}

  @Get(':id/account-funding')
  @Roles(...PARTNER_ACCOUNT_ROLES)
  @ApiOperation({
    summary:
      "A cycle's funding target, paid so far by whom, and the partners' accounts",
  })
  funding(@Param('id') id: string) {
    return this.accounts.cycleFunding(id);
  }

  @Put(':id/funding-target')
  @Roles(...PARTNER_ACCOUNT_ROLES)
  @ApiOperation({ summary: "Set or clear a cycle's funding target" })
  target(
    @Param('id') id: string,
    @Body() body: FundingTargetDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.accounts.setTarget(id, body, user.id);
  }

  @Post(':id/account-contributions')
  @Roles(...PARTNER_ACCOUNT_ROLES)
  @ApiOperation({
    summary:
      "Contribute to a cycle from the partners' accounts (equal shares by default)",
  })
  contribute(
    @Param('id') id: string,
    @Body() body: ContributeFromAccountsDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.accounts.contribute(id, body, user.id);
  }
}
