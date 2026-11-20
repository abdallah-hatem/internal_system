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
import { HandoversService } from './handovers.service';
import {
  AllArrivedDto,
  CreateArrivalDto,
  CreateFreightPaymentDto,
  CreateHandoverDto,
  UpdateFreightPaymentDto,
  UpdateHandoverDto,
} from './dto/handover.dto';
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
    private handovers: HandoversService,
  ) {}

  // UAE legs in handovers (BUSINESS_LOGIC §1, owner 2026-11-20). Core
  // partners only: a handover's freight re-costs the cycle, a partner's
  // freight is money owed to him, and an arrival moves goods (rule 12).

  @Post('legs/:id/handovers')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Hand goods over to the forwarder in the UAE' })
  createHandover(
    @Param('id') id: string,
    @Body() body: CreateHandoverDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.handovers.create(id, body, user.id);
  }

  @Put('handovers/:id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Correct a handover' })
  updateHandover(
    @Param('id') id: string,
    @Body() body: UpdateHandoverDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.handovers.update(id, body, user.id);
  }

  // A handover's freight paid in parts (§2, owner 2026-11-20). Core partners
  // only, as every handover write: a payment re-costs the cycle and a
  // partner's is money owed to him (rule 12).

  @Post('handovers/:id/freight-payments')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: "Record a payment of a handover's freight" })
  addFreightPayment(
    @Param('id') id: string,
    @Body() body: CreateFreightPaymentDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.handovers.addPayment(id, body, user.id);
  }

  @Put('freight-payments/:id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Correct a freight payment' })
  updateFreightPayment(
    @Param('id') id: string,
    @Body() body: UpdateFreightPaymentDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.handovers.updatePayment(id, body, user.id);
  }

  @Delete('freight-payments/:id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Undo a freight payment recorded by mistake' })
  removeFreightPayment(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.handovers.removePayment(id, user.id);
  }

  @Post('legs/:id/freight/recount')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({
    summary: "Count a leg's unpaid freight at today's Exchange rates page rate",
  })
  recountFreight(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.handovers.recount(id, user.id);
  }

  @Delete('handovers/:id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Undo a handover recorded by mistake' })
  removeHandover(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.handovers.remove(id, user.id);
  }

  @Post('legs/:id/arrivals')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Record a batch that arrived from a handover' })
  recordArrival(
    @Param('id') id: string,
    @Body() body: CreateArrivalDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.handovers.recordArrival(id, body, user.id);
  }

  @Delete('arrivals/:id')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Undo an arrival recorded by mistake' })
  removeArrival(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.handovers.removeArrival(id, user.id);
  }

  @Post('handovers/:id/all-arrived')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Mark a handover all arrived' })
  allArrived(
    @Param('id') id: string,
    @Body() body: AllArrivedDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.handovers.allArrived(id, body, user.id);
  }

  @Delete('handovers/:id/all-arrived')
  @UseGuards(RolesGuard)
  @Roles('CORE_PARTNER')
  @ApiOperation({ summary: 'Undo All arrived on a handover' })
  undoAllArrived(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    return this.handovers.undoAllArrived(id, user.id);
  }

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
