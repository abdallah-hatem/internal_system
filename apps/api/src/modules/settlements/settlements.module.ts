import { Module } from '@nestjs/common';
import { SettlementsController } from './settlements.controller';
import { SettlementsService } from './settlements.service';
import { AuditModule } from '../audit/audit.module';
import { CostingModule } from '../costing/costing.module';

@Module({
  imports: [AuditModule, CostingModule],
  controllers: [SettlementsController],
  providers: [SettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
