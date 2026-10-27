import { randomBytes, randomUUID } from 'crypto';
import { badRequest } from '../../common/api-error';

/**
 * A temporary investor made from a name alone (BUSINESS_LOGIC §8 "A new
 * temporary investor from the Funding card", owner 2026-10-26).
 *
 * An investor never signs in to the office (`OFFICE_NOT_FOR_INVESTORS`, §12),
 * but a person here is a `User` row, and a user needs an email and a
 * password. So both are made up: an address under `.invalid` — a top-level
 * domain reserved never to exist (RFC 2606), so nothing is ever sent to it and
 * it can never be a real person's — and a long random password that is hashed
 * and thrown away. Nobody is told either, because nobody uses them.
 */

/** As long as a name anyone would type; the picker shows it in one line. */
export const INVESTOR_NAME_MAX = 80;

/** The name as stored: trimmed, inner runs of spaces as one. Refused empty or too long. */
export function investorName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) {
    throw badRequest('INVESTOR_NAME_REQUIRED', 'An investor needs a name.');
  }
  if (name.length > INVESTOR_NAME_MAX) {
    throw badRequest(
      'INVESTOR_NAME_TOO_LONG',
      `An investor's name can be at most ${INVESTOR_NAME_MAX} characters.`,
      { max: INVESTOR_NAME_MAX },
    );
  }
  return name;
}

/** An address that is nobody's and receives nothing — unique per investor. */
export function madeUpInvestorEmail(): string {
  return `investor-${randomUUID()}@investors.invalid`;
}

/** A password nobody is given: 32 random bytes, only ever stored hashed. */
export function madeUpInvestorPassword(): string {
  return randomBytes(32).toString('base64url');
}
