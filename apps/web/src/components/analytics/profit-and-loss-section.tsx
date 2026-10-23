'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, TrendingDown, TrendingUp } from '@/components/ui/icons';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { businessToday, useDateFormat } from '@/lib/dates';
import { useCodeLabel } from '@/lib/labels';
import { DEFAULT_CURRENCY, compactParts, intlFor, useNumberFormat } from '@/lib/numbers';
import { cn } from '@/lib/utils';
import { Money } from '@/components/ui/money';
import { Dialog } from '@/components/ui/dialog';
import { useIsPhone } from '@/lib/use-phone';
import { weeksOfDays, type PnlWeek } from './pnl-weeks';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FilterPills } from '@/components/ui/list-toolbar';
import { DateRangeFilter, type DayRange } from '@/components/ui/date-range-filter';
import { SkeletonRegion, SkeletonText, Skeleton, repeat } from '@/components/ui/skeleton';

/**
 * Profit and loss at the top of Analytics (owner 2026-10-18: "a proper place
 * to see total net profit, with time, and with expenses and sales as summary,
 * not details"; redesigned the same day as "Option A", BUSINESS_LOGIC §9
 * "Profit and loss"): the period, four tiles, how they add up, one chart of
 * sales and net profit over the period, and the largest expenses.
 *
 * Every figure is the API's (`GET /analytics/profit-and-loss`), which is the
 * dashboard's own computation cut to the period and to the chart's buckets —
 * nothing is added up here, so the screen cannot disagree with the dashboard
 * (CLAUDE.md rule 11). The period lives in the address (`?period=`,
 * `?from=&to=`), so a refresh or Back keeps it.
 */

export type Granularity = 'day' | 'week' | 'month';

/** One bucket of the chart: a day, a Saturday–Friday week or a month, cut to the period. */
export interface PnlBucket {
  key: string;
  from: string;
  to: string;
  salesEgp: number;
  grossProfitEgp: number;
  expensesEgp: number;
  netProfitEgp: number;
}

export interface ProfitAndLoss {
  from: string | null;
  to: string;
  allTime: boolean;
  salesEgp: number;
  cogsEgp: number;
  grossProfitEgp: number;
  grossProfitPctOfSales: number | null;
  expensesEgp: number;
  recoveredEgp: number;
  otherIncomeEgp: number;
  exchangeDifferenceEgp: number;
  netProfitEgp: number;
  netProfitPctOfSales: number | null;
  /**
   * Money paid out of the ledger in the period, stock bought included — the
   * dashboard's old Cash paid out, moved here 2026-10-23. Not a cost, so not
   * in the arithmetic above it. Absent from an older API.
   */
  cashOutEgp?: number;
  expensesByCategory: { category: string; amountEgp: number }[];
  granularity: Granularity;
  buckets: PnlBucket[];
}

export const PERIODS = ['month', 'lastMonth', 'year', 'all', 'custom'] as const;
export type PeriodKey = (typeof PERIODS)[number];
/** What the section opens on when the address names no period. */
export const DEFAULT_PERIOD: PeriodKey = 'month';

/** How many expense categories show before the rest fold away. */
export const TOP_CATEGORIES = 4;

/** Goods lost on the way: an expense with no ledger row, named here (API `LOSSES_CATEGORY`). */
const LOSSES_CATEGORY = 'goods_lost';
/** Samples the shops kept or lost (§4, samples at shops): named here too (API `SAMPLES_WRITTEN_OFF_CATEGORY`). */
const SAMPLES_WRITTEN_OFF_CATEGORY = 'samples_written_off';

const pad = (n: number) => String(n).padStart(2, '0');
/** Last day of a month; month is 1-12 and may overflow into the next year. */
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

/**
 * The days a period asks for, from Cairo's today. The API caps a `to` after
 * today at today, so "this month" can name the month's last day. All time and
 * an empty custom range ask for nothing: all time.
 */
export function periodParams(key: PeriodKey, today: string, custom: DayRange): { from?: string; to?: string } {
  const [y, m] = today.split('-').map(Number);
  switch (key) {
    case 'month':
      return { from: `${y}-${pad(m)}-01`, to: lastDay(y, m) };
    case 'lastMonth': {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: `${py}-${pad(pm)}-01`, to: lastDay(py, pm) };
    }
    case 'year':
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'custom':
      return {
        ...(custom.from ? { from: custom.from } : {}),
        ...(custom.to ? { to: custom.to } : {}),
      };
    case 'all':
    default:
      return {};
  }
}

/**
 * The period the address names; anything unknown is the default, this month
 * (owner 2026-10-19 — it was all time). Days with no period are a custom range.
 */
export function periodOf(value: string | null, hasDays: boolean): PeriodKey {
  if (value && (PERIODS as readonly string[]).includes(value)) return value as PeriodKey;
  return hasDays ? 'custom' : DEFAULT_PERIOD;
}

/**
 * A Cairo day (YYYY-MM-DD) in words. Read at UTC midnight with the UTC zone,
 * so no reader's clock can move it to the day before.
 */
function dayText(day: string, locale: string, opts: Intl.DateTimeFormatOptions): string {
  const { tag, numberingSystem } = intlFor(locale);
  return new Intl.DateTimeFormat(tag, { numberingSystem, timeZone: 'UTC', ...opts }).format(
    new Date(`${day.length === 7 ? `${day}-01` : day}T00:00:00Z`),
  );
}

/**
 * A bucket's name: short under the axis ("Oct 5", "Oct 4" for the week that
 * starts then, "Sep 2026"), in full in the tooltip ("Mon, Oct 5, 2026",
 * "Oct 4 – Oct 10, 2026", "September 2026").
 */
export function bucketLabel(b: Pick<PnlBucket, 'key' | 'from' | 'to'>, granularity: Granularity, locale: string, form: 'axis' | 'full'): string {
  if (granularity === 'month') {
    return dayText(b.key, locale, form === 'axis' ? { month: 'short', year: 'numeric' } : { month: 'long', year: 'numeric' });
  }
  if (granularity === 'week') {
    if (form === 'axis') return dayText(b.from, locale, { month: 'short', day: 'numeric' });
    return `${dayText(b.from, locale, { month: 'short', day: 'numeric' })} – ${dayText(b.to, locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })}`;
  }
  return form === 'axis'
    ? dayText(b.from, locale, { month: 'short', day: 'numeric' })
    : dayText(b.from, locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * A y-scale with round ticks that always takes in zero, so a column grows
 * from the zero line and a loss sits visibly below it.
 */
export function niceScale(lo: number, hi: number, count = 4): { min: number; max: number; ticks: number[] } {
  const low = Math.min(0, lo);
  const high = Math.max(0, hi);
  if (high === low) return { min: 0, max: 1, ticks: [0] };
  const raw = (high - low) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { min, max, ticks };
}

export function ProfitAndLossSection() {
  const t = useTranslations('analytics');
  const codeLabel = useCodeLabel();
  const apiError = useApiError();
  const { formatDate } = useDateFormat();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const custom: DayRange = { from: searchParams.get('from') ?? '', to: searchParams.get('to') ?? '' };
  const period = periodOf(searchParams.get('period'), Boolean(custom.from || custom.to));
  const today = businessToday();
  const params = periodParams(period, today, custom);

  /** Write the period into the address; the query reads it back from there. */
  const go = (next: PeriodKey, days?: DayRange) => {
    const q = new URLSearchParams(searchParams.toString());
    q.delete('from');
    q.delete('to');
    if (next === DEFAULT_PERIOD) q.delete('period');
    else q.set('period', next);
    if (next === 'custom') {
      // A fresh custom range starts on this month so far, ready to change.
      const range = days ?? { from: `${today.slice(0, 8)}01`, to: today };
      if (range.from) q.set('from', range.from);
      if (range.to) q.set('to', range.to);
    }
    const query = q.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const { data, isLoading, isFetching, error } = useQuery<ProfitAndLoss>({
    queryKey: ['analytics', 'profit-and-loss', params.from ?? '', params.to ?? ''],
    queryFn: () => api.get('/analytics/profit-and-loss', { params }).then((r) => r.data.data ?? r.data),
    // A new period keeps the last figures on screen while it loads, never a blank.
    placeholderData: keepPreviousData,
  });

  const rangeText = data
    ? data.from
      ? `${formatDate(data.from)} – ${data.to === today ? t('pnl.today') : formatDate(data.to)}`
      : data.allTime
        ? t('pnl.nothingYet')
        : ''
    : '';

  return (
    <section data-testid="pnl" className="rounded-xl border border-border bg-card p-4 sm:p-6">
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{t('pnl.title')}</h2>
          <p data-testid="pnl-range" className="mt-0.5 min-h-5 text-sm text-muted-foreground">
            {rangeText}
          </p>
        </div>
        <div className="flex flex-col gap-2 lg:items-end">
          <FilterPills
            testId="pnl-period"
            label={t('pnl.period')}
            value={period}
            onChange={(next) => next !== period && go(next)}
            options={PERIODS.map((p) => ({ value: p, label: t(`pnl.periods.${p}`) }))}
          />
          {period === 'custom' && (
            <DateRangeFilter
              idPrefix="pnl"
              value={custom}
              busy={isFetching && !isLoading}
              onChange={(days) => go('custom', days)}
            />
          )}
        </div>
      </div>

      {error ? (
        <p role="alert" data-testid="pnl-error" className="text-sm text-destructive">
          {apiError(error, t('pnl.loadFailed'))}
        </p>
      ) : isLoading || !data ? (
        <ProfitAndLossSkeleton />
      ) : (
        // A new period holds the last figures, dimmed, until it arrives.
        <div className={cn('transition-opacity', isFetching ? 'opacity-60' : '')} aria-busy={isFetching || undefined}>
          <ProfitAndLossBody
            data={data}
            categoryLabel={(c) =>
              c === LOSSES_CATEGORY
                ? t('pnl.goodsLost')
                : c === SAMPLES_WRITTEN_OFF_CATEGORY
                  ? t('pnl.samplesWrittenOff')
                  : codeLabel('ledgerCategory', c)
            }
          />
        </div>
      )}
    </section>
  );
}

const tone = (v: number) => (v < 0 ? 'text-destructive' : 'text-success');

/** "17.5%" of sales, or "—" when nothing was sold. */
function usePct() {
  const { formatNumber } = useNumberFormat();
  return (v: number | null) =>
    v === null ? '—' : `${formatNumber(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function ProfitAndLossBody({ data, categoryLabel }: { data: ProfitAndLoss; categoryLabel: (category: string) => string }) {
  const t = useTranslations('analytics');
  const pct = usePct();
  const { formatMoney } = useNumberFormat();
  const ofSales = (v: number | null) => t.rich('pnl.ofSales', { pct: pct(v), n: (chunks) => <bdi dir="ltr">{chunks}</bdi> });

  return (
    <div className="space-y-5">
      {/* The headline figures: compact, the exact amount on hover. */}
      <div data-testid="pnl-tiles" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          testId="pnl-tile-sales"
          label={t('pnl.sales')}
          value={data.salesEgp}
          sub={
            <span title={formatMoney(data.cogsEgp)}>
              {t.rich('pnl.cogsShort', { amount: () => <Compact value={data.cogsEgp} /> })}
            </span>
          }
        />
        <Tile
          testId="pnl-tile-gross"
          label={t('pnl.grossProfit')}
          value={data.grossProfitEgp}
          sub={<span data-testid="pnl-gross-pct">{ofSales(data.grossProfitPctOfSales)}</span>}
        />
        <Tile
          testId="pnl-tile-expenses"
          label={t('pnl.expenses')}
          value={data.expensesEgp}
          sub={t('pnl.categoriesCount', { count: data.expensesByCategory.length })}
        />
        <Tile
          testId="pnl-net"
          label={t('pnl.netProfit')}
          value={data.netProfitEgp}
          valueClass={tone(data.netProfitEgp)}
          icon={data.netProfitEgp < 0 ? TrendingDown : TrendingUp}
          sub={<span data-testid="pnl-pct">{ofSales(data.netProfitPctOfSales)}</span>}
        />
      </div>

      <AddsUp data={data} />

      <PnlChart buckets={data.buckets} granularity={data.granularity} />

      <Expenses rows={data.expensesByCategory} categoryLabel={categoryLabel} />
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  valueClass,
  icon: Icon,
  testId,
}: {
  label: string;
  value: number;
  sub?: React.ReactNode;
  valueClass?: string;
  icon?: typeof TrendingUp;
  testId: string;
}) {
  const { formatMoney } = useNumberFormat();
  return (
    <div data-testid={testId} className="min-w-0 rounded-lg border border-border px-3 py-3 sm:px-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground sm:text-sm">
        {label}
        {Icon && <Icon aria-hidden="true" className={cn('size-3.5', valueClass)} />}
      </p>
      {/* The compact figure reads at a glance; the title and the screen reader get it to the piastre. */}
      <p
        data-testid={`${testId}-value`}
        title={formatMoney(value)}
        aria-label={formatMoney(value)}
        className={cn('mt-1 text-xl font-semibold sm:text-2xl', valueClass ?? 'text-foreground')}
      >
        <Compact value={value} />
        <span className="ms-1 text-xs font-normal text-muted-foreground">{DEFAULT_CURRENCY}</span>
      </p>
      <p className="mt-0.5 min-h-4 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

/**
 * A compact figure that reads right in both directions: the digits (and their
 * minus) an LTR run, the size word beside them in the page's own direction —
 * "1.34M", and in Arabic "1.34 مليون" read from the right.
 */
function Compact({ value }: { value: number }) {
  const locale = useLocale();
  const { number, unit } = compactParts(value, locale);
  return (
    <span data-compact="">
      <bdi dir="ltr">{number}</bdi>
      {unit && (locale === 'ar' ? ` ${unit}` : unit)}
    </span>
  );
}

/** The arithmetic behind the tiles, every line that is not zero, folded away until asked for. */
function AddsUp({ data }: { data: ProfitAndLoss }) {
  const t = useTranslations('analytics');
  const lines: { key: string; label: string; value: number; sign: '' | '−' | '+' | '='; strong?: boolean; hideZero?: boolean }[] = [
    { key: 'sales', label: t('pnl.sales'), value: data.salesEgp, sign: '' },
    { key: 'cogs', label: t('pnl.cogs'), value: data.cogsEgp, sign: '−' },
    { key: 'gross', label: t('pnl.grossProfit'), value: data.grossProfitEgp, sign: '=', strong: true },
    { key: 'expenses', label: t('pnl.expenses'), value: data.expensesEgp, sign: '−' },
    { key: 'recovered', label: t('pnl.recovered'), value: data.recoveredEgp, sign: '+', hideZero: true },
    { key: 'otherIncome', label: t('pnl.otherIncome'), value: data.otherIncomeEgp, sign: '+', hideZero: true },
    { key: 'exchange', label: t('pnl.exchangeDifference'), value: data.exchangeDifferenceEgp, sign: '−', hideZero: true },
    { key: 'net', label: t('pnl.netProfit'), value: data.netProfitEgp, sign: '=', strong: true },
  ];
  return (
    <Collapsible data-testid="pnl-adds-up" className="group rounded-lg bg-muted/40 px-3 py-2 sm:px-4">
      <CollapsibleTrigger
        type="button"
        className="flex w-full items-center gap-1.5 rounded-md text-start text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ChevronDown
          aria-hidden="true"
          className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
        />
        {t('pnl.howItAddsUp')}
      </CollapsibleTrigger>
      <CollapsibleContent>
      <dl data-testid="pnl-summary" className="mt-2 max-w-md text-sm">
        {lines
          .filter((l) => !(l.hideZero && l.value === 0))
          .map((l) => (
            <div
              key={l.key}
              data-line={l.key}
              className={cn('flex items-baseline justify-between gap-3 py-1', l.strong ? 'border-t border-border font-semibold' : '')}
            >
              <dt className="flex min-w-0 items-baseline gap-2 text-foreground">
                <span aria-hidden="true" className="w-3 shrink-0 text-center text-muted-foreground">
                  {l.sign}
                </span>
                <span className="min-w-0">{l.label}</span>
              </dt>
              <dd className={cn('whitespace-nowrap tabular-nums', l.strong ? tone(l.value) : 'text-foreground')}>
                <Money value={l.value} />
              </dd>
            </div>
          ))}
      </dl>
      {/* Cash is not profit: shown under the account, apart from it, with no sign
          (owner 2026-10-23 — it left the dashboard for here). */}
      {data.cashOutEgp !== undefined && (
        <div data-testid="pnl-cash-out" className="mt-2 max-w-md border-t border-dashed border-border pt-2 text-sm">
          <div className="flex items-baseline justify-between gap-3 py-1">
            <span className="flex min-w-0 items-baseline gap-2 text-foreground">
              <span aria-hidden="true" className="w-3 shrink-0" />
              <span className="min-w-0">{t('pnl.cashOut')}</span>
            </span>
            <span className="whitespace-nowrap tabular-nums text-foreground">
              <Money value={data.cashOutEgp} />
            </span>
          </div>
          <p className="ps-5 text-xs text-muted-foreground">{t('pnl.cashOutHint')}</p>
        </div>
      )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Up to this many buckets carry a dot on the line; past it only the losses and the one hovered. */
const ALL_DOTS_UP_TO = 40;

/**
 * Sales as columns and net profit as a line, on one axis of pounds and one of
 * time. A loss bucket's point is red (and says "loss" in its tooltip, so
 * colour is not the only sign). Hover, tap or focus a bucket for its exact
 * figures. Time runs in the reading direction — oldest at the right in
 * Arabic — as the Revenue by month chart it replaces did.
 *
 * On a phone a period the API draws by day is drawn by week instead (owner
 * 2026-10-19, "Option 1"): 19–31 day columns do not fit in 340px. The weeks
 * are the days added up here (`pnl-weeks.ts`), Saturday to Friday as the
 * API's weeks are, and tapping one opens its days. The desktop keeps its days;
 * periods already by week or month are the same everywhere.
 */
export function PnlChart({ buckets: given, granularity: givenGranularity }: { buckets: PnlBucket[]; granularity: Granularity }) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const rtl = locale === 'ar';
  const { formatMoney } = useNumberFormat();
  const [active, setActive] = useState<number | null>(null);
  const [openWeek, setOpenWeek] = useState<string | null>(null);
  const today = businessToday();

  // Days folded into weeks on a phone; a rotation re-renders, never refetches.
  const byWeek = useIsPhone() && givenGranularity === 'day';
  // Turned to the wide layout, an open week closes for good: back on a phone
  // it must not spring open again by itself.
  const [wasByWeek, setWasByWeek] = useState(byWeek);
  if (wasByWeek !== byWeek) {
    setWasByWeek(byWeek);
    if (!byWeek) setOpenWeek(null);
  }
  const weeks: PnlWeek<PnlBucket>[] = byWeek ? weeksOfDays(given) : [];
  const buckets: PnlBucket[] = byWeek ? weeks : given;
  const granularity: Granularity = byWeek ? 'week' : givenGranularity;
  const opened = byWeek && openWeek ? weeks.find((w) => w.key === openWeek) : undefined;

  const n = buckets.length;
  const values = buckets.flatMap((b) => [b.salesEgp, b.netProfitEgp]);
  const scale = niceScale(Math.min(0, ...values), Math.max(0, ...values));
  /** Height from the bottom of the plot, in percent. */
  const y = (v: number) => ((v - scale.min) / (scale.max - scale.min)) * 100;
  const zero = y(0);
  /** A bucket's centre from the physical left, in percent: mirrored in Arabic. */
  const x = (i: number) => (((rtl ? n - 1 - i : i) + 0.5) / n) * 100;
  // Few enough labels to never touch: about five on a phone, twelve from sm up.
  // Folded weeks are at most six, each wide enough for its own label.
  const stepPhone = byWeek ? 1 : Math.max(1, Math.ceil(n / 5));
  const stepWide = Math.max(1, Math.ceil(n / 12));

  const granularityText = byWeek ? t('pnl.byWeekShort') : t(`pnl.by.${granularity}`);
  /** Under the axis: the week's first day, and the week still running is "today". */
  const axisLabel = (b: PnlBucket, i: number) =>
    byWeek && i === n - 1 && b.to === today ? t('pnl.today') : bucketLabel(b, granularity, locale, 'axis');

  return (
    <div data-testid="pnl-chart" data-granularity={granularity} data-buckets={n} data-folded={byWeek ? 'week' : undefined}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold text-foreground">
          {t('pnl.chartTitle')} <span className="font-normal text-muted-foreground">· {granularityText}</span>
        </h3>
        <ul data-testid="pnl-legend" className="flex items-center gap-4 text-xs text-muted-foreground">
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-3 w-2.5 rounded-t-[3px] bg-primary-300" />
            {t('pnl.sales')}
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-primary-700" />
            {t('pnl.netProfit')}
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2 rounded-full bg-destructive" />
            {t('pnl.loss')}
          </li>
        </ul>
      </div>

      {n === 0 ? (
        <p className="flex h-40 items-center justify-center rounded-lg bg-muted/40 text-sm text-muted-foreground">{t('pnl.noMonths')}</p>
      ) : (
        // Arabic ticks carry a word ("400 ألف"), so their gutter is wider.
        <div className={cn('relative', rtl ? 'ps-16' : 'ps-11')}>
          {/* The pounds axis: round ticks, compact, on the side reading starts from. */}
          <div className="relative h-48 sm:h-60" onPointerLeave={() => setActive(null)}>
            {scale.ticks.map((v) => (
              <div key={v} aria-hidden="true" className="pointer-events-none absolute inset-x-0" style={{ bottom: `${y(v)}%` }}>
                <div className={cn('border-t', v === 0 ? 'border-muted-foreground/40' : 'border-border')} />
                <span
                  className={cn(
                    'absolute translate-y-1/2 whitespace-nowrap text-end text-[11px] tabular-nums text-muted-foreground',
                    rtl ? '-start-16 w-14' : '-start-11 w-9',
                  )}
                  style={{ bottom: 0 }}
                >
                  <Compact value={v} />
                </span>
              </div>
            ))}

            {/* Columns: a slot per bucket, the bar at most 24px, grown from zero. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex">
              {buckets.map((b, i) => {
                const h = Math.abs(y(b.salesEgp) - zero);
                return (
                  <div key={b.key} className={cn('relative flex-1', active === i ? 'bg-muted/60' : '')}>
                    {b.salesEgp !== 0 && (
                      <div
                        data-bar={b.key}
                        className={cn(
                          'absolute inset-x-0 mx-auto w-[70%] max-w-6',
                          b.salesEgp > 0 ? 'rounded-t-[4px]' : 'rounded-b-[4px]',
                          active === i ? 'bg-primary-400' : 'bg-primary-300',
                        )}
                        style={{ bottom: `${Math.min(zero, y(b.salesEgp))}%`, height: `${Math.max(h, 0.5)}%` }}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Net profit: a 2px line through the buckets' centres. */}
            <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polyline
                data-testid="pnl-line"
                points={buckets.map((b, i) => `${x(i)},${100 - y(b.netProfitEgp)}`).join(' ')}
                fill="none"
                className="stroke-primary-700"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            {buckets.map((b, i) =>
              n <= ALL_DOTS_UP_TO || b.netProfitEgp < 0 || active === i ? (
                <span
                  key={b.key}
                  aria-hidden="true"
                  data-point={b.key}
                  data-loss={b.netProfitEgp < 0 || undefined}
                  className={cn(
                    'pointer-events-none absolute size-2 -translate-x-1/2 translate-y-1/2 rounded-full ring-2 ring-card',
                    b.netProfitEgp < 0 ? 'bg-destructive' : 'bg-primary-700',
                    active === i ? 'size-2.5' : '',
                  )}
                  style={{ left: `${x(i)}%`, bottom: `${y(b.netProfitEgp)}%` }}
                />
              ) : null,
            )}

            {/* The hit targets: the whole height of each slot, by pointer, tap or keyboard. */}
            <div className="absolute inset-0 flex">
              {buckets.map((b, i) => (
                <button
                  key={b.key}
                  type="button"
                  data-bucket={b.key}
                  aria-label={`${bucketLabel(b, granularity, locale, 'full')}: ${t('pnl.sales')} ${formatMoney(b.salesEgp)}, ${t('pnl.netProfit')} ${formatMoney(b.netProfitEgp)}`}
                  aria-haspopup={byWeek ? 'dialog' : undefined}
                  className="h-full flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                  onClick={byWeek ? () => setOpenWeek(b.key) : undefined}
                  onPointerEnter={() => setActive(i)}
                  onPointerDown={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((a) => (a === i ? null : a))}
                />
              ))}
            </div>

            {/* A folded week answers a tap with its days, so it needs no tooltip over them. */}
            {!byWeek && active !== null && buckets[active] && (
              <ChartTooltip bucket={buckets[active]} granularity={granularity} at={x(active)} slots={n} />
            )}
          </div>

          {/* The time axis: a few labels, centred under their slots. */}
          <div aria-hidden="true" className="mt-1.5 flex h-4">
            {buckets.map((b, i) => (
              <div key={b.key} className="relative flex-1">
                <span
                  data-axis-label=""
                  className={cn(
                    'absolute start-1/2 top-0 whitespace-nowrap text-[11px] text-muted-foreground ltr:-translate-x-1/2 rtl:translate-x-1/2',
                    i % stepPhone === 0 ? 'block' : 'hidden',
                    i % stepWide === 0 ? 'sm:block' : 'sm:hidden',
                  )}
                >
                  {axisLabel(b, i)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {opened && <WeekDays week={opened} onClose={() => setOpenWeek(null)} />}
    </div>
  );
}

/**
 * A folded week's own days, opened by tapping its column on a phone: each
 * day's sales and net profit (a loss in red, its minus kept in an LTR run),
 * the week's total under them. Amounts are exact; the currency is said once.
 */
function WeekDays({ week, onClose }: { week: PnlWeek<PnlBucket>; onClose: () => void }) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const { formatAmount } = useNumberFormat();
  const today = businessToday();
  const amount = (v: number, testId: string, net: boolean) => (
    <span
      data-testid={testId}
      // A quiet day reads as quiet: zero is neither a profit nor a loss.
      className={cn('whitespace-nowrap text-end tabular-nums', v === 0 ? 'text-muted-foreground' : net ? tone(v) : 'text-foreground')}
    >
      {/* The digits and their minus are one LTR run; the cell aligns to the page's own end. */}
      <bdi dir="ltr">{formatAmount(v)}</bdi>
    </span>
  );
  // One grid for the header, the days and the total, so every figure lines up
  // under its column whatever its width; each row is a subgrid of it.
  const row = 'col-span-3 grid grid-cols-subgrid items-baseline py-2';
  return (
    <Dialog
      size="sm"
      title={bucketLabel(week, 'week', locale, 'full')}
      description={t('pnl.weekDaysNote')}
      onClose={onClose}
      cardProps={{ 'data-testid': 'pnl-week', 'data-week': week.key }}
      bodyClassName="py-3"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 text-sm">
        <div className={cn(row, 'border-b border-border pt-0 text-xs font-medium text-muted-foreground')}>
          <span>{t('pnl.day')}</span>
          <span className="text-end">{t('pnl.sales')}</span>
          <span className="text-end">{t('pnl.netProfit')}</span>
        </div>
        <ul data-testid="pnl-week-days" className="col-span-3 grid grid-cols-subgrid">
          {week.days.map((d) => (
            <li key={d.key} data-day={d.key} data-loss={d.netProfitEgp < 0 || undefined} className={cn(row, 'border-b border-border/60')}>
              <span className="min-w-0 truncate text-foreground">
                {d.from === today ? t('pnl.today') : dayText(d.from, locale, { weekday: 'short', month: 'short', day: 'numeric' })}
              </span>
              {amount(d.salesEgp, 'pnl-day-sales', false)}
              {amount(d.netProfitEgp, 'pnl-day-net', true)}
            </li>
          ))}
        </ul>
        <div data-testid="pnl-week-total" className={cn(row, 'font-semibold')}>
          <span className="text-foreground">{t('pnl.weekTotal')}</span>
          {amount(week.salesEgp, 'pnl-week-sales', false)}
          {amount(week.netProfitEgp, 'pnl-week-net', true)}
        </div>
      </div>
    </Dialog>
  );
}

/** One bucket's exact figures, beside the pointer and never past the plot's edges. */
/** Less of the plot than this beside a bucket, and the tooltip would not fit there. */
const TOOLTIP_ROOM_PCT = 25;

/**
 * Where the tooltip sits: beside the bucket on the side with more room, so it
 * covers neither the hovered column nor the legend. When that side has too
 * little plot left — one bucket fills the whole width, so "beside" is past the
 * card's edge and the page scrolled sideways (owner 2026-10-19, All time with a
 * single day) — it is held to that side's edge of the plot instead.
 */
export function tooltipPlace(at: number, slots: number): { left?: string; right?: string } {
  const half = 50 / Math.max(1, slots);
  if (at <= 50) {
    const from = at + half;
    return 100 - from >= TOOLTIP_ROOM_PCT ? { left: `calc(${from}% + 4px)` } : { right: '0px' };
  }
  const from = 100 - at + half;
  return 100 - from >= TOOLTIP_ROOM_PCT ? { right: `calc(${from}% + 4px)` } : { left: '0px' };
}

function ChartTooltip({
  bucket,
  granularity,
  at,
  slots,
}: {
  bucket: PnlBucket;
  granularity: Granularity;
  /** The bucket's centre from the physical left, in percent. */
  at: number;
  slots: number;
}) {
  const t = useTranslations('analytics');
  const locale = useLocale();
  // Centred over the bucket, or held to the edge it is near.
  // Inside the plot, at its top, beside the bucket on the side with more room,
  // so it covers neither the hovered column nor the legend above.
  const place = tooltipPlace(at, slots);
  const loss = bucket.netProfitEgp < 0;
  return (
    <div
      role="status"
      data-testid="pnl-tooltip"
      className="pointer-events-none absolute top-0 z-10 w-max min-w-44 max-w-full rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md"
      style={place}
    >
      <p className="mb-1.5 font-medium text-foreground">{bucketLabel(bucket, granularity, locale, 'full')}</p>
      <dl className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <dt className="flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden="true" className="h-2.5 w-2 rounded-t-[2px] bg-primary-300" />
            {t('pnl.sales')}
          </dt>
          <dd data-testid="pnl-tooltip-sales" className="font-semibold tabular-nums text-foreground">
            <Money value={bucket.salesEgp} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="flex items-center gap-1.5 ps-3.5 text-muted-foreground">{t('pnl.grossProfit')}</dt>
          <dd data-testid="pnl-tooltip-gross" className="tabular-nums text-foreground">
            <Money value={bucket.grossProfitEgp} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden="true" className={cn('h-0.5 w-2.5 rounded-full', loss ? 'bg-destructive' : 'bg-primary-700')} />
            {loss ? `${t('pnl.netProfit')} · ${t('pnl.loss')}` : t('pnl.netProfit')}
          </dt>
          <dd data-testid="pnl-tooltip-net" className={cn('font-semibold tabular-nums', tone(bucket.netProfitEgp))}>
            <Money value={bucket.netProfitEgp} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** The largest expenses, the rest folded into one line that opens them in place. */
function Expenses({
  rows,
  categoryLabel,
}: {
  rows: ProfitAndLoss['expensesByCategory'];
  categoryLabel: (category: string) => string;
}) {
  const t = useTranslations('analytics');
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, TOP_CATEGORIES);
  const rest = rows.slice(TOP_CATEGORIES);
  // The folded categories' total, to the piastre: the API's amounts, in cents.
  const restTotal = rest.reduce((s, c) => s + Math.round(c.amountEgp * 100), 0) / 100;
  const max = Math.max(...rows.map((c) => Math.abs(c.amountEgp)), 0);

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-foreground">{t('pnl.expensesByCategory')}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pnl.noExpenses')}</p>
      ) : (
        <>
          <ul data-testid="pnl-categories" className="grid gap-x-8 gap-y-2.5 text-sm md:grid-cols-2">
            {shown.map((c) => (
              <li key={c.category} data-category={c.category}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-foreground" title={categoryLabel(c.category)}>
                    <bdi>{categoryLabel(c.category)}</bdi>
                  </span>
                  <Money value={c.amountEgp} className="whitespace-nowrap tabular-nums text-foreground" />
                </div>
                <div className="mt-1 h-1 rounded-full bg-muted">
                  <div
                    className={cn('h-full rounded-full', c.amountEgp < 0 ? 'bg-success/60' : 'bg-primary-300')}
                    style={{ width: `${max > 0 ? (Math.abs(c.amountEgp) / max) * 100 : 0}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
          {rest.length > 0 && (
            <button
              type="button"
              data-testid="pnl-more"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {open ? (
                t('pnl.showFewer')
              ) : (
                <>
                  {t('pnl.moreCategories', { count: rest.length })}
                  <span aria-hidden="true">·</span>
                  <Money value={restTotal} />
                </>
              )}
              <ChevronDown aria-hidden="true" className={cn('size-4 transition-transform', open ? 'rotate-180' : '')} />
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The section's shape while it loads: four tiles, the fold, the chart, the expense rows. */
export function ProfitAndLossSkeleton() {
  return (
    <SkeletonRegion testId="pnl-skeleton" className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {repeat(4, (i) => (
          <div key={i} className="rounded-lg border border-border px-3 py-3 sm:px-4">
            <SkeletonText size="xs" className="w-16" />
            <Skeleton className="mt-1 h-7 w-24 sm:h-8" />
            <SkeletonText size="xs" className="mt-0.5 w-20" />
          </div>
        ))}
      </div>
      <Skeleton className="h-9 w-full rounded-lg" />
      <div>
        <SkeletonText className="mb-3 w-40" />
        <div className="flex h-48 items-end gap-1 ps-11 sm:h-60">
          {repeat(18, (i) => (
            <div key={i} className="flex h-full flex-1 items-end justify-center">
              <Skeleton className="w-[70%] max-w-6 rounded-b-none" style={{ height: `${25 + ((i * 37) % 60)}%` }} />
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-x-8 gap-y-2.5 md:grid-cols-2">
        {repeat(4, (i) => (
          <div key={i}>
            <div className="flex justify-between gap-3">
              <SkeletonText className="w-24" />
              <SkeletonText className="w-20" />
            </div>
            <Skeleton className="mt-1 h-1 w-full rounded-full" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}
