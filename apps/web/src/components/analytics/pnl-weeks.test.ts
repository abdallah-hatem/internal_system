import { describe, expect, it } from 'vitest';
import { periodBuckets } from '../../../../api/src/common/period-buckets';
import { weekStartOf, weeksOfDays, type DayFigures } from './pnl-weeks';

/**
 * A phone folds a by-day profit and loss into Saturday–Friday weeks (owner
 * 2026-10-19, "Option 1"). The weeks must be the API's weeks, cut where the
 * API cuts them, and must add up to the days to the piastre.
 */

const DAY_MS = 86_400_000;
const dayAfter = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Every day of a period as the API sends it, with figures from `fig(i)`. */
function daysOf(from: string, to: string, fig: (i: number) => Partial<DayFigures> = () => ({})): DayFigures[] {
  return periodBuckets(from, to, 'day').map((b, i) => ({
    ...b,
    salesEgp: 0,
    grossProfitEgp: 0,
    expensesEgp: 0,
    netProfitEgp: 0,
    ...fig(i),
  }));
}

const cents = (v: number) => Math.round(v * 100);
const sumCents = (xs: number[]) => xs.reduce((s, v) => s + cents(v), 0);

describe('weekStartOf — Saturday to Friday', () => {
  it('a Saturday starts its own week; a Friday is the last day of the one before', () => {
    expect(weekStartOf('2026-10-17')).toBe('2026-10-17'); // Saturday
    expect(weekStartOf('2026-10-23')).toBe('2026-10-17'); // Friday
    expect(weekStartOf('2026-10-24')).toBe('2026-10-24'); // the next Saturday
    expect(weekStartOf('2026-10-19')).toBe('2026-10-17'); // Monday
    // Across a month and a year.
    expect(weekStartOf('2026-01-01')).toBe('2025-12-27');
  });
});

describe('weeksOfDays — the API’s own weeks', () => {
  it('cuts the same weeks as the API’s week buckets for every period from 1 to 35 days, over three years', () => {
    // Every start day for three years, every length a period is drawn by day.
    for (let s = 0; s < 3 * 366; s += 1) {
      const from = dayAfter('2025-01-01', s);
      for (let len = 1; len <= 35; len += 1) {
        const to = dayAfter(from, len - 1);
        const ours = weeksOfDays(daysOf(from, to)).map(({ key, from: f, to: t }) => ({ key, from: f, to: t }));
        expect(ours).toEqual(periodBuckets(from, to, 'week'));
      }
    }
  });

  it('a month starting on a Friday: a one-day first week, then full weeks', () => {
    // May 2026: the 1st is a Friday.
    const weeks = weeksOfDays(daysOf('2026-05-01', '2026-05-31'));
    expect(weeks.map((w) => [w.from, w.to, w.days.length])).toEqual([
      ['2026-05-01', '2026-05-01', 1],
      ['2026-05-02', '2026-05-08', 7],
      ['2026-05-09', '2026-05-15', 7],
      ['2026-05-16', '2026-05-22', 7],
      ['2026-05-23', '2026-05-29', 7],
      ['2026-05-30', '2026-05-31', 2],
    ]);
    // The first week's key is its Saturday, outside the period, as the API's.
    expect(weeks[0].key).toBe('2026-04-25');
  });

  it('a month starting on a Saturday: no cut first week', () => {
    // August 2026: the 1st is a Saturday.
    const weeks = weeksOfDays(daysOf('2026-08-01', '2026-08-31'));
    expect(weeks[0]).toMatchObject({ key: '2026-08-01', from: '2026-08-01', to: '2026-08-07' });
    expect(weeks.map((w) => w.days.length)).toEqual([7, 7, 7, 7, 3]);
  });

  it('this month so far: the last week ends today, not on its Friday', () => {
    const weeks = weeksOfDays(daysOf('2026-10-01', '2026-10-19'));
    expect(weeks.map((w) => [w.from, w.to])).toEqual([
      ['2026-10-01', '2026-10-02'],
      ['2026-10-03', '2026-10-09'],
      ['2026-10-10', '2026-10-16'],
      ['2026-10-17', '2026-10-19'],
    ]);
  });

  it('one day, and nothing at all', () => {
    expect(weeksOfDays(daysOf('2026-10-19', '2026-10-19'))).toHaveLength(1);
    expect(weeksOfDays([])).toEqual([]);
  });
});

describe('weeksOfDays — the sums', () => {
  it('adds in piastres: ten days of 0.10 and 0.20 make 1.00 and 2.00, never 0.30000000000000004', () => {
    const weeks = weeksOfDays(daysOf('2026-08-01', '2026-08-07', () => ({ salesEgp: 0.1, netProfitEgp: 0.2 })));
    expect(weeks[0].salesEgp).toBe(0.7);
    expect(weeks[0].netProfitEgp).toBe(1.4);
    const three = weeksOfDays(daysOf('2026-08-01', '2026-08-03', () => ({ salesEgp: 0.1, grossProfitEgp: 0.2 })));
    expect(three[0].salesEgp).toBe(0.3);
    expect(three[0].grossProfitEgp).toBe(0.6);
  });

  it('a loss day inside a profitable week, and a week that is a loss overall, keep their signs', () => {
    const net = [500.25, -1_200.4, 0, 100, -0.01, 0, 0];
    const weeks = weeksOfDays(daysOf('2026-08-01', '2026-08-07', (i) => ({ netProfitEgp: net[i], expensesEgp: -net[i] })));
    expect(weeks[0].netProfitEgp).toBe(-600.16);
    expect(weeks[0].expensesEgp).toBe(600.16);
    expect(weeks[0].days.map((d) => d.netProfitEgp)).toEqual(net);
  });

  it('every week is the sum of its days, and the weeks are the sum of the period — exactly, for every figure', () => {
    // Awkward amounts: cents, negatives, large and tiny, deterministic.
    const fig = (i: number) => ({
      salesEgp: ((i * 7919) % 100_000) / 100 + 1_000_000 * (i % 3),
      grossProfitEgp: (((i * 104_729) % 50_000) - 20_000) / 100,
      expensesEgp: ((i * 31) % 997) + 0.07 * (i % 5),
      netProfitEgp: (((i * 15_485_863) % 4_000_000) - 2_500_000) / 100,
    });
    const days = daysOf('2026-05-01', '2026-05-31', fig);
    const weeks = weeksOfDays(days);
    for (const k of ['salesEgp', 'grossProfitEgp', 'expensesEgp', 'netProfitEgp'] as const) {
      for (const w of weeks) expect(cents(w[k])).toBe(sumCents(w.days.map((d) => d[k])));
      expect(sumCents(weeks.map((w) => w[k]))).toBe(sumCents(days.map((d) => d[k])));
      // Each week's figure is itself a whole number of piastres.
      for (const w of weeks) expect(w[k]).toBe(cents(w[k]) / 100);
    }
    // Every day is in exactly one week, in order.
    expect(weeks.flatMap((w) => w.days)).toEqual(days);
  });
});
