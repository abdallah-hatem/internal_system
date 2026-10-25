import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Shapes only. The amounts' sign, the dates, the currency and the rate are
 * checked in the service with coded refusals the form can say (CLAUDE.md §3,
 * §9) — the assistant or any other caller reaches the service without a DTO.
 */

/** POST /partner-accounts/:partnerUserId/advances — he paid a supplier for a cycle. */
export class CreateAdvanceDto {
  @IsUUID('all')
  cycleId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Type(() => Number)
  amount: number;

  /** The currency he paid in; EGP when left out. */
  @IsOptional()
  @IsString()
  currency?: string;

  /** That day's rate to EGP; required for any currency but EGP. */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  fxRateToEgp?: number;

  /** The Cairo day he paid; today when left out. */
  @IsOptional()
  @IsDateString()
  paidOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** POST /partner-accounts/:partnerUserId/withdrawals — money he took out, in pounds. */
export class CreateWithdrawalDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Type(() => Number)
  amountEgp: number;

  @IsOptional()
  @IsDateString()
  takenOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** A reason travels with every undo (§9). */
export class ReverseMovementDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

/** PUT /cycles/:id/funding-target — set it, or clear it with `amount: null`. */
export class FundingTargetDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Type(() => Number)
  amount?: number | null;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  fxRateToEgp?: number;
}

export class ContributionLineDto {
  @IsUUID('all')
  partnerUserId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Type(() => Number)
  amountEgp: number;
}

/**
 * POST /cycles/:id/account-contributions — draw contributions from the
 * partners' accounts: `totalEgp` in equal shares among the cycle's core
 * partners (the default, owner 2026-10-25), or `lines`, one per partner.
 */
export class ContributeFromAccountsDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Type(() => Number)
  totalEgp?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ContributionLineDto)
  lines?: ContributionLineDto[];

  @IsOptional()
  @IsDateString()
  contributedOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
