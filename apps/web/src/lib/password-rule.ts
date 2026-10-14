/**
 * The API's password rule, for the form that sets one (2026-10-14).
 *
 * One definition, kept in two files: Next cannot import across apps. The
 * original is `apps/api/src/common/password-rule.ts`, and the server applies
 * it whatever this says. This copy exists so the Settings form can say the rule
 * before the round trip, in the same words as the server's refusal.
 * `password-rule.test.ts` runs both over the same samples and fails the moment
 * one changes without the other.
 */
export const PASSWORD_MIN_LENGTH = 8;

const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

export function isStrongPassword(password: unknown): boolean {
  return (
    typeof password === 'string' &&
    password.length >= PASSWORD_MIN_LENGTH &&
    LETTER.test(password) &&
    DIGIT.test(password)
  );
}
