import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Shapes only. The amount's sign and size, the day and the partner are checked
 * in the service with coded refusals the form can say (CLAUDE.md §3, §9).
 */

/** POST /cycles/:id/profit-draws — a core partner takes part of his profit. */
export class CreateProfitDrawDto {
  @IsUUID('all')
  partnerUserId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Type(() => Number)
  amountEgp: number;

  /** The Cairo day he took it; today when left out. */
  @IsOptional()
  @IsDateString()
  drawnOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * POST /cycles/:id/capital-back — a participant, partner or investor, takes
 * part of his capital back before settlement.
 */
export class CreateCapitalBackDto {
  @IsUUID('all')
  userId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Type(() => Number)
  amountEgp: number;

  /** The Cairo day he took it; today when left out. */
  @IsOptional()
  @IsDateString()
  takenOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** POST /profit-draws/:id/reverse — a reason travels with every undo (§9). */
export class ReverseProfitDrawDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
