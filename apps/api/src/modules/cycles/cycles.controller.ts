import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CyclesService } from './cycles.service';
import { AddParticipantDto } from './dto/participant.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import type { Viewer } from '../../common/investor-scope';

@ApiTags('Import Cycles')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('cycles')
export class CyclesController {
  constructor(private cyclesService: CyclesService) {}

  // Every read here is scoped by `cyclesVisibleTo` (common/investor-scope): a
  // temporary investor gets only the cycles they participate in, and another
  // cycle's id is 404 — not 403, which would confirm it exists (R1).

  @Get()
  @ApiOperation({
    summary:
      'List import cycles with pagination (an investor: their cycles only)',
  })
  findAll(
    @Query() query: PaginationDto & { status?: string },
    @CurrentUser() user: Viewer,
  ) {
    return this.cyclesService.findAll(query, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get cycle details with all relations' })
  findById(@Param('id') id: string, @CurrentUser() user: Viewer) {
    return this.cyclesService.findById(id, user);
  }

  // Core partners, who record deliveries and losses, and — since R1 — a
  // temporary investor on their own cycles: the owner's decision of
  // 2026-10-10 is that an investor sees their cycle's deliveries and losses.
  @Get(':id/shipment')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'TEMP_INVESTOR')
  @ApiOperation({
    summary:
      'Shipment position: per leg and line, entered / delivered / received / lost / on the way',
  })
  getShipment(@Param('id') id: string, @CurrentUser() user: Viewer) {
    return this.cyclesService.getShipment(id, user);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Create a new import cycle (CORE_PARTNER only)' })
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.cyclesService.create(body, user.id);
  }

  @Post(':id/transition')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Transition cycle to a new status' })
  transition(
    @Param('id') id: string,
    @Body() body: { status: string },
    @CurrentUser() user: any,
  ) {
    return this.cyclesService.transition(id, body.status, user.id);
  }

  @Get(':id/participants')
  @ApiOperation({ summary: 'List participants for a cycle' })
  getParticipants(@Param('id') id: string, @CurrentUser() user: Viewer) {
    return this.cyclesService.getParticipants(id, user);
  }

  @Post(':id/participants')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Add a participant to a cycle' })
  addParticipant(
    @Param('id') id: string,
    @Body() body: AddParticipantDto,
    @CurrentUser() user: any,
  ) {
    return this.cyclesService.addParticipant(id, body, user.id);
  }

  @Put('participants/:id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Update a cycle participant' })
  updateParticipant(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.cyclesService.updateParticipant(id, body, user.id);
  }
}
