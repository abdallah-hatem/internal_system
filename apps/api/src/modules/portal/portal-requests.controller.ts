import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { OrderRequestsService } from './order-requests.service';
import { SubmitOrderRequestDto } from './dto/order-request.dto';
import { Surface } from '../../common/surface';
import { CurrentShop } from '../../common/decorators/current-shop.decorator';

/**
 * A shop's own requests.
 *
 * Every route takes the shop from the token via `@CurrentShop()`. None of them
 * accepts a customer id, so there is no route here on which one shop could
 * name another — the check cannot be forgotten because there is nothing to
 * forget.
 */
@ApiTags('Portal')
@ApiBearerAuth()
@Surface('portal')
@UseGuards(AuthGuard('jwt'))
@Controller('portal/requests')
export class PortalRequestsController {
  constructor(private requests: OrderRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'Requests this shop has made' })
  list(@CurrentShop() customerId: string) {
    return this.requests.listForShop(customerId);
  }

  @Post()
  @ApiOperation({ summary: 'Ask to buy, holding the stock for 48 hours' })
  submit(@CurrentShop() customerId: string, @Body() dto: SubmitOrderRequestDto) {
    return this.requests.submit(customerId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of this shop’s requests' })
  detail(@CurrentShop() customerId: string, @Param('id') id: string) {
    return this.requests.detailForShop(customerId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Withdraw a request, releasing the stock' })
  cancel(@CurrentShop() customerId: string, @Param('id') id: string) {
    return this.requests.cancel(customerId, id);
  }
}
