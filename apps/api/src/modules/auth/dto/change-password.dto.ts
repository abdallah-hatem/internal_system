import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { PASSWORD_MAX_LENGTH } from '../../../common/password-rule';

/**
 * The body of POST /auth/change-password.
 *
 * It was an inline type, which the global ValidationPipe does not look at, so
 * the web app's `currentPassword` and the controller's `oldPassword` disagreed
 * for as long as both existed and bcrypt was handed `undefined` (2026-10-14).
 * A class makes the pipe's whitelist apply: an unknown field — the old name
 * included — is a 400, not something silently dropped.
 *
 * Presence and type only. Whether the new password is strong enough is
 * `assertStrongPassword`'s question, answered in the service with its own code.
 */
export class ChangePasswordDto {
  @ApiProperty({ example: 'YourCurrentPassword1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;

  @ApiProperty({ example: 'StrongPassword@123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}
