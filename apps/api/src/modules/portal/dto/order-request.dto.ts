import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class OrderRequestLineDto {
  @ApiProperty()
  @IsUUID()
  productId!: string;

  @ApiProperty({ example: 10 })
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  quantity!: number;
}

export class SubmitOrderRequestDto {
  @ApiProperty({ type: [OrderRequestLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderRequestLineDto)
  items!: OrderRequestLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ApprovedLineDto {
  @ApiProperty()
  @IsUUID()
  productId!: string;

  /** Zero drops the line. */
  @ApiProperty({ example: 6 })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  qtyApproved!: number;

  @ApiPropertyOptional({ example: 320 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  unitPrice?: number;
}

export class ApproveOrderRequestDto {
  @ApiProperty({ type: [ApprovedLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApprovedLineDto)
  lines!: ApprovedLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  decisionNote?: string;
}

export class DeclineOrderRequestDto {
  @ApiProperty({ example: 'Out of stock until the next cycle lands.' })
  @IsString()
  @MaxLength(1000)
  decisionNote!: string;
}
