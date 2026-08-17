import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuditModule } from './modules/audit/audit.module';
import { UsersModule } from './modules/users/users.module';
import { ProductsModule } from './modules/products/products.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { CyclesModule } from './modules/cycles/cycles.module';
import { PurchasesModule } from './modules/purchases/purchases.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { SalesModule } from './modules/sales/sales.module';
import { CustomersModule } from './modules/customers/customers.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { SettlementsModule } from './modules/settlements/settlements.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { FilesModule } from './modules/files/files.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    AuditModule,
    UsersModule,
    ProductsModule,
    SuppliersModule,
    CyclesModule,
    PurchasesModule,
    ShippingModule,
    InventoryModule,
    SalesModule,
    CustomersModule,
    PaymentsModule,
    LedgerModule,
    SettlementsModule,
    NotificationsModule,
    AnalyticsModule,
    FilesModule,
  ],
})
export class AppModule {}
