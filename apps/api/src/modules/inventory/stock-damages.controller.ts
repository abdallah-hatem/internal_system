import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import type { Viewer } from '../../common/investor-scope';
import {
  StockDamagesService,
  type MarkDamagedInput,
} from './stock-damages.service';

/**
 * Units found damaged in storage (§3, §8 — owner 2026-11-28). Marking and
 * undoing move a cycle's profit, so both name the roles allowed (rule 12):
 * core partners only.
 */
@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller()
export class StockDamagesController {
  constructor(private damages: StockDamagesService) {}

  @Get('cycles/:id/damages')
  @ApiOperation({
    summary:
      "A cycle's units damaged in storage, each with whether it can be undone",
  })
  forCycle(@Param('id') id: string, @CurrentUser() user: Viewer) {
    return this.damages.forCycle(id, user);
  }

  @Post('inventory/batches/:id/damages')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({
    summary:
      'Mark units of a batch damaged in storage — a loss, no money moves',
  })
  mark(
    @Param('id') id: string,
    @Body() body: MarkDamagedInput,
    @CurrentUser() user: { id: string },
  ) {
    return this.damages.mark(id, body, user.id);
  }

  @Post('inventory/damages/:id/undo')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Undo a damage: the units go back on their batch' })
  undo(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @CurrentUser() user: { id: string },
  ) {
    return this.damages.undo(id, body?.reason, user.id);
  }
}
