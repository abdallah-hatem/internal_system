import { Module } from '@nestjs/common';
import {
  PurchasesController,
  CyclePurchasesController,
} from './purchases.controller';
import { PurchasesService } from './purchases.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [PurchasesController, CyclePurchasesController],
  providers: [PurchasesService],
  exports: [PurchasesService],
})
export class PurchasesModule {}
