import { IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min, IsPositive } from 'class-validator';
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

/**
 * POST /purchases/refunds/:id/reverse (B5b). Shape only: the service refuses
 * a blank or whitespace reason too (rule 3), and the length matches its cap.
 */
export class ReverseSupplierRefundDto {
  /** Why the money was handed back. Required (§9), kept on the refund and the ledger row. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
