import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One ordered product in a delivery or a loss.
 *
 * `qty` is only checked to be a number here. Zero and negative are refused by
 * the service with `QTY_NOT_POSITIVE`, the code every other quantity uses, and
 * the service is also what the assistant calls — a rule kept only in a DTO is
 * a rule one caller skips (CLAUDE.md rule 3).
 */
export class ShipmentLineDto {
  @IsUUID('all')
  purchaseOrderItemId: string;

  @IsNumber()
  @Type(() => Number)
  qty: number;
}

/** POST /shipping/legs/:id/deliveries */
export class CreateDeliveryDto {
  /** The day it arrived, YYYY-MM-DD in Cairo. Not in the future, not before the leg left. */
  @IsDateString()
  arrivedOn: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ShipmentLineDto)
  lines: ShipmentLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** POST /shipping/legs/:id/losses */
export class CreateLossDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ShipmentLineDto)
  lines: ShipmentLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
