import { Module } from '@nestjs/common';
import { PaymentPlansController } from './payment-plans.controller';
import { SaleContractController } from './sale-contract.controller';
import { PaymentPlansService } from './payment-plans.service';
import { OverdueScheduler } from './overdue.scheduler';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LendersModule } from '../lenders/lenders.module';
import { SalesModule } from '../sales/sales.module';

@Module({
  // LendersModule: the same morning job tells partners about a friend's
  // overdue instalment too (§18) — no cron of its own.
  // SalesModule: the samples-at-a-shop reminder rides the same job (§4).
  imports: [AuditModule, NotificationsModule, LendersModule, SalesModule],
  controllers: [PaymentPlansController, SaleContractController],
  providers: [PaymentPlansService, OverdueScheduler],
  exports: [PaymentPlansService],
})
export class PaymentPlansModule {}
