import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettlementsModule } from '../settlements/settlements.module';
import {
  CycleProfitDrawsController,
  ProfitDrawsController,
} from './profit-draws.controller';
import { ProfitDrawsService } from './profit-draws.service';

/** Profit taken before a cycle is settled (BUSINESS_LOGIC §8, owner 2026-11-08). */
@Module({
  imports: [AuditModule, SettlementsModule],
  controllers: [CycleProfitDrawsController, ProfitDrawsController],
  providers: [ProfitDrawsService],
})
export class ProfitDrawsModule {}
