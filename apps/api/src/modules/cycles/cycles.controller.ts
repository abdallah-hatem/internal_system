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

@ApiTags('Import Cycles')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('cycles')
export class CyclesController {
  constructor(private cyclesService: CyclesService) {}

  @Get()
  @ApiOperation({ summary: 'List import cycles with pagination' })
  findAll(@Query() query: PaginationDto & { status?: string }) {
    return this.cyclesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get cycle details with all relations' })
  findById(@Param('id') id: string) {
    return this.cyclesService.findById(id);
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
  getParticipants(@Param('id') id: string) {
    return this.cyclesService.getParticipants(id);
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
