import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CustomerBranchesService } from './customer-branches.service';
import { AuditModule } from '../audit/audit.module';
import { PaymentPlansModule } from '../payment-plans/payment-plans.module';

@Module({
  // PaymentPlansModule: what is overdue comes only from plans (§7), for the
  // dashboard's To collect card.
  imports: [AuditModule, PaymentPlansModule],
  controllers: [CustomersController],
  providers: [CustomersService, CustomerBranchesService],
  exports: [CustomersService, CustomerBranchesService],
})
export class CustomersModule {}
