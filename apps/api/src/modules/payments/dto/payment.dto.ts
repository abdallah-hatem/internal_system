import {
  IsUUID,
  IsNumber,
  IsString,
  IsOptional,
  IsDateString,
  Min,
  IsPositive,
  IsBoolean,
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

  /**
   * Without `orderId`, put the money on the shop's unpaid orders oldest first
   * in the same transaction (§7). Ignored with `orderId`.
   */
  @IsOptional()
  @IsBoolean()
  applyOldestFirst?: boolean;

  /**
   * Pay one branch (BUSINESS_LOGIC §7, 2026-10-25): oldest first across that
   * branch's orders only, never more than the branch owes. Without it the
   * money goes across all the customer's orders, whatever their branch.
   */
  @IsOptional()
  @IsUUID('all')
  branchId?: string;
}

export class AllocatePaymentDto {
  @IsUUID('all')
  saleOrderId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'amount must be greater than 0' })
  @Type(() => Number)
  amount: number;
}
