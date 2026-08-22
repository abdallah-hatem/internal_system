import { Module } from '@nestjs/common';
import { CurrencyRatesController } from './currency-rates.controller';
import { CurrencyRatesService } from './currency-rates.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [CurrencyRatesController],
  providers: [CurrencyRatesService],
  exports: [CurrencyRatesService],
})
export class CurrencyRatesModule {}
