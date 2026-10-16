import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One line of a receipt. Only the shape is checked here: ids that are not
 * uuids, quantities below zero, a negative cost, a line of another delivery —
 * all of that is the service's to refuse, with its own codes, because the
 * assistant calls the same service (CLAUDE.md rule 3).
 */
export class VerifyStockItemDto {
  /** The last-leg delivery line counted in (with `deliveryId`). */
  @IsOptional()
  @IsString()
  deliveryLineId?: string;

  /** The older shape: an order line, with no delivery named. */
  @IsOptional()
  @IsString()
  purchaseOrderItemId?: string;

  /** Ignored: the product is the order line's. Accepted for older callers. */
  @IsOptional()
  @IsString()
  productId?: string;

  @IsNumber()
  @Type(() => Number)
  receivedQty: number;

  /** A manual landed unit cost, for this batch only. */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  landedUnitCostEgp?: number;
}

/** POST /receipts/verify */
export class VerifyStockDto {
  @IsString()
  cycleId: string;

  /** The last-leg delivery received. Leave out for the older shape. */
  @IsOptional()
  @IsString()
  deliveryId?: string;

  /**
   * The day the goods were counted in, YYYY-MM-DD; today when left out. Only
   * the shape is checked here — the service refuses a bad, future or
   * before-arrival day with its own codes.
   */
  @IsOptional()
  @IsString()
  receivedOn?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VerifyStockItemDto)
  items: VerifyStockItemDto[];
}
