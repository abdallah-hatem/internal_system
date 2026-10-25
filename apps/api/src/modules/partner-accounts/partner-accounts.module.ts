import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CostingModule } from '../costing/costing.module';
import {
  CycleAccountFundingController,
  PartnerAccountsController,
} from './partner-accounts.controller';
import { PartnerAccountsService } from './partner-accounts.service';

/** Partners' running accounts (BUSINESS_LOGIC §8, owner 2026-10-25). */
@Module({
  imports: [AuditModule, CostingModule],
  controllers: [PartnerAccountsController, CycleAccountFundingController],
  providers: [PartnerAccountsService],
  exports: [PartnerAccountsService],
})
export class PartnerAccountsModule {}
