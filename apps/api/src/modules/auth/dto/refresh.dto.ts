import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RefreshDto {
  /** The opaque token from sign-in or the last refresh. */
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  refreshToken: string;
}
