import { IsEmail, IsString, MinLength, IsEnum, IsOptional } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(6)
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
