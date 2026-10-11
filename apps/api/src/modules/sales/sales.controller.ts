import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Headers,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  SalesService,
  type CreateSaleOrderInput,
  type PriceCheckInput,
} from './sales.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { badRequest } from '../../common/api-error';

@ApiTags('Sales')
@ApiBearerAuth()
/**
 * Selling is day-to-day office work; cancelling a confirmed order is not.
 *
 * No role guard existed here, so any logged-in account could cancel an order.
 */
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
@Controller('sales/orders')
export class SalesController {
  constructor(private salesService: SalesService) {}

  @Get()
  @ApiOperation({ summary: 'List sale orders with filtering and pagination' })
  findAll(
    @Query()
    query: PaginationDto & {
      customerId?: string;
      status?: string;
      channel?: string;
      from?: string;
      to?: string;
    },
  ) {
    return this.salesService.findAll(query);
  }

  @Get(':id/invoice')
  @ApiOperation({
    summary:
      'A confirmed sale as an invoice / delivery note: lines, totals, paid, still owed, and the shop balance before and after it. Refused for a draft or a cancelled order.',
  })
  invoice(@Param('id') id: string) {
    return this.salesService.invoice(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get sale order details with allocations' })
  findById(@Param('id') id: string) {
    return this.salesService.findById(id);
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a draft sale order, or with `confirm: true` create and confirm it in one transaction (idempotent via Idempotency-Key header)',
  })
  create(
    @Body() body: CreateSaleOrderInput,
    @CurrentUser() user: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.salesService.create(body, user.id, idempotencyKey);
  }

  @Post(':id/confirm')
  @ApiOperation({ summary: 'Confirm order and perform FIFO stock allocation' })
  confirmOrder(
    @Param('id') id: string,
    @Body() body: { version?: number } | undefined,
    @CurrentUser() user: any,
  ) {
    // `@Body()` is undefined when the request carries none, so `body.version`
    // threw and every caller that forgot it got a 500 reading "An unexpected
    // error occurred". The version is how two people editing one order are
    // kept from overwriting each other, so it is required — and saying so is
    // the whole job of this check.
    if (body?.version === undefined) {
      throw badRequest(
        'VERSION_REQUIRED',
        'Confirming an order requires the version it was read at.',
      );
    }
    return this.salesService.confirmOrder(id, user.id, body.version);
  }

  @Post(':id/cancel')
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Cancel a sale order and release allocations' })
  cancelOrder(@Param('id') id: string, @CurrentUser() user: any) {
    return this.salesService.cancelOrder(id, user.id);
  }
}

/**
 * Would these lines sell below cost? (BUSINESS_LOGIC §4, 2026-10-11.)
 *
 * Its own path, beside the orders rather than under them: it is not an order
 * and writes nothing, and a screen watching for "the order was sent" must not
 * count every check the form makes as the user types. The roles are the
 * sales roles — the people who already read landed costs — named here rather
 * than left to the guard's default, which is to allow (rule 12).
 */
@ApiTags('Sales')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
@Controller('sales')
export class PriceCheckController {
  constructor(private salesService: SalesService) {}

  @Post('price-check')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Would these lines sell below cost? Each line against the FIFO cost of the units it would draw, after its discount. A warning only — nothing is refused and nothing is written (BUSINESS_LOGIC §4).',
  })
  priceCheck(@Body() body: PriceCheckInput) {
    return this.salesService.priceCheck(body);
  }
}
