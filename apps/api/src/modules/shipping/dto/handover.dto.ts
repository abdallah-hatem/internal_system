import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ShipmentLineDto } from './delivery.dto';

/**
 * A UAE handover (BUSINESS_LOGIC §1, owner 2026-11-20). Shape only: a
 * negative freight, pieces that are not whole or more than wait in the UAE,
 * a future day, a payer who is not a partner are the service's refusals,
 * with their codes — the service is what every caller reaches (rule 3).
 */
export class CreateHandoverDto {
  /** The day the lot was handed to the forwarder, YYYY-MM-DD in Cairo. */
  @IsDateString()
  handedOverOn: string;

  /** The forwarder (a shipping provider). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all')
  providerId?: string | null;

  @IsNumber()
  @Type(() => Number)
  freightAmount: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  freightCurrency?: string;

  /** The rate on the day; left out, today's on the Exchange rates page. */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  freightRateToEgp?: number;

  /** How many pieces, when known. Left out or null: not known. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Type(() => Number)
  pieces?: number | null;

  /** A core partner who paid the freight himself; left out: the business. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all')
  paidByUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** PUT /shipping/handovers/:id — every field optional; what is left out stays. */
export class UpdateHandoverDto {
  @IsOptional()
  @IsDateString()
  handedOverOn?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all')
  providerId?: string | null;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  freightAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  freightCurrency?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  freightRateToEgp?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Type(() => Number)
  pieces?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all')
  paidByUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** POST /shipping/legs/:id/arrivals — a batch from a handover, counted. */
export class CreateArrivalDto {
  /** Left out: the leg's one open handover. */
  @IsOptional()
  @IsUUID('all')
  handoverId?: string;

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

/** POST /shipping/handovers/:id/all-arrived */
export class AllArrivedDto {
  /** The day; today when left out. */
  @IsOptional()
  @IsDateString()
  on?: string;

  /** Which products the missing pieces were, when its count says some are. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ShipmentLineDto)
  lost?: ShipmentLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
