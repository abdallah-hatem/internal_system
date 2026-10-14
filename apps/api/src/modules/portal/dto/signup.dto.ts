import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { PASSWORD_MAX_LENGTH } from '../../../common/password-rule';

export class PortalSignupDto {
  @ApiProperty({ example: 'ahmed@motocenter.example' })
  @IsEmail()
  email!: string;

  /** Strength is the shared rule's (common/password-rule.ts), checked in the service with its own code. */
  @ApiProperty({ example: 'StrongPassword@123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiProperty({ example: 'Moto Center Nasr City' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  shopName!: string;

  @ApiPropertyOptional({ example: '+20 100 000 0000' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;
}
