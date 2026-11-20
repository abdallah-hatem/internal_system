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

  /** The lot's freight in full (§2, 2026-11-20: paid in parts). */
  @IsNumber()
  @Type(() => Number)
  freightAmount: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  freightCurrency?: string;

  /** The rate got for what is paid now; left out, today's on the Exchange rates page. */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  freightRateToEgp?: number;

  /**
   * Paid now, on the handover day. Left out: the whole freight; 0 or null:
   * nothing yet. More than the freight is the service's refusal.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Type(() => Number)
  paidAmount?: number | null;

  /** How many pieces, when known. Left out or null: not known. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Type(() => Number)
  pieces?: number | null;

  /**
   * Who paid what is paid now: a core partner (owed to him) or an investor in
   * the cycle (his contribution); left out, the business.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all')
  paidByUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * PUT /shipping/handovers/:id — every field optional; what is left out stays.
 * The freight here is the lot's in full; what was paid, at what rate and by
 * whom is each payment's (`PUT /shipping/freight-payments/:id`, 2026-11-20).
 */
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
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Type(() => Number)
  pieces?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * POST /shipping/handovers/:id/freight-payments — a payment of a handover's
 * freight (§2, owner 2026-11-20). Shape only: more than is still to pay, a
 * future day or one before the handover, a payer not on the cycle are the
 * service's refusals, coded.
 */
export class CreateFreightPaymentDto {
  /** The Cairo day it was paid. */
  @IsDateString()
  paidOn: string;

  /** In the handover's currency. */
  @IsNumber()
  @Type(() => Number)
  amount: number;

  /** The rate got; left out, today's on the Exchange rates page. */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  rateToEgp?: number;

  /** A core partner or an investor in the cycle; left out or null: the business. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('all')
  paidByUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** PUT /shipping/freight-payments/:id — every field optional; what is left out stays. */
export class UpdateFreightPaymentDto {
  @IsOptional()
  @IsDateString()
  paidOn?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  amount?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  rateToEgp?: number;

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
