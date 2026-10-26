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
import {
  CreateDeliveryDto,
  CreateDepartureDto,
  CreateLossDto,
  CreateLossRefundDto,
} from './dto/delivery.dto';
import { PurchasesService } from '../purchases/purchases.service';
import {
  CreateShippingLegDto,
  UpdateShippingLegDto,
} from './dto/shipping-leg.dto';
import type { ListQuery } from '../../common/list-query';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import type { Viewer } from '../../common/investor-scope';
import { LEG_EDIT_ROLES } from './leg-roles';

@ApiTags('Shipping')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('shipping')
export class ShippingController {
  constructor(
    private shippingService: ShippingService,
    private deliveries: DeliveriesService,
    private purchases: PurchasesService,
  ) {}

  @Get('legs')
  @ApiOperation({
    summary: 'List shipping legs (an investor: their cycles only)',
  })
  findAll(
    @Query() query: ListQuery & { cycleId?: string },
    @CurrentUser() user: Viewer,
  ) {
    return this.shippingService.findAll(query, user);
  }

  @Put('legs/:id')
  @UseGuards(RolesGuard)
  @Roles(...LEG_EDIT_ROLES)
  @ApiOperation({ summary: 'Update a shipping leg' })
  updateLeg(
    @Param('id') id: string,
    @Body() body: UpdateShippingLegDto,
    @CurrentUser() user: any,
  ) {
    return this.shippingService.updateLeg(id, body, user.id);
  }

  // Departures (L8, 2026-10-12), deliveries and losses (BUSINESS_LOGIC §1).
  // Core partners only: each one moves goods, a departure can move the cycle,
  // and a loss books a cost against the cycle (rule 12).

  @Post('legs/:id/departures')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: "Record goods leaving a leg's origin" })
  recordDeparture(
    @Param('id') id: string,
    @Body() body: CreateDepartureDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.deliveries.recordDeparture(id, body, user.id);
  }

  @Delete('departures/:id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Undo a departure recorded by mistake' })
  deleteDeparture(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.deliveries.deleteDeparture(id, user.id);
  }

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

  // Money paid back for a loss (§6, 2026-10-10): a supplier refund on the
  // loss's order, written by the purchases refund path. Core partners only.
  @Post('losses/:id/refunds')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({
    summary:
      "Record a refund for goods lost on the way, from the leg's shipping company or the order's supplier",
  })
  recordLossRefund(
    @Param('id') id: string,
    @Body() body: CreateLossRefundDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.purchases.recordLossRefund(id, body, user.id);
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
  findByCycle(@Param('cycleId') cycleId: string, @CurrentUser() user: Viewer) {
    return this.shippingService.findByCycle(cycleId, user);
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
