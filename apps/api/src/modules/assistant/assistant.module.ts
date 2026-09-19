import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ProductsModule } from '../products/products.module';
import { PurchasesModule } from '../purchases/purchases.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { CyclesModule } from '../cycles/cycles.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ShippingModule } from '../shipping/shipping.module';
import { AssistantServer } from './assistant-server';
import { ConfirmationService } from './confirmation.service';
import { McpController } from './mcp.controller';

/**
 * The assistant: partners working through Claude (BUSINESS_LOGIC §16).
 *
 * Tools reach other domains' services through `AssistantContext.resolve`; a
 * tool task that needs one imports that service's module here.
 */
@Module({
  imports: [
    AuthModule,
    AuditModule,
    PurchasesModule,
    SuppliersModule,
    ProductsModule,
    CyclesModule,
    ShippingModule,
    InventoryModule,
  ],
  controllers: [McpController],
  providers: [AssistantServer, ConfirmationService],
})
export class AssistantModule {}
