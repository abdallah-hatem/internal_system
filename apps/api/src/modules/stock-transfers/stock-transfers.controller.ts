import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import type { Viewer } from '../../common/investor-scope';
import { StockTransfersService } from './stock-transfers.service';
import {
  CreateStockTransferDto,
  UndoStockTransferDto,
} from './dto/stock-transfer.dto';
import { TRANSFER_WRITE_ROLES } from './stock-transfer-roles';

/**
 * Leftover stock moved to another cycle at its cost (BUSINESS_LOGIC §8, L5).
 *
 * Reads are scoped like the cycle (an investor: his own cycles, another's is
 * 404 — R1). Every write moves a cycle's cost and is a core partner's
 * (CLAUDE.md rule 12).
 */
@ApiTags('Stock transfers')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('cycles')
export class CycleTransfersController {
  constructor(private transfers: StockTransfersService) {}

  @Get(':id/transfers')
  @ApiOperation({ summary: 'Leftovers moved out of and into this cycle' })
  forCycle(@Param('id') id: string, @CurrentUser() user: Viewer) {
    return this.transfers.forCycle(id, user);
  }

  @Get(':id/transfers/movable')
  @ApiOperation({
    summary: 'What this cycle could move to another cycle now, per product',
  })
  movable(@Param('id') id: string, @CurrentUser() user: Viewer) {
    return this.transfers.movable(id, user);
  }

  @Post(':id/transfers')
  @Roles(...TRANSFER_WRITE_ROLES)
  @ApiOperation({
    summary: "Move this cycle's leftovers to another cycle at cost",
  })
  create(
    @Param('id') id: string,
    @Body() body: CreateStockTransferDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.transfers.create(id, body, user.id);
  }
}

@ApiTags('Stock transfers')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('stock-transfers')
export class StockTransfersController {
  constructor(private transfers: StockTransfersService) {}

  @Post(':id/undo')
  @Roles(...TRANSFER_WRITE_ROLES)
  @ApiOperation({
    summary: 'Undo a move of leftovers, while none of it has sold',
  })
  undo(
    @Param('id') id: string,
    @Body() body: UndoStockTransferDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.transfers.undo(id, body.reason, user.id);
  }
}
