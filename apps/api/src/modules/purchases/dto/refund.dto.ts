import { IsDateString, IsNumber, IsOptional, IsString, Min, IsPositive } from 'class-validator';
import { Type } from 'class-transformer';

export class RecordSupplierRefundDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'amount must be greater than 0' })
  @Type(() => Number)
  amount: number;

  @IsString()
  currency: string;

  /** The refund lands in the cycle in EGP, like every other cost on it. */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001, { message: 'fxRateToEgp must be greater than 0' })
  @Type(() => Number)
  fxRateToEgp: number;

  @IsOptional() @IsString()
  reason?: string;

  @IsOptional() @IsDateString()
  recordedOn?: string;
}
