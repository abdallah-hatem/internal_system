import { monthBuckets, monthBucketsSince } from './month-buckets';

/**
 * Date arithmetic is checked against many dates or it is not checked. The bug
 * this replaces only appeared in the last days of a month, so the end-to-end
 * test guarding it passed on about twenty-seven days in thirty — including
 * every day anyone happened to run it, until one day it did not.
 */
describe('monthBuckets', () => {
  it('ends with the month it is called in — on every day of a four-year span', () => {
    // Four years covers a leap year, every month length, and every day-of-month
    // that could drift. This is the assertion the old code failed.
    const failures: string[] = [];

    for (let t = Date.UTC(2024, 0, 1); t <= Date.UTC(2027, 11, 31); t += 24 * 60 * 60 * 1000) {
      const now = new Date(t);
      const expected = now.toISOString().slice(0, 7);
      const buckets = monthBuckets(now, 12);
      if (buckets[buckets.length - 1] !== expected) {
        failures.push(`${now.toISOString().slice(0, 10)} → ended at ${buckets[buckets.length - 1]}, wanted ${expected}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('returns exactly the number of months asked for', () => {
    for (const n of [1, 2, 3, 6, 12, 24]) {
      expect(monthBuckets(new Date('2026-08-31T23:59:59Z'), n)).toHaveLength(n);
    }
  });

  it('is a run of consecutive months with no gap and no repeat', () => {
    // The drifting walk could also skip a month outright — February eats the
    // 30th and the next key jumps from January to March.
    // Collected rather than asserted in the loop: jest's `expect` takes no
    // message, so a bare `toBe(1)` failing tells you nothing about which day or
    // which pair of months was wrong.
    const problems: string[] = [];

    for (const day of ['2026-01-31', '2026-02-28', '2026-03-31', '2026-08-30', '2026-12-31']) {
      const buckets = monthBuckets(new Date(`${day}T12:00:00Z`), 18);
      if (new Set(buckets).size !== buckets.length) problems.push(`${day}: repeated a month`);

      for (let i = 1; i < buckets.length; i++) {
        const [py, pm] = buckets[i - 1].split('-').map(Number);
        const [cy, cm] = buckets[i].split('-').map(Number);
        const gap = (cy - py) * 12 + (cm - pm);
        if (gap !== 1) problems.push(`${day}: ${buckets[i - 1]} → ${buckets[i]} is a gap of ${gap}`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('crosses the year boundary correctly', () => {
    const buckets = monthBuckets(new Date('2026-02-15T00:00:00Z'), 4);
    expect(buckets).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('handles the 31st of a month followed by a short one', () => {
    // The specific shape that broke it: a late day-of-month, then February.
    expect(monthBuckets(new Date('2026-03-31T00:00:00Z'), 3)).toEqual([
      '2026-01', '2026-02', '2026-03',
    ]);
  });

  it('starts `since` at the first instant of the earliest bucket', () => {
    const now = new Date('2026-08-31T21:39:44.524Z');
    const since = monthBucketsSince(now, 12);
    expect(since.toISOString()).toBe('2025-09-01T00:00:00.000Z');
    // And it must agree with the first bucket, or the query filters from a
    // different month than the chart displays.
    expect(since.toISOString().slice(0, 7)).toBe(monthBuckets(now, 12)[0]);
  });

  it('agrees with `since` on every day of the span', () => {
    const failures: string[] = [];
    for (let t = Date.UTC(2024, 0, 1); t <= Date.UTC(2027, 11, 31); t += 24 * 60 * 60 * 1000) {
      const now = new Date(t);
      if (monthBucketsSince(now, 12).toISOString().slice(0, 7) !== monthBuckets(now, 12)[0]) {
        failures.push(now.toISOString().slice(0, 10));
      }
    }
    expect(failures).toEqual([]);
  });
});
