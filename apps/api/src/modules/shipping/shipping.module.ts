import { Module } from '@nestjs/common';
import {
  ShippingController,
  CycleShippingController,
} from './shipping.controller';
import { ShippingService } from './shipping.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [ShippingController, CycleShippingController],
  providers: [ShippingService],
  exports: [ShippingService],
})
export class ShippingModule {}
