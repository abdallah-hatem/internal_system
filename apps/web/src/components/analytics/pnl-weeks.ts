/**
 * A day-by-day profit and loss folded into Saturday–Friday weeks, for a phone
 * (owner 2026-10-19, mockup "Option 1"): 19–31 day columns do not fit in
 * ~340px, so a period the API draws by day is shown on a phone by week, and a
 * tapped week opens its days.
 *
 * The weeks are the API's own convention (`apps/api/src/common/period-buckets.ts`:
 * Saturday to Friday, Friday the last day, the first and last week cut to the
 * period) — the unit test pins the two together, so there is one week, not two
 * (CLAUDE.md rule 11). The figures are only the API's day buckets added up:
 * no second server path, and nothing here can disagree with the days.
 *
 * Sums are in whole piastres, so a week of 0.10 + 0.20 is 0.30, not
 * 0.30000000000000004, and the weeks add up exactly to the days.
 */

export interface DayFigures {
  key: string;
  from: string;
  to: string;
  salesEgp: number;
  grossProfitEgp: number;
  expensesEgp: number;
  netProfitEgp: number;
}

export interface PnlWeek<D extends DayFigures = DayFigures> extends DayFigures {
  /** The week's own days, oldest first — what a tap opens. */
  days: D[];
}

/** The day a week starts on, as `getUTCDay` numbers it: Saturday (API `WEEK_STARTS_ON`). */
export const WEEK_STARTS_ON = 6;

const DAY_MS = 86_400_000;

/** The Saturday that starts the week a Cairo day (YYYY-MM-DD) is in. UTC arithmetic only. */
export function weekStartOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const back = (new Date(t).getUTCDay() - WEEK_STARTS_ON + 7) % 7;
  return new Date(t - back * DAY_MS).toISOString().slice(0, 10);
}

const FIGURES = ['salesEgp', 'grossProfitEgp', 'expensesEgp', 'netProfitEgp'] as const;
const piastres = (v: number) => Math.round(v * 100);

/**
 * Day buckets, oldest first, into weeks keyed by their Saturday. A week's
 * `from` and `to` are its first and last day present — the period's edges cut
 * it exactly as the API's week buckets are cut, because the API sends every
 * day of the period, quiet days included.
 */
export function weeksOfDays<D extends DayFigures>(days: readonly D[]): PnlWeek<D>[] {
  const weeks: { key: string; days: D[] }[] = [];
  for (const d of days) {
    const key = weekStartOf(d.from);
    const last = weeks[weeks.length - 1];
    if (last && last.key === key) last.days.push(d);
    else weeks.push({ key, days: [d] });
  }
  return weeks.map(({ key, days: own }) => {
    const sum = Object.fromEntries(
      FIGURES.map((f) => [f, own.reduce((s, d) => s + piastres(d[f]), 0) / 100]),
    ) as Record<(typeof FIGURES)[number], number>;
    return { key, from: own[0].from, to: own[own.length - 1].to, ...sum, days: own };
  });
}
