import {
  IsArray, IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional,
  IsString, IsUUID, MinLength, Min, ValidateNested, ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RefundMethod } from '@prisma/client';

export class ReturnLineDto {
  @IsUUID('all')
  saleItemId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001, { message: 'quantity must be greater than 0' })
  @Type(() => Number)
  qty: number;

  /**
   * Goods that come back damaged are not put back on the shelf. The refund
   * still stands; the cost is written off rather than restocked.
   */
  @IsOptional() @IsBoolean()
  restock?: boolean;
}

export class CreateReturnDto {
  @IsUUID('all')
  saleOrderId: string;

  @IsString()
  @MinLength(3, { message: 'reason must say why the goods came back' })
  reason: string;

  @IsOptional() @IsDateString()
  returnedOn?: string;

  @IsOptional() @IsEnum(RefundMethod)
  refundMethod?: RefundMethod;

  @IsArray()
  @ArrayMinSize(1, { message: 'a return needs at least one line' })
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  items: ReturnLineDto[];
}
