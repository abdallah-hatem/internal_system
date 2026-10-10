import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ShippingService } from './shipping.service';
import { DeliveriesService } from './deliveries.service';
import { CreateDeliveryDto, CreateLossDto } from './dto/delivery.dto';
import {
  CreateShippingLegDto,
  UpdateShippingLegDto,
} from './dto/shipping-leg.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('Shipping')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('shipping')
export class ShippingController {
  constructor(
    private shippingService: ShippingService,
    private deliveries: DeliveriesService,
  ) {}

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
    @Body() body: UpdateShippingLegDto,
    @CurrentUser() user: any,
  ) {
    return this.shippingService.updateLeg(id, body, user.id);
  }

  // Deliveries and losses (BUSINESS_LOGIC §1, 2026-10-10). Core partners only:
  // each one moves goods, and a loss books a cost against the cycle (rule 12).

  @Post('legs/:id/deliveries')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Record goods arriving at the end of a leg' })
  recordDelivery(
    @Param('id') id: string,
    @Body() body: CreateDeliveryDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.deliveries.recordDelivery(id, body, user.id);
  }

  @Delete('deliveries/:id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Remove a delivery recorded by mistake' })
  deleteDelivery(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.deliveries.deleteDelivery(id, user.id);
  }

  @Post('legs/:id/losses')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Mark goods still to come as lost' })
  recordLoss(
    @Param('id') id: string,
    @Body() body: CreateLossDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.deliveries.recordLoss(id, body, user.id);
  }

  @Delete('losses/:id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Take a loss back: the goods are on the way again' })
  takeBackLoss(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.deliveries.takeBackLoss(id, user.id);
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
    @Body() body: CreateShippingLegDto,
    @CurrentUser() user: any,
  ) {
    return this.shippingService.createLeg(cycleId, body, user.id);
  }
}
