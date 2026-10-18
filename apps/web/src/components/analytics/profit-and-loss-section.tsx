'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { businessToday, useDateFormat } from '@/lib/dates';
import { useCodeLabel } from '@/lib/labels';
import { intlFor, useNumberFormat } from '@/lib/numbers';
import { cn } from '@/lib/utils';
import { Money } from '@/components/ui/money';
import { FilterPills } from '@/components/ui/list-toolbar';
import { DateRangeFilter, type DayRange } from '@/components/ui/date-range-filter';
import { SkeletonRegion, SkeletonText, Skeleton, repeat } from '@/components/ui/skeleton';

/**
 * Profit and loss at the top of Analytics (owner 2026-10-18: "a proper place
 * to see total net profit, with time, and with expenses and sales as summary,
 * not details"; BUSINESS_LOGIC §9 "Profit and loss").
 *
 * Every figure is the API's (`GET /analytics/profit-and-loss`), which is the
 * dashboard's own computation cut to the period — nothing is added up here, so
 * the screen cannot disagree with the dashboard (CLAUDE.md rule 11). The
 * period lives in the address (`?period=`, `?from=&to=`), so a refresh or
 * Back keeps it.
 */

export interface ProfitAndLoss {
  from: string | null;
  to: string;
  allTime: boolean;
  salesEgp: number;
  cogsEgp: number;
  grossProfitEgp: number;
  expensesEgp: number;
  recoveredEgp: number;
  otherIncomeEgp: number;
  exchangeDifferenceEgp: number;
  netProfitEgp: number;
  netProfitPctOfSales: number | null;
  expensesByCategory: { category: string; amountEgp: number }[];
  months: { month: string; netProfitEgp: number }[];
}

export const PERIODS = ['month', 'lastMonth', 'year', 'all', 'custom'] as const;
export type PeriodKey = (typeof PERIODS)[number];

/** "Sep 2026" / "سبتمبر 2026" for a YYYY-MM month, Latin digits in both. */
export function monthName(month: string, locale: string): string {
  const { tag, numberingSystem } = intlFor(locale);
  return new Intl.DateTimeFormat(tag, { numberingSystem, month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
}

/** Goods lost on the way: an expense with no ledger row, named here (API `LOSSES_CATEGORY`). */
const LOSSES_CATEGORY = 'goods_lost';

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

/** The period the address names; anything unknown is the default, all time. */
export function periodOf(value: string | null, hasDays: boolean): PeriodKey {
  if (value && (PERIODS as readonly string[]).includes(value)) return value as PeriodKey;
  return hasDays ? 'custom' : 'all';
}

export function ProfitAndLossSection() {
  const t = useTranslations('analytics');
  const locale = useLocale();
  const codeLabel = useCodeLabel();
  const apiError = useApiError();
  const { formatNumber } = useNumberFormat();
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
    if (next === 'all') q.delete('period');
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
    <section data-testid="pnl" className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
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
        <ProfitAndLossBody
          data={data}
          pct={
            data.netProfitPctOfSales === null
              ? '—'
              : `${formatNumber(data.netProfitPctOfSales, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
          }
          categoryLabel={(c) => (c === LOSSES_CATEGORY ? t('pnl.goodsLost') : codeLabel('ledgerCategory', c))}
          monthLabel={(m) => monthName(m, locale)}
        />
      )}
    </section>
  );
}

const tone = (v: number) => (v < 0 ? 'text-destructive' : 'text-success');

function ProfitAndLossBody({
  data,
  pct,
  categoryLabel,
  monthLabel,
}: {
  data: ProfitAndLoss;
  pct: string;
  categoryLabel: (category: string) => string;
  monthLabel: (month: string) => string;
}) {
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

  const maxExpense = Math.max(...data.expensesByCategory.map((c) => Math.abs(c.amountEgp)), 0);
  const maxMonth = Math.max(...data.months.map((m) => Math.abs(m.netProfitEgp)), 0);
  const anyLoss = data.months.some((m) => m.netProfitEgp < 0);

  return (
    <div className="space-y-6">
      {/* The headline: what the period made, and what share of sales that is. */}
      <div>
        <p className="text-sm text-muted-foreground">{t('pnl.netProfit')}</p>
        <p data-testid="pnl-net" className={cn('text-3xl font-bold tabular-nums sm:text-4xl', tone(data.netProfitEgp))}>
          <Money value={data.netProfitEgp} />
        </p>
        <p data-testid="pnl-pct" className="mt-1 text-sm text-muted-foreground">
          {t.rich('pnl.ofSales', { pct, n: (chunks) => <bdi dir="ltr">{chunks}</bdi> })}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* The summary: totals only, the arithmetic readable top to bottom. */}
        <div>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('pnl.summary')}</h3>
          <dl data-testid="pnl-summary" className="text-sm">
            {lines
              .filter((l) => !(l.hideZero && l.value === 0))
              .map((l) => (
                <div
                  key={l.key}
                  data-line={l.key}
                  className={cn(
                    'flex items-baseline justify-between gap-3 py-1.5',
                    l.strong ? 'border-t border-border font-semibold' : '',
                  )}
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
        </div>

        {/* Expenses by category: one total each, largest first. */}
        <div>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('pnl.expensesByCategory')}</h3>
          {data.expensesByCategory.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('pnl.noExpenses')}</p>
          ) : (
            <ul data-testid="pnl-categories" className="space-y-2 text-sm">
              {data.expensesByCategory.map((c) => (
                <li key={c.category} data-category={c.category}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-foreground" title={categoryLabel(c.category)}>
                      <bdi>{categoryLabel(c.category)}</bdi>
                    </span>
                    <Money value={c.amountEgp} className="whitespace-nowrap tabular-nums text-foreground" />
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-muted">
                    <div
                      className={cn('h-full rounded-full', c.amountEgp < 0 ? 'bg-success/60' : 'bg-primary/70')}
                      style={{ width: `${maxExpense > 0 ? (Math.abs(c.amountEgp) / maxExpense) * 100 : 0}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Net profit by month: a bar each, a loss drawn to the other side of the line. */}
        <div>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('pnl.netProfitByMonth')}</h3>
          {data.months.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('pnl.noMonths')}</p>
          ) : (
            <ul data-testid="pnl-months" className="space-y-1.5 text-sm">
              {data.months.map((m) => {
                const width = `${maxMonth > 0 ? (Math.abs(m.netProfitEgp) / maxMonth) * 100 : 0}%`;
                const negative = m.netProfitEgp < 0;
                return (
                  <li key={m.month} data-month={m.month} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2">
                    <span className="truncate text-xs text-muted-foreground">{monthLabel(m.month)}</span>
                    <div className="flex h-4">
                      {anyLoss && (
                        <div className="flex flex-1 justify-end border-e border-border">
                          {negative && <div data-bar="loss" className="h-full rounded-s bg-destructive/70" style={{ width }} />}
                        </div>
                      )}
                      <div className="flex flex-1">
                        {!negative && <div data-bar="profit" className="h-full rounded-e bg-success/70" style={{ width }} />}
                      </div>
                    </div>
                    <Money value={m.netProfitEgp} className={cn('whitespace-nowrap text-xs tabular-nums', tone(m.netProfitEgp))} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** The section's shape while it loads: the headline, the summary lines, two lists. */
export function ProfitAndLossSkeleton() {
  return (
    <SkeletonRegion testId="pnl-skeleton" className="space-y-6">
      <div>
        <SkeletonText size="xs" className="w-20" />
        <Skeleton className="mt-1 h-9 w-48 sm:h-10" />
        <SkeletonText size="xs" className="mt-1 w-24" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div>
          <SkeletonText size="xs" className="mb-2 w-16" />
          {repeat(5, (i) => (
            <div key={i} className="flex justify-between gap-3 py-1.5">
              <SkeletonText className="w-28" />
              <SkeletonText className="w-24" />
            </div>
          ))}
        </div>
        {repeat(2, (i) => (
          <div key={i}>
            <SkeletonText size="xs" className="mb-2 w-32" />
            {repeat(4, (j) => (
              <div key={j} className="py-1">
                <div className="flex justify-between gap-3">
                  <SkeletonText className="w-24" />
                  <SkeletonText className="w-20" />
                </div>
                <Skeleton className="mt-1 h-1.5 w-full rounded-full" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}
