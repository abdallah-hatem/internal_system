// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; a rate must not become a float
import { Prisma } from '@prisma/client';
import { badRequest } from './api-error';

/**
 * What a currency and a rate to pounds may be — the one definition the
 * exchange-rate page (`PUT`/`POST /currency-rates`) and a friend's payment in
 * his own currency (§18, 2026-10-16) both check against.
 */

/** The currency everything reports in; its rate is 1 by definition. */
export const BASE_CURRENCY = 'EGP';

/** The columns hold four decimals (`Decimal(18, 4)`). */
export const RATE_DECIMALS = 4;

/**
 * A three-letter currency code, upper-cased (`aed` → `AED`). Left out
 * (undefined, null or '') it is undefined. Anything else is
 * CURRENCY_CODE_INVALID.
 */
export function parseCurrencyCode(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(code)) {
    const shown = JSON.stringify(value) ?? typeof value;
    throw badRequest(
      'CURRENCY_CODE_INVALID',
      `${shown} is not a currency code: three letters, such as AED.`,
      { value: shown },
    );
  }
  return code;
}

/**
 * A rate to pounds: a number above zero with at most four decimals. Left out
 * (undefined, null or '') it is undefined. Zero, negative or not a number is
 * RATE_NOT_POSITIVE; a fifth decimal is RATE_TOO_PRECISE — the column would
 * round it, and the figure kept would not be the one typed.
 */
export function parseRateToEgp(value: unknown): Prisma.Decimal | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let rate: Prisma.Decimal;
  try {
    rate = new Prisma.Decimal(
      typeof value === 'number' || typeof value === 'string' ? value : NaN,
    );
  } catch {
    rate = new Prisma.Decimal(NaN);
  }
  if (!rate.isFinite() || rate.lte(0)) {
    throw badRequest(
      'RATE_NOT_POSITIVE',
      'An exchange rate must be greater than zero.',
    );
  }
  if (rate.decimalPlaces() > RATE_DECIMALS) {
    throw badRequest(
      'RATE_TOO_PRECISE',
      `A rate has at most ${RATE_DECIMALS} decimals; ${rate.toString()} has ${rate.decimalPlaces()}.`,
      { rate: rate.toString(), decimals: RATE_DECIMALS },
    );
  }
  return rate;
}
