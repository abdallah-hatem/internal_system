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
import { InventoryService } from './inventory.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { VerifyStockDto } from './dto/verify-stock.dto';

@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller()
export class InventoryController {
  constructor(private inventoryService: InventoryService) {}

  @Post('receipts/verify')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({
    summary: 'Receive one last-leg delivery into stock, a batch per line (§3)',
  })
  verifyStock(@Body() body: VerifyStockDto, @CurrentUser() user: any) {
    return this.inventoryService.verifyStock(body.cycleId, body, user.id);
  }

  @Get('inventory')
  @ApiOperation({ summary: 'List stock levels (filter by product/cycle)' })
  getStock(@Query() query: { productId?: string; cycleId?: string }) {
    return this.inventoryService.getStock(query);
  }

  @Get('inventory/batches/:id/movements')
  @ApiOperation({ summary: 'Get movement history for an inventory batch' })
  getMovements(@Param('id') id: string) {
    return this.inventoryService.getMovements(id);
  }
}
