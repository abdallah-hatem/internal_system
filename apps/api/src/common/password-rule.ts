/**
 * What a password must be, wherever one is set (owner, 2026-10-14).
 *
 * There was no rule at all: change-password took anything, registering a user
 * took six characters, a shop signing up took eight. One business, three
 * answers to the same question — so it is asked once, here, and every place
 * that sets a password calls `assertStrongPassword` (assert-password.ts: this
 * rule as a coded refusal, kept apart so this file imports nothing and the
 * office app's copy can be tested against it):
 *
 *   - POST /auth/change-password  (AuthService.changePassword)
 *   - POST /auth/register         (AuthService.register)
 *   - POST /users                 (UsersService.create)
 *   - POST /auth/portal/signup    (PortalSignupService.signUp)
 *
 * Copies that cannot import this file say so and name it: the office form
 * (`apps/web/src/lib/password-rule.ts`, pinned to this one by a unit test),
 * the storefront's `validate.ts`, and `scripts/prod-reset-partners.sh`.
 *
 * At least 8 characters, at least one letter and one digit. Letters and digits
 * of any script count — a partner typing Arabic is not typing a weaker
 * password. Length is counted as typed: spaces are characters.
 *
 * Signing in is not checked against this. A password set before the rule
 * existed still opens the door; the rule applies the next time it is set.
 */
export const PASSWORD_MIN_LENGTH = 8;

/** The field limit on every DTO that carries a new password. */
export const PASSWORD_MAX_LENGTH = 200;

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
