import {
  IsArray, IsDateString, IsNumber, IsOptional, IsString, IsUUID,
  MinLength, ArrayMinSize, ValidateNested, IsPositive,
} from 'class-validator';
import { Type } from 'class-transformer';

export class InstalmentDto {
  /** Usually a Sunday; an upfront payment is just the first one, dated today. */
  @IsDateString()
  dueOn: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'each instalment must be greater than 0' })
  @Type(() => Number)
  amount: number;

  @IsOptional() @IsString()
  note?: string;
}

export class CreatePaymentPlanDto {
  @IsUUID('all')
  customerId: string;

  @IsOptional() @IsDateString()
  agreedOn?: string;

  @IsOptional() @IsString()
  note?: string;

  /**
   * Amounts are whatever was agreed — they need not be equal, and there is no
   * fixed weekly figure. 20,000 might be 10,000 up front then 1,000, 5,000 and
   * 4,000 on the next three Sundays.
   */
  @IsArray()
  @ArrayMinSize(1, { message: 'a plan needs at least one instalment' })
  @ValidateNested({ each: true })
  @Type(() => InstalmentDto)
  instalments: InstalmentDto[];
}

export class CancelPaymentPlanDto {
  @IsString()
  @MinLength(3, { message: 'reason must explain why the plan is being cancelled' })
  reason: string;
}
