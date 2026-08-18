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
import { ShippingService } from './shipping.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('Shipping')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('shipping')
export class ShippingController {
  constructor(private shippingService: ShippingService) {}

  @Get('legs')
  @ApiOperation({ summary: 'List all shipping legs' })
  findAll(@Query() query: PaginationDto & { cycleId?: string }) {
    return this.shippingService.findAll(query);
  }

  @Put('legs/:id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Update a shipping leg' })
  updateLeg(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.shippingService.updateLeg(id, body, user.id);
  }
}

@ApiTags('Cycle Shipping')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('cycles')
export class CycleShippingController {
  constructor(private shippingService: ShippingService) {}

  @Get(':cycleId/shipping-legs')
  @ApiOperation({ summary: 'List shipping legs for a cycle' })
  findByCycle(@Param('cycleId') cycleId: string) {
    return this.shippingService.findByCycle(cycleId);
  }

  @Post(':cycleId/shipping-legs')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Create a shipping leg for a cycle' })
  createLeg(
    @Param('cycleId') cycleId: string,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.shippingService.createLeg(cycleId, body, user.id);
  }
}
