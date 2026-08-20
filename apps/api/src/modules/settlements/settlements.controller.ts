import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SettlementsService } from './settlements.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';

@ApiTags('Settlements')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('settlements')
export class SettlementsController {
  constructor(private settlementsService: SettlementsService) {}

  @Get()
  @ApiOperation({ summary: 'List settlements with filtering and pagination' })
  findAll(
    @Query()
    query: PaginationDto & {
      cycleId?: string;
      status?: string;
    },
  ) {
    return this.settlementsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a settlement by ID' })
  findOne(@Param('id') id: string) {
    return this.settlementsService.findOne(id);
  }

  @Post('calculate/:cycleId')
  @ApiOperation({ summary: 'Calculate settlement for a cycle' })
  calculate(@Param('cycleId') cycleId: string, @CurrentUser() user: any) {
    return this.settlementsService.calculate(cycleId, user?.id);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a settlement' })
  approve(@Param('id') id: string) {
    return this.settlementsService.approve(id);
  }

  @Post(':id/pay')
  @ApiOperation({ summary: 'Mark a settlement as paid' })
  markPaid(@Param('id') id: string) {
    return this.settlementsService.markPaid(id);
  }

  @Post(':id/reverse')
  @ApiOperation({ summary: 'Reverse a settlement' })
  reverse(
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.settlementsService.reverse(id, body.reason);
  }
}
