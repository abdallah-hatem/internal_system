import { IsOptional, IsNumber, IsEnum, IsUUID, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ParticipantType } from '@prisma/client';

export class AddParticipantDto {
  @IsEnum(ParticipantType)
  participantType: ParticipantType;

  @IsOptional() @IsUUID()
  partnerUserId?: string;

  @IsOptional() @IsUUID()
  investorUserId?: string;

  @IsNumber() @Min(0) @Type(() => Number)
  contributionAmount: number;

  /** Agreed share of cycle profit, when the partners override contribution. */
  @IsOptional() @IsNumber() @Min(0) @Max(100) @Type(() => Number)
  customProfitPct?: number;

  /** Percentage of this investor's own profit taken as a fee. */
  @IsOptional() @IsNumber() @Min(0) @Max(100) @Type(() => Number)
  investorFeePct?: number;
}
