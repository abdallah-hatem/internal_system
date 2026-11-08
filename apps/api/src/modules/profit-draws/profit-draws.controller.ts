import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import type { Viewer } from '../../common/investor-scope';
import { ProfitDrawsService } from './profit-draws.service';
import { PROFIT_DRAW_ROLES } from './profit-draw-roles';
import {
  CreateProfitDrawDto,
  ReverseProfitDrawDto,
} from './dto/profit-draw.dto';

@ApiTags('Profit draws')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(...PROFIT_DRAW_ROLES)
@Controller('cycles')
export class CycleProfitDrawsController {
  constructor(private draws: ProfitDrawsService) {}

  @Get(':id/profit-draws')
  @Roles(...PROFIT_DRAW_ROLES)
  @ApiOperation({
    summary:
      "A cycle's profit taken so far, and what each partner may take now",
  })
  list(@Param('id') id: string) {
    return this.draws.forCycle(id);
  }

  @Post(':id/profit-draws')
  @Roles(...PROFIT_DRAW_ROLES)
  @ApiOperation({
    summary: 'A core partner takes part of his share of the profit collected',
  })
  create(
    @Param('id') id: string,
    @Body() body: CreateProfitDrawDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.draws.create(id, body, user.id);
  }
}

@ApiTags('Profit draws')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(...PROFIT_DRAW_ROLES)
@Controller('profit-draws')
export class ProfitDrawsController {
  constructor(private draws: ProfitDrawsService) {}

  @Post(':id/reverse')
  @Roles(...PROFIT_DRAW_ROLES)
  @ApiOperation({ summary: 'Undo profit taken, once, with a reason' })
  reverse(
    @Param('id') id: string,
    @Body() body: ReverseProfitDrawDto,
    @CurrentUser() user: Viewer,
  ) {
    return this.draws.reverse(id, body, user.id);
  }
}
