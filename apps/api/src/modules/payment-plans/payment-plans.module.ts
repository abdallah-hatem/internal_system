import { Module } from '@nestjs/common';
import { PaymentPlansController } from './payment-plans.controller';
import { PaymentPlansService } from './payment-plans.service';
import { OverdueScheduler } from './overdue.scheduler';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [PaymentPlansController],
  providers: [PaymentPlansService, OverdueScheduler],
  exports: [PaymentPlansService],
})
export class PaymentPlansModule {}
