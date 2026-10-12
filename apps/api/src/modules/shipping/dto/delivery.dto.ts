import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
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

/**
 * POST /shipping/legs/:id/departures (L8, 2026-10-12). `lines` left out means
 * everything waiting at the leg's origin that could have left by that day.
 */
export class CreateDepartureDto {
  /** The day it left, YYYY-MM-DD in Cairo. Not in the future. */
  @IsDateString()
  departedOn: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ShipmentLineDto)
  lines?: ShipmentLineDto[];

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

/** Who paid a loss back: the leg's shipping company or the order's supplier. */
export class LossRefundPayerDto {
  @IsIn(['SHIPPING_PROVIDER', 'SUPPLIER'])
  type: 'SHIPPING_PROVIDER' | 'SUPPLIER';

  @IsUUID('all')
  id: string;
}

/**
 * POST /shipping/losses/:id/refunds (§6, 2026-10-10).
 *
 * Shape only. Zero or negative amounts, a future date, and a payer who is not
 * the leg's company or the order's supplier are the service's refusals, with
 * their codes — the service is what every caller reaches (rule 3).
 */
export class CreateLossRefundDto {
  @IsNumber()
  @Type(() => Number)
  amount: number;

  @IsString()
  @MaxLength(3)
  currency: string;

  @IsNumber()
  @Type(() => Number)
  fxRateToEgp: number;

  /** The day the money arrived, YYYY-MM-DD in Cairo; today when left out. */
  @IsOptional()
  @IsDateString()
  recordedOn?: string;

  @ValidateNested()
  @Type(() => LossRefundPayerDto)
  payer: LossRefundPayerDto;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
