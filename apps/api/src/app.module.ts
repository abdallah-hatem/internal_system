import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { SurfaceGuard } from './common/guards/surface.guard';
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
import { ProvidersModule } from './modules/providers/providers.module';
import { CurrencyRatesModule } from './modules/currency-rates/currency-rates.module';
import { CostingModule } from './modules/costing/costing.module';
import { ReturnsModule } from './modules/returns/returns.module';
import { PaymentPlansModule } from './modules/payment-plans/payment-plans.module';
import { PortalModule } from './modules/portal/portal.module';

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
    ProvidersModule,
    CurrencyRatesModule,
    CostingModule,
    ReturnsModule,
    PaymentPlansModule,
    PortalModule,
  ],
  providers: [
    /**
     * Global on purpose.
     *
     * Applied per controller this would be twenty-two decorators, and the
     * twenty-third controller — written next year by someone who has not read
     * this file — would not have it. Registered here, a route is fenced unless
     * it says otherwise, which is the opposite of how `RolesGuard` behaves and
     * the reason four money-moving modules once carried no guard at all.
     *
     * `JwtService` resolves because `AuthModule` re-exports `JwtModule`.
     */
    { provide: APP_GUARD, useClass: SurfaceGuard },
  ],
})
export class AppModule {}
