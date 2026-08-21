import { IsString, MinLength } from 'class-validator';

export class ReverseTransactionDto {
  /** Recorded on the balancing entry and in the audit log. */
  @IsString()
  @MinLength(3, { message: 'reason must explain why the entry is being reversed' })
  reason: string;
}
