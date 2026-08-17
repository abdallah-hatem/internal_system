"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_module_1 = require("./prisma/prisma.module");
const auth_module_1 = require("./modules/auth/auth.module");
const audit_module_1 = require("./modules/audit/audit.module");
const users_module_1 = require("./modules/users/users.module");
const products_module_1 = require("./modules/products/products.module");
const suppliers_module_1 = require("./modules/suppliers/suppliers.module");
const cycles_module_1 = require("./modules/cycles/cycles.module");
const purchases_module_1 = require("./modules/purchases/purchases.module");
const shipping_module_1 = require("./modules/shipping/shipping.module");
const inventory_module_1 = require("./modules/inventory/inventory.module");
const sales_module_1 = require("./modules/sales/sales.module");
const customers_module_1 = require("./modules/customers/customers.module");
const payments_module_1 = require("./modules/payments/payments.module");
const ledger_module_1 = require("./modules/ledger/ledger.module");
const settlements_module_1 = require("./modules/settlements/settlements.module");
const notifications_module_1 = require("./modules/notifications/notifications.module");
const analytics_module_1 = require("./modules/analytics/analytics.module");
const files_module_1 = require("./modules/files/files.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({ isGlobal: true }),
            prisma_module_1.PrismaModule,
            auth_module_1.AuthModule,
            audit_module_1.AuditModule,
            users_module_1.UsersModule,
            products_module_1.ProductsModule,
            suppliers_module_1.SuppliersModule,
            cycles_module_1.CyclesModule,
            purchases_module_1.PurchasesModule,
            shipping_module_1.ShippingModule,
            inventory_module_1.InventoryModule,
            sales_module_1.SalesModule,
            customers_module_1.CustomersModule,
            payments_module_1.PaymentsModule,
            ledger_module_1.LedgerModule,
            settlements_module_1.SettlementsModule,
            notifications_module_1.NotificationsModule,
            analytics_module_1.AnalyticsModule,
            files_module_1.FilesModule,
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map