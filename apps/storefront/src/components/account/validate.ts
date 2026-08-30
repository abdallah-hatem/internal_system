/**
 * The same three rules the API enforces, checked before the round trip.
 *
 * Not instead of the server — the server is the one caller-independent place
 * these can live, and it refuses all three itself. This exists because of what
 * its refusal looks like from here: class-validator answers a bad body with
 * `code: "Bad Request"` and an *array* of English sentences, which no `errors`
 * key matches and no translation covers. A shop typing a six-character password
 * would be shown "password must be longer than or equal to 8 characters", in
 * English, on an Arabic screen.
 *
 * So the limits are mirrored deliberately, with the API's numbers written down
 * beside them. If one moves, both move.
 */

/** `@IsEmail()` on PortalLoginDto and PortalSignupDto. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `@MinLength(8)` on both DTOs. */
export const PASSWORD_MIN = 8;

/** `@MinLength(2)` on PortalSignupDto.shopName. */
export const SHOP_NAME_MIN = 2;

export type FieldErrors = Record<string, string>;

type Messages = (key: string) => string;

export function emailError(value: string, t: Messages): string | undefined {
  const email = value.trim();
  if (!email) return t('emailRequired');
  if (!EMAIL.test(email)) return t('emailInvalid');
  return undefined;
}

export function passwordError(value: string, t: Messages): string | undefined {
  if (!value) return t('passwordRequired');
  // Length, not `trim().length`: a space is a character a password may contain
  // and trimming here would disagree with what the API counts.
  if (value.length < PASSWORD_MIN) return t('passwordTooShort');
  return undefined;
}

export function shopNameError(value: string, t: Messages): string | undefined {
  const name = value.trim();
  if (!name) return t('shopNameRequired');
  if (name.length < SHOP_NAME_MIN) return t('shopNameTooShort');
  return undefined;
}

/** Drops the undefined entries, so `Object.keys` counts only real problems. */
export function collect(candidates: Record<string, string | undefined>): FieldErrors {
  const errors: FieldErrors = {};
  for (const [field, message] of Object.entries(candidates)) {
    if (message) errors[field] = message;
  }
  return errors;
}
