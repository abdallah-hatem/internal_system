import { BadRequestException } from '@nestjs/common';

/**
 * The timezone the business actually operates in.
 *
 * "Today" has to mean today in Cairo, not wherever the server happens to run.
 * At 00:37 on the 23rd in Cairo it is still the 22nd in UTC, so a payment
 * entered at that moment looked like tomorrow's and was refused — and the same
 * reasoning in reverse would let a genuinely future date through. Deriving the
 * day from the process locale makes correctness depend on the deployment,
 * which is not a property anyone would think to check.
 */
export const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE ?? 'Africa/Cairo';

/** Today's calendar day where the business is, as YYYY-MM-DD. */
export function businessToday(now = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is the wire format used everywhere here.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Refuse a date that has not happened yet.
 *
 * Records of things that happened cannot be dated forward: money is not
 * received next week, and an order was not placed next month. Accepting one
 * puts revenue and cash into a period that has not occurred, so a report run
 * today already contains next month's figures.
 *
 * Compared as calendar days in the business's timezone. A date column comes
 * back at UTC midnight while "now" is an instant, and comparing the two makes
 * today look like the future for anyone east of Greenwich — which is everyone
 * here.
 */
export function assertNotFuture(value: string | Date | undefined | null, label: string) {
  if (!value) return;

  const given = new Date(value);
  if (Number.isNaN(given.getTime())) return; // shape is the DTO's job, not ours

  // A date-only string is already a calendar day; anything else is an instant
  // and has to be read in the business's timezone to become one.
  const givenDay =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : businessToday(given);

  if (givenDay > businessToday()) {
    throw new BadRequestException(`${label} cannot be in the future (${givenDay}).`);
  }
}
