import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Headers,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Payments')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('payments')
export class PaymentsController {
  constructor(private paymentsService: PaymentsService) {}

  @Get()
  @ApiOperation({ summary: 'List payments with filtering and pagination' })
  findAll(
    @Query()
    query: PaginationDto & {
      customerId?: string;
    },
  ) {
    return this.paymentsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get payment details with allocations' })
  findById(@Param('id') id: string) {
    return this.paymentsService.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Record a payment (idempotent via Idempotency-Key header)' })
  create(
    @Body() body: any,
    @CurrentUser() user: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.paymentsService.create(body, user.id, idempotencyKey);
  }

  @Post(':id/allocations')
  @ApiOperation({ summary: 'Allocate a payment to a sale order' })
  allocateToOrder(
    @Param('id') id: string,
    @Body() body: { saleOrderId: string; amount: number },
    @CurrentUser() user: any,
  ) {
    return this.paymentsService.allocateToOrder(
      id,
      body.saleOrderId,
      body.amount,
      user.id,
    );
  }

  @Post(':id/reverse')
  @ApiOperation({ summary: 'Reverse a payment' })
  reverse(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @CurrentUser() user: any,
  ) {
    return this.paymentsService.reverse(id, body.reason, user.id);
  }
}
