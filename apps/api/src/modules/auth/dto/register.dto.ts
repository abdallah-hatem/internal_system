import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  IsNotEmpty,
  IsEnum,
  IsOptional,
} from 'class-validator';

import { PASSWORD_MAX_LENGTH } from '../../../common/password-rule';

export class RegisterDto {
  @IsEmail()
  email: string;

  /** Strength is `assertStrongPassword`'s, checked in the service with its own code. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;

  @IsString()
  @MinLength(2)
  displayName: string;

  @IsEnum(['CORE_PARTNER', 'TEMP_INVESTOR', 'ADMIN_SUPPORT'])
  role: string;

  @IsOptional()
  @IsString()
  partnerId?: string;
}
