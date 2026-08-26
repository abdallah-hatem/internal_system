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
    @Body() body: { version: number },
    @CurrentUser() user: any,
  ) {
    return this.salesService.confirmOrder(id, user.id, body.version);
  }

  @Post(':id/cancel')
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Cancel a sale order and release allocations' })
  cancelOrder(@Param('id') id: string, @CurrentUser() user: any) {
    return this.salesService.cancelOrder(id, user.id);
  }
}
