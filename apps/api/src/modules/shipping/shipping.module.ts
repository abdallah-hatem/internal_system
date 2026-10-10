import { Module } from '@nestjs/common';
import {
  ShippingController,
  CycleShippingController,
} from './shipping.controller';
import { ShippingService } from './shipping.service';
import { DeliveriesService } from './deliveries.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CostingModule } from '../costing/costing.module';

@Module({
  imports: [AuditModule, NotificationsModule, CostingModule],
  controllers: [ShippingController, CycleShippingController],
  providers: [ShippingService, DeliveriesService],
  exports: [ShippingService, DeliveriesService],
})
export class ShippingModule {}
