import {
  IsUUID,
  IsNumber,
  IsString,
  IsOptional,
  IsDateString,
  Min,
  IsPositive,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePaymentDto {
  @IsUUID('all')
  customerId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'amount must be greater than 0' })
  @Type(() => Number)
  amount: number;

  @IsString()
  currency: string;

  /** Defaults to today when the caller does not say otherwise. */
  @IsOptional()
  @IsDateString()
  receivedOn?: string;

  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsString()
  reference?: string;

  /**
   * Put the money on this order (BUSINESS_LOGIC §7, 2026-10-10): the payer's
   * own, confirmed, still owing, and no more than it owes. Without it the
   * payment is recorded unallocated, as before.
   */
  @IsOptional()
  @IsUUID('all')
  orderId?: string;
}

export class AllocatePaymentDto {
  @IsUUID('all')
  saleOrderId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'amount must be greater than 0' })
  @Type(() => Number)
  amount: number;
}
