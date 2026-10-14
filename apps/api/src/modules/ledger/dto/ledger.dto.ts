import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MANUAL_ENTRY_KIND_CODES } from '../../../common/manual-ledger-categories';

export class ReverseTransactionDto {
  /** Recorded on the balancing entry and in the audit log. */
  @IsString()
  @MinLength(3, {
    message: 'reason must explain why the entry is being reversed',
  })
  reason: string;
}

/**
 * A manual ledger entry (BUSINESS_LOGIC §9, L6).
 *
 * Shape only. Every rule about what may be recorded — the category list, the
 * direction the kind fixes, the cycle, the date — is the service's, so the
 * API refuses it whoever calls (rule 3), with a code the web can say.
 *
 * Unknown properties are refused by the global pipe (`forbidNonWhitelisted`),
 * so `relatedType` or `reversalOfId` cannot ride along on a
 * hand-written row and make it look like one a flow wrote.
 */
export class CreateLedgerEntryDto {
  @IsIn(MANUAL_ENTRY_KIND_CODES)
  kind: string;

  @IsString()
  @MaxLength(64)
  category: string;

  /** Optional: the kind decides it. Sent, it must agree. */
  @IsOptional()
  @IsString()
  direction?: string;

  /** Optional: the kind decides it. Sent, it must agree. */
  @IsOptional()
  @IsString()
  type?: string;

  @IsNumber()
  amount: number;

  @IsString()
  currency: string;

  @IsOptional()
  @IsNumber()
  fxRateToEgp?: number;

  /** YYYY-MM-DD, the Cairo day; today when left out. */
  @IsOptional()
  @IsString()
  occurredOn?: string;

  @IsOptional()
  @IsString()
  cycleId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
