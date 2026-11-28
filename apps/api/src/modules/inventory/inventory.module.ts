import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { StockDamagesController } from './stock-damages.controller';
import { StockDamagesService } from './stock-damages.service';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CostingModule } from '../costing/costing.module';
import { CyclesModule } from '../cycles/cycles.module';

@Module({
  imports: [AuditModule, NotificationsModule, CostingModule, CyclesModule],
  controllers: [InventoryController, StockDamagesController],
  providers: [InventoryService, StockDamagesService],
  exports: [InventoryService],
})
export class InventoryModule {}
