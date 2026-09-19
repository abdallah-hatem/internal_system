import { badRequest } from './api-error';
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
export const BUSINESS_TIMEZONE =
  process.env.BUSINESS_TIMEZONE ?? 'Africa/Cairo';

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
export function assertNotFuture(
  value: string | Date | undefined | null,
  label: string,
) {
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
    throw badRequest(
      'DATE_IN_FUTURE',
      `${label} cannot be in the future (${givenDay}).`,
      { label, day: givenDay },
    );
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written YYYY-MM-DD — "2026-02-30" is not one. */
function assertDay(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !DAY.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw badRequest(
      'BAD_DATE',
      `"${value}" is not a date written YYYY-MM-DD.`,
      { value },
    );
  }
}

/**
 * Check a `from`–`to` filter of calendar days, both ends included.
 *
 * A range that ends before it starts matches nothing, and an empty list reads
 * as "there were no sales then" — a true-looking answer to a question nobody
 * asked. It is refused instead, so whoever typed it sees the slip.
 */
export function assertDayRange(from?: string, to?: string) {
  if (from) assertDay(from);
  if (to) assertDay(to);
  if (from && to && from > to) {
    throw badRequest(
      'DATE_RANGE_REVERSED',
      `The range starts on ${from}, after it ends on ${to}.`,
      { from, to },
    );
  }
}

/** How far the business's clock is ahead of UTC at `at`, in milliseconds. */
function zoneOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant a calendar day begins where the business is.
 *
 * Midnight in Cairo is 21:00 or 22:00 UTC the evening before, depending on
 * daylight saving. Filtering a timestamp column from UTC midnight instead
 * would put a sale made at 01:00 Cairo time on the wrong day. The offset is
 * read twice so a day that starts just after a clock change gets the offset in
 * force at its own midnight.
 */
export function startOfBusinessDay(day: string): Date {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  let start = utcMidnight - zoneOffsetMs(new Date(utcMidnight));
  start = utcMidnight - zoneOffsetMs(new Date(start));
  return new Date(start);
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * A day range as a filter on a timestamp column (`orderedAt`): from the start
 * of `from` to the start of the day after `to`, in the business's timezone.
 */
export function instantRange(
  from?: string,
  to?: string,
): { gte?: Date; lt?: Date } | undefined {
  assertDayRange(from, to);
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: startOfBusinessDay(from) } : {}),
    ...(to ? { lt: startOfBusinessDay(nextDay(to)) } : {}),
  };
}

/**
 * A day range as a filter on a date column (`receivedOn`), which Postgres
 * hands back as UTC midnight of the day itself.
 */
export function calendarRange(
  from?: string,
  to?: string,
): { gte?: Date; lte?: Date } | undefined {
  assertDayRange(from, to);
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}),
    ...(to ? { lte: new Date(`${to}T00:00:00Z`) } : {}),
  };
}
