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
import { PurchasesService } from './purchases.service';
import { RecordSupplierRefundDto } from './dto/refund.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('Purchases')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('purchases')
export class PurchasesController {
  constructor(private purchasesService: PurchasesService) {}

  @Get()
  @ApiOperation({ summary: 'List purchase orders' })
  findAll(@Query() query: PaginationDto & { cycleId?: string }) {
    return this.purchasesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get purchase order details' })
  findById(@Param('id') id: string) {
    return this.purchasesService.findById(id);
  }

  @Post('items')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Add item to a purchase order' })
  addItem(
    @Body()
    body: {
      purchaseOrderId: string;
      productId: string;
      orderedQty: number;
      unitPrice: number;
      discount?: number;
    },
    @CurrentUser() user: any,
  ) {
    return this.purchasesService.addItem(body.purchaseOrderId, body, user.id);
  }

  @Put('items/:id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Update purchase order item (received qty)' })
  updateItem(
    @Param('id') id: string,
    @Body() body: { receivedQty?: number },
    @CurrentUser() user: any,
  ) {
    return this.purchasesService.updateItem(id, body, user.id);
  }

  @Post(':id/refunds')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Record a supplier refund' })
  recordRefund(
    @Param('id') id: string,
    @Body() body: RecordSupplierRefundDto,
    @CurrentUser() user: any,
  ) {
    return this.purchasesService.recordRefund(id, body, user.id);
  }
}

@ApiTags('Cycle Purchases')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('cycles')
export class CyclePurchasesController {
  constructor(private purchasesService: PurchasesService) {}

  @Post(':cycleId/purchases')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Create purchase order for a cycle' })
  create(
    @Param('cycleId') cycleId: string,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.purchasesService.create(cycleId, body, user.id);
  }

  @Get(':cycleId/purchases')
  @ApiOperation({ summary: 'List purchase orders for a cycle' })
  findByCycle(@Param('cycleId') cycleId: string) {
    return this.purchasesService.findByCycle(cycleId);
  }
}
