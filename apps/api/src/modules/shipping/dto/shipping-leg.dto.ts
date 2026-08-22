import {
  IsOptional, IsString, IsInt, IsNumber, IsEnum, Min, IsUUID, IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ShippingCostBasis } from '@prisma/client';

export class CreateShippingLegDto {
  @IsInt() @Min(1) @Type(() => Number)
  sequence: number;

  @IsString()
  origin: string;

  @IsString()
  destination: string;

  @IsOptional() @IsString()
  provider?: string;

  @IsOptional() @IsUUID('all')
  providerId?: string;

  @IsOptional() @IsString()
  trackingRef?: string;

  @IsOptional() @IsDateString()
  departedOn?: string;

  @IsOptional() @IsDateString()
  arrivedOn?: string;

  @IsOptional() @IsEnum(ShippingCostBasis)
  costBasis?: ShippingCostBasis;

  /** Cost per piece, or per kilogram for a weight-charged leg. */
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  ratePerUnit?: number;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  chargeablePieces?: number;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  chargeableWeightKg?: number;

  @IsOptional() @IsString()
  currency?: string;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  fxRateToEgp?: number;

  /** Only used for a flat leg; rate-based legs derive their own total. */
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  amount?: number;
}

export class UpdateShippingLegDto {
  // `sequence` is deliberately absent: it identifies the leg within its cycle
  // and is uniquely constrained, so it is not a thing an edit may change.
  // Origin and destination are editable in the form, and leaving them out of
  // this DTO meant a correction to either was silently dropped.
  @IsOptional() @IsString()
  origin?: string;

  @IsOptional() @IsString()
  destination?: string;

  @IsOptional() @IsString()
  status?: string;

  @IsOptional() @IsDateString()
  departedOn?: string;

  @IsOptional() @IsDateString()
  arrivedOn?: string;

  @IsOptional() @IsString()
  provider?: string;

  @IsOptional() @IsUUID('all')
  providerId?: string;

  @IsOptional() @IsString()
  trackingRef?: string;

  @IsOptional() @IsEnum(ShippingCostBasis)
  costBasis?: ShippingCostBasis;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  ratePerUnit?: number;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  chargeablePieces?: number;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  chargeableWeightKg?: number;

  @IsOptional() @IsString()
  currency?: string;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  fxRateToEgp?: number;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number)
  amount?: number;
}
