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
import { LedgerService } from './ledger.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Ledger')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('ledger')
export class LedgerController {
  constructor(private ledgerService: LedgerService) {}

  @Get()
  @ApiOperation({ summary: 'List financial transactions with filtering and pagination' })
  findAll(
    @Query()
    query: PaginationDto & {
      cycleId?: string;
      accountId?: string;
      type?: string;
      category?: string;
      direction?: string;
      from?: string;
      to?: string;
    },
  ) {
    return this.ledgerService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a financial transaction by ID' })
  findOne(@Param('id') id: string) {
    return this.ledgerService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a financial transaction' })
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.ledgerService.create(body, user.id);
  }

  @Post(':id/reverse')
  @ApiOperation({ summary: 'Reverse a financial transaction' })
  reverse(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @CurrentUser() user: any,
  ) {
    return this.ledgerService.reverse(id, body.reason, user.id);
  }
}
