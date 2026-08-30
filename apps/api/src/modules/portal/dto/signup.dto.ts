import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class PortalSignupDto {
  @ApiProperty({ example: 'ahmed@motocenter.example' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'a good password' })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
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
