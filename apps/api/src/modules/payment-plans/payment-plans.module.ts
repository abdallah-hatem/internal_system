import { Module } from '@nestjs/common';
import { PaymentPlansController } from './payment-plans.controller';
import { PaymentPlansService } from './payment-plans.service';
import { OverdueScheduler } from './overdue.scheduler';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LendersModule } from '../lenders/lenders.module';

@Module({
  // LendersModule: the same morning job tells partners about a friend's
  // overdue instalment too (§18) — no cron of its own.
  imports: [AuditModule, NotificationsModule, LendersModule],
  controllers: [PaymentPlansController],
  providers: [PaymentPlansService, OverdueScheduler],
  exports: [PaymentPlansService],
})
export class PaymentPlansModule {}
