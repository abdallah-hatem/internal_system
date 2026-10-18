import {
  bucketIndexOf,
  daysInPeriod,
  granularityOf,
  periodBuckets,
  weekStartOf,
} from './period-buckets';

/**
 * The chart's buckets, checked over every day of five years rather than a
 * handful (LEARNINGS "Tests that read the clock"): date arithmetic that is
 * right on the days a test happens to pick is not checked.
 */
const DAY = 86_400_000;
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${to}T00:00:00Z`);
    t += DAY
  ) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

describe('period buckets', () => {
  it('every day of 2024–2028: its week starts on the Saturday on or before it, within six days', () => {
    for (const d of days('2024-01-01', '2028-12-31')) {
      const s = weekStartOf(d);
      expect(dow(s)).toBe(6);
      expect(s <= d && daysInPeriod(s, d) <= 7).toBe(true);
    }
  });

  it('for every granularity, the buckets tile the period: each day in exactly one, in order, none outside', () => {
    for (const [from, to] of [
      ['2024-02-20', '2024-03-05'], // a leap February, by day
      ['2026-08-04', '2026-10-18'], // by week, cut at both ends
      ['2025-12-27', '2026-01-09'], // by day across a new year
      ['2025-11-03', '2026-02-02'], // by week across a new year
      ['2024-01-31', '2026-03-01'], // by month from a 31st
    ]) {
      const buckets = periodBuckets(from, to);
      expect(buckets[0].from).toBe(from);
      expect(buckets[buckets.length - 1].to).toBe(to);
      let expected = 0;
      for (const d of days(from, to)) {
        let i = bucketIndexOf(buckets, d);
        if (i !== expected) {
          expected++;
          expect(buckets[expected].from).toBe(d);
          i = bucketIndexOf(buckets, d);
        }
        expect([d, i]).toEqual([d, expected]);
      }
      expect(expected).toBe(buckets.length - 1);
      expect(bucketIndexOf(buckets, '2000-01-01')).toBe(-1);
      expect(bucketIndexOf(buckets, '2099-01-01')).toBe(-1);
    }
  });

  it('the granularity follows the length: 35 days by day, 36–124 by week, then by month', () => {
    expect(granularityOf('2026-10-01', '2026-10-01')).toBe('day');
    expect(granularityOf('2026-01-01', '2026-02-04')).toBe('day');
    expect(granularityOf('2026-01-01', '2026-02-05')).toBe('week');
    expect(granularityOf('2026-01-01', '2026-05-04')).toBe('week');
    expect(granularityOf('2026-01-01', '2026-05-05')).toBe('month');
    expect(periodBuckets('2026-10-19', '2026-10-18')).toEqual([]);
  });

  it('months keep their names and their cut edges', () => {
    expect(periodBuckets('2026-09-15', '2026-11-03', 'month')).toEqual([
      { key: '2026-09', from: '2026-09-15', to: '2026-09-30' },
      { key: '2026-10', from: '2026-10-01', to: '2026-10-31' },
      { key: '2026-11', from: '2026-11-01', to: '2026-11-03' },
    ]);
  });
});
