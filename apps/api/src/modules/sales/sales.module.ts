import { Module } from '@nestjs/common';
import { PriceCheckController, SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { PriceAdjustmentsService } from './price-adjustments.service';
import { OrderHistoryService } from './order-history.service';
import { AuditModule } from '../audit/audit.module';
import { PaymentsModule } from '../payments/payments.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuditModule, PaymentsModule, NotificationsModule],
  controllers: [SalesController, PriceCheckController],
  providers: [SalesService, PriceAdjustmentsService, OrderHistoryService],
  exports: [SalesService, PriceAdjustmentsService],
})
export class SalesModule {}
