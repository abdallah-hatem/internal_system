import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
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
import {
  SUPPLIER_INVOICE_REF_MAX,
  normaliseSupplierInvoiceRef,
} from '../supplier-invoice-ref';

/**
 * The body of `POST /cycles/:cycleId/purchases`.
 *
 * It was `any` until the invoice number arrived. Where the service already has
 * a coded refusal, this leaves the value to it: an empty item list, a zero
 * quantity or a blank product still get PO_NEEDS_ITEM, QTY_NOT_POSITIVE and
 * ITEM_NEEDS_PRODUCT rather than a generic VALIDATION_FAILED. Only shapes that
 * used to reach Prisma and come back as a 500 — a supplier id that is not a
 * uuid, a missing order date — are refused here.
 */
export class CreatePurchaseOrderItemDto {
  @ApiProperty()
  @IsString()
  productId!: string;

  @ApiProperty({ example: 10 })
  @IsNumber()
  @Type(() => Number)
  orderedQty!: number;

  @ApiProperty({ example: 12.5 })
  @IsNumber()
  @Type(() => Number)
  unitPrice!: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  discount?: number;
}

export class CreatePurchaseOrderDto {
  @ApiProperty()
  @IsUUID()
  supplierId!: string;

  @ApiProperty({ example: 'AED' })
  @IsString()
  currency!: string;

  @ApiProperty({ example: 13.85 })
  @IsNumber()
  @Type(() => Number)
  fxRateToEgp!: number;

  @ApiProperty({ example: '2026-09-19' })
  @IsDateString()
  orderedOn!: string;

  @ApiProperty({ type: [CreatePurchaseOrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseOrderItemDto)
  items!: CreatePurchaseOrderItemDto[];

  /**
   * The supplier's own invoice number. Trimmed and upper-cased here so the
   * length is measured on what is stored; blank becomes absent.
   */
  @ApiPropertyOptional({
    example: 'INV-001',
    maxLength: SUPPLIER_INVOICE_REF_MAX,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normaliseSupplierInvoiceRef(value) : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(SUPPLIER_INVOICE_REF_MAX)
  supplierInvoiceRef?: string | null;
}
