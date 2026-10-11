import { Module } from '@nestjs/common';
import {
  CycleFinancingController,
  LenderMoneyController,
  LendersController,
  PurchaseFinancingController,
} from './lenders.controller';
import { LendersService } from './lenders.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

/** A purchase paid by a friend, repaid in pounds (BUSINESS_LOGIC §18). */
@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [
    LendersController,
    PurchaseFinancingController,
    CycleFinancingController,
    LenderMoneyController,
  ],
  providers: [LendersService],
  exports: [LendersService],
})
export class LendersModule {}
