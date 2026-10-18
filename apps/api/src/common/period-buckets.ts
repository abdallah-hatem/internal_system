/**
 * How Analytics' profit and loss chart cuts a period into buckets (owner
 * 2026-10-18, "Option A"; BUSINESS_LOGIC §9 "Profit and loss"):
 *
 * - up to 35 days (this month, last month, a short custom range): a day each;
 * - 36 to 124 days (about four months): a week each, **Saturday to Friday** —
 *   the week as an Egyptian calendar prints it, Friday its last day;
 * - longer (this year from February, all time): a calendar month each.
 *
 * The edges are cut to the period: a range starting on a Tuesday has a first
 * week of Tuesday–Friday, as `monthsOfPeriod` cuts months.
 *
 * Every day here is a Cairo calendar day written YYYY-MM-DD, and every step is
 * `Date.UTC` arithmetic on day 1 or on a whole day — no clock is read and no
 * local time is involved, so no timezone can move a day across a boundary
 * (LEARNINGS "Tests that read the clock"). Which Cairo day a record belongs to
 * is decided by its reader before it reaches a bucket.
 */

import { monthsOfPeriod } from './month-buckets';

export const GRANULARITIES = ['day', 'week', 'month'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** The longest period drawn a day per bucket. */
export const DAY_BUCKETS_UP_TO = 35;
/** The longest period drawn a week per bucket; longer is by month. */
export const WEEK_BUCKETS_UP_TO = 124;
/** The day a week starts on, as `getUTCDay` numbers it: Saturday. */
export const WEEK_STARTS_ON = 6;

export interface PeriodBucket {
  /** The day, the week's Saturday, or the month (YYYY-MM). */
  key: string;
  /** Its first and last day inside the period, both included. */
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Days in a run, both ends included: 2026-10-01 … 2026-10-31 is 31. */
export function daysInPeriod(from: string, to: string): number {
  return Math.round((ms(to) - ms(from)) / DAY_MS) + 1;
}

/** The granularity a period of this length is drawn at. */
export function granularityOf(from: string, to: string): Granularity {
  const days = daysInPeriod(from, to);
  if (days <= DAY_BUCKETS_UP_TO) return 'day';
  if (days <= WEEK_BUCKETS_UP_TO) return 'week';
  return 'month';
}

/** The Saturday that starts the week `day` is in. */
export function weekStartOf(day: string): string {
  const t = ms(day);
  const back = (new Date(t).getUTCDay() - WEEK_STARTS_ON + 7) % 7;
  return dayOf(t - back * DAY_MS);
}

/**
 * Every bucket of a run of days, oldest first, none missing — a quiet day is
 * a bucket with nothing in it, never a gap.
 */
export function periodBuckets(
  from: string,
  to: string,
  granularity: Granularity = granularityOf(from, to),
): PeriodBucket[] {
  if (from > to) return [];
  const out: PeriodBucket[] = [];
  if (granularity === 'day') {
    for (let t = ms(from); t <= ms(to); t += DAY_MS) {
      const d = dayOf(t);
      out.push({ key: d, from: d, to: d });
    }
    return out;
  }
  if (granularity === 'week') {
    for (let t = ms(weekStartOf(from)); t <= ms(to); t += 7 * DAY_MS) {
      const start = dayOf(t);
      const end = dayOf(t + 6 * DAY_MS);
      out.push({
        key: start,
        from: start < from ? from : start,
        to: end > to ? to : end,
      });
    }
    return out;
  }
  // Months are the one cut Analytics already had (rule 11).
  return monthsOfPeriod(from, to).map((m) => ({
    key: m.month,
    from: m.from,
    to: m.to,
  }));
}

/** Which bucket holds `day`: its index, or -1 outside them all. */
export function bucketIndexOf(buckets: PeriodBucket[], day: string): number {
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (day < buckets[mid].from) hi = mid - 1;
    else if (day > buckets[mid].to) lo = mid + 1;
    else return mid;
  }
  return -1;
}
