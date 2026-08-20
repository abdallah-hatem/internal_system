import {
  IsUUID, IsNumber, IsString, IsOptional, IsDateString, Min, IsPositive,
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
  @IsOptional() @IsDateString()
  receivedOn?: string;

  @IsOptional() @IsString()
  method?: string;

  @IsOptional() @IsString()
  reference?: string;
}

export class AllocatePaymentDto {
  @IsUUID('all')
  saleOrderId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'amount must be greater than 0' })
  @Type(() => Number)
  amount: number;
}
