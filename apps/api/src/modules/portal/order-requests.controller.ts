import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { OrderRequestDecisionsService } from './order-request-decisions.service';
import { ApproveOrderRequestDto, DeclineOrderRequestDto } from './dto/order-request.dto';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * Answering requests, from the office.
 *
 * Internal by default — no `@Surface`, which is the point of the default. It
 * raises a confirmed order and therefore moves stock and money, so it names the
 * roles allowed to call it rather than relying on the guard's own default,
 * which is to allow (CLAUDE.md rule 12).
 */
@ApiTags('Order requests')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('order-requests')
export class OrderRequestsController {
  constructor(private decisions: OrderRequestDecisionsService) {}

  @Get('pending')
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'Requests waiting for an answer' })
  pending() {
    return this.decisions.listPending();
  }

  @Post(':id/approve')
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'Approve in whole or in part, raising the order' })
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveOrderRequestDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.decisions.approve(id, user.id, dto);
  }

  @Post(':id/decline')
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'Turn it down, with a reason the shop sees' })
  decline(
    @Param('id') id: string,
    @Body() dto: DeclineOrderRequestDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.decisions.decline(id, user.id, dto.decisionNote);
  }
}
