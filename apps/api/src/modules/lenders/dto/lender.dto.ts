import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** A friend who pays suppliers for us (§18). The form is `entity-forms.lender`. */
export class CreateLenderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/** PUT /lenders/:id — the same three fields, all sent (owner, 2026-10-18). */
export class UpdateLenderDto extends CreateLenderDto {}

/**
 * POST /purchases/:id/financings — he paid this much of the order, in his
 * currency at that day's rate (§18, 2026-10-16). Both left out: the order's
 * currency and rate, as before.
 */
export class CreateFinancingDto {
  @IsUUID('all')
  lenderId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'amount must be greater than 0' })
  @Type(() => Number)
  amount: number;

  /**
   * The currency he paid in. Shape only: the service refuses a code that is
   * not three letters (CURRENCY_CODE_INVALID) or has no rate on file
   * (NO_RATE_RECORDED), with codes the form can say.
   */
  @IsOptional()
  @IsString()
  currency?: string;

  /**
   * His currency → EGP on the day he paid. Shape only: the service refuses
   * zero or less (RATE_NOT_POSITIVE) and a fifth decimal (RATE_TOO_PRECISE).
   */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  fxRateToEgp?: number;

  /** The Cairo day he paid the supplier; today when not given. */
  @IsOptional()
  @IsDateString()
  paidOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** POST /lender-financings/:id/repayments — pounds paid on a day at that day's rate. */
export class CreateRepaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'amountEgp must be greater than 0' })
  @Type(() => Number)
  amountEgp: number;

  /** Shape only: zero or less is refused by the service as RATE_NOT_POSITIVE. */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Type(() => Number)
  rateToEgp: number;

  @IsOptional()
  @IsDateString()
  paidOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** A reason travels with every undo (§9). The service refuses a blank one too. */
export class ReasonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class LenderInstalmentDto {
  @IsDateString()
  dueOn: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'each instalment must be greater than 0' })
  @Type(() => Number)
  amount: number;
}

/** POST /lender-financings/:id/plan — instalments in the debt's own currency. */
export class CreateLenderPlanDto {
  @IsOptional()
  @IsDateString()
  agreedOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'a plan needs at least one instalment' })
  @ValidateNested({ each: true })
  @Type(() => LenderInstalmentDto)
  instalments: LenderInstalmentDto[];
}
