import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class MarkSettlementPaidDto {
  /**
   * Close the cycle even though stock remains. Unsold stock keeps its cost
   * with the cycle, so this writes that cost off here — an explicit decision,
   * never a default.
   */
  @IsOptional() @IsBoolean()
  acceptRemainingStock?: boolean;
}

export class ReverseSettlementDto {
  /** Recorded on the reversing entries and in the audit log. */
  @IsString()
  @MinLength(3, { message: 'reason must explain why the settlement is being reversed' })
  reason: string;
}
