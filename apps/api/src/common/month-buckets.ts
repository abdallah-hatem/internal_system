/**
 * The last N calendar months, ending with the one we are in.
 *
 * Extracted because the bug it fixes was invisible almost all of the time.
 * `getRevenueByMonth` walked a date forward with `setMonth` and stopped when it
 * passed `new Date()`. Two things were wrong with that, and they compound:
 *
 * - `getMonth`/`setMonth` work in **local** time, while the bucket keys are cut
 *   from `toISOString()`, which is **UTC**. Near midnight the two disagree about
 *   which month it is, so the walk's idea of "have I passed today" is measured
 *   in one calendar and the labels are written in another.
 * - A date carrying a day-of-month cannot be stepped by months. From the 31st,
 *   `setMonth(+1)` lands on a month with no 31st and rolls forward, and the day
 *   drifts for the rest of the walk.
 *
 * Together they made the loop stop one bucket early, so **the current month was
 * missing from the chart** while the dashboard beside it counted the current
 * month's sales — two figures from the same orders disagreeing on one screen.
 *
 * Measured against the old implementation across 2026: wrong on 24 days, at
 * particular hours of those days — about 1.5% of day/hour combinations. That is
 * the reason this is a function with its own test rather than four lines inside
 * a service. It is wrong often enough to hand somebody a false figure and rarely
 * enough that a test which reads the real clock passes almost every time it is
 * run. The end-to-end test guarding this had been green for weeks.
 *
 * Anchored to the first of the month and computed entirely in UTC: day 1 exists
 * in every month, and `Date.UTC` normalises overflow and underflow itself
 * (month 12 is next January, month -1 is last December).
 */
export function monthBuckets(now: Date, months: number): string[] {
  return Array.from({ length: months }, (_, i) => {
    // All UTC, matching the key that is cut from it.
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1) + i, 1));
    return d.toISOString().slice(0, 7);
  });
}

/** The first instant of the earliest bucket — what a query should filter from. */
export function monthBucketsSince(now: Date, months: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
}
