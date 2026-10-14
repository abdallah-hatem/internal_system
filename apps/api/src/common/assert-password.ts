import { badRequest } from './api-error';
import { PASSWORD_MIN_LENGTH, isStrongPassword } from './password-rule';

/** The password rule (password-rule.ts) as a refusal the client can translate. */
export function assertStrongPassword(password: string): void {
  if (!isStrongPassword(password)) {
    throw badRequest(
      'PASSWORD_TOO_WEAK',
      `A password needs at least ${PASSWORD_MIN_LENGTH} characters, with at least one letter and one digit.`,
      { min: PASSWORD_MIN_LENGTH },
    );
  }
}
