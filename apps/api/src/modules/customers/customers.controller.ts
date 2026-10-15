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
import { CustomersService } from './customers.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('Customers')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('customers')
export class CustomersController {
  constructor(private customersService: CustomersService) {}

  // Customer data — every shop, its balance, what it owes and returned — is
  // the office's. A temporary investor sees only their own cycles (BUSINESS_LOGIC
  // roles, owner 2026-10-10), so the reads refuse them with ROLE_NOT_ALLOWED.
  @Get()
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'List customers with filtering and pagination' })
  findAll(
    @Query()
    query: PaginationDto & {
      type?: string;
      search?: string;
      /** VERIFIED | UNVERIFIED | ALL. Omitted hides unverified signups. */
      verification?: string;
    },
  ) {
    return this.customersService.findAll(query);
  }

  // The dashboard's To collect card (owner, 2026-10-15): the customers to
  // chase first and the totals owed and overdue. Balances are the office's,
  // so the same roles as the customer list. Before ':id', which would read
  // "to-collect" as a customer id.
  @Get('to-collect')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({
    summary:
      'Customers to collect from first: overdue before not, then the largest balance; with totals',
  })
  toCollect(@Query('limit') limit?: string) {
    return this.customersService.toCollect(toCollectLimit(limit));
  }

  // A shop's statement is its money, so the same roles as its balance.
  @Get(':id/statement')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({
    summary:
      "A customer's statement for a range of days: opening balance, every sale, payment, return and reversal with a running balance, closing balance",
  })
  statement(
    @Param('id') id: string,
    @Query() query: { from?: string; to?: string },
  ) {
    return this.customersService.statement(id, query);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
  @ApiOperation({ summary: 'Get customer details with orders and payments' })
  findById(@Param('id') id: string) {
    return this.customersService.findById(id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Create a new customer (CORE_PARTNER only)' })
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.customersService.create(body, user.id);
  }

  @Post(':id/verify')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({
    summary:
      'Vet a self-signed-up shop (CORE_PARTNER only). Until this runs, every ' +
      'service that moves money refuses the account.',
  })
  verify(@Param('id') id: string, @CurrentUser() user: any) {
    return this.customersService.verify(id, user.id);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Update a customer (CORE_PARTNER only)' })
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.customersService.update(id, body, user.id);
  }
}

/**
 * Rows the To collect card may ask for: 5 by default, never fewer than 1 or
 * more than 20 — a dashboard card, not a list. Anything that is not a whole
 * number reads as the default rather than as an error a card cannot show.
 */
export function toCollectLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(n)) return 5;
  return Math.min(20, Math.max(1, n));
}
