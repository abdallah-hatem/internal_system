import {
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Shape only. Zero, negative, too many, a product twice, no lines and a blank
 * reason are refused by the service with their own codes (rule 9), so the
 * assistant — planned, §16 — calling the service directly is held to the same
 * rules as the form.
 */
export class TransferLineDto {
  @IsUUID('all')
  productId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Type(() => Number)
  qty: number;
}

/** POST /cycles/:id/transfers — move this cycle's leftovers to another cycle (§8, L5). */
export class CreateStockTransferDto {
  @IsUUID('all')
  toCycleId: string;

  /** The Cairo day the units moved; today when not given. */
  @IsOptional()
  @IsDateString()
  movedOn?: string;

  @IsString()
  @MaxLength(500)
  reason: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransferLineDto)
  lines: TransferLineDto[];
}

/** POST /stock-transfers/:id/undo — a reason travels with every undo (§9). */
export class UndoStockTransferDto {
  @IsString()
  @MaxLength(500)
  reason: string;
}
