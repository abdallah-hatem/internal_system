import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import {
  CycleTransfersController,
  StockTransfersController,
} from './stock-transfers.controller';
import { StockTransfersService } from './stock-transfers.service';

/** Leftover stock moved to another cycle at its cost (BUSINESS_LOGIC §8, L5). */
@Module({
  imports: [AuditModule],
  controllers: [CycleTransfersController, StockTransfersController],
  providers: [StockTransfersService],
  exports: [StockTransfersService],
})
export class StockTransfersModule {}
