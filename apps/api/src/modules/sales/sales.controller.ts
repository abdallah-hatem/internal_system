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
import { SalesService } from './sales.service';
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
    },
  ) {
    return this.salesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get sale order details with allocations' })
  findById(@Param('id') id: string) {
    return this.salesService.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a draft sale order' })
  create(@Body() body: any, @CurrentUser() user: any) {
    return this.salesService.create(body, user.id);
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
