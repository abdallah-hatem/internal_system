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
import { ReverseTransactionDto } from './dto/ledger.dto';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';

@ApiTags('Ledger')
@ApiBearerAuth()
/**
 * The ledger is readable by the office and correctable only by a partner.
 *
 * No role guard existed here, so any logged-in account could raise an entry or
 * reverse one — the two things that make the books say something different.
 */
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
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
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Create a financial transaction' })
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.ledgerService.create(body, user.id);
  }

  @Post(':id/reverse')
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Reverse a financial transaction' })
  reverse(
    @Param('id') id: string,
    @Body() body: ReverseTransactionDto,
    @CurrentUser() user: any,
  ) {
    return this.ledgerService.reverse(id, body.reason, user.id);
  }
}
