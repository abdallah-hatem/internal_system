import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateImportRequestDto {
  @ApiProperty({ example: 'Rear brake caliper, Honda CBR 150' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  productName!: string;

  @ApiPropertyOptional({ example: 'Fits CBR 150R 2019 onwards' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  compatibilityText?: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  quantity?: number;

  @ApiPropertyOptional({ example: 'https://example.com/part' })
  @IsOptional()
  // A link is how a shop points at exactly the thing they mean. Validated as a
  // URL so a half-typed one is refused here rather than opened later.
  @IsUrl({ require_protocol: true })
  @MaxLength(2000)
  supplierUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class AnswerImportRequestDto {
  @ApiProperty({ enum: ['SOURCING', 'ANSWERED', 'DECLINED'] })
  @IsString()
  status!: 'SOURCING' | 'ANSWERED' | 'DECLINED';

  @ApiProperty({ example: 'Found it. Landing with the next cycle, about 900 EGP.' })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  decisionNote!: string;

  @ApiPropertyOptional({ description: 'The product this became, once it is stocked.' })
  @IsOptional()
  @IsString()
  productId?: string;
}
