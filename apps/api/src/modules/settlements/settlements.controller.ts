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
import { MarkSettlementPaidDto, ReverseSettlementDto } from './dto/settlement.dto';
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

  // Declared before ':id' — Nest matches in order, so the other way round
  // "preview" is read as a settlement id and 404s.
  @Get('preview/:cycleId')
  @ApiOperation({
    summary: "A cycle's profit as it stands, and how it would split, without writing anything",
  })
  preview(@Param('cycleId') cycleId: string) {
    return this.settlementsService.preview(cycleId);
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
  @ApiOperation({ summary: 'Approve a settlement and move the cycle to SETTLEMENT' })
  approve(@Param('id') id: string, @CurrentUser() user: any) {
    return this.settlementsService.approve(id, user?.id);
  }

  @Post(':id/pay')
  @ApiOperation({
    summary:
      'Record the payout, write it to the ledger, and close the cycle. ' +
      'Pass acceptRemainingStock to close while stock is still on the shelf.',
  })
  markPaid(
    @Param('id') id: string,
    @Body() body: MarkSettlementPaidDto,
    @CurrentUser() user: any,
  ) {
    return this.settlementsService.markPaid(id, user?.id, {
      acceptRemainingStock: body?.acceptRemainingStock,
    });
  }

  @Post(':id/reverse')
  @ApiOperation({ summary: 'Reverse a settlement with balancing ledger entries' })
  reverse(
    @Param('id') id: string,
    @Body() body: ReverseSettlementDto,
    @CurrentUser() user: any,
  ) {
    return this.settlementsService.reverse(id, body.reason, user?.id);
  }
}
