'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';
import { AlertTriangle, CalendarClock } from '@/components/ui/icons';

/**
 * "Timeline" / «المسار الزمني» (BUSINESS_LOGIC §1, owner 2026-11-10): when each
 * step of the cycle happened and how many days each took — ordered, each leg's
 * departures and deliveries, received into stock, selling, settlement, closed —
 * and order to selling in one figure.
 *
 * Every day and every length is the server's (`GET /cycles/:id/timeline`, api
 * `common/cycle-timeline.ts`); this card only says them. A step not reached has
 * no date, and nothing here works one out.
 */

export type TimelineMeasure =
  | 'AFTER_ORDER'
  | 'WAITED'
  | 'ON_THE_WAY'
  | 'AFTER_FIRST'
  | 'AFTER_ARRIVAL'
  | 'AFTER_RECEIVED'
  | 'SELLING_FOR'
  | 'LATER';

export interface TimelineStepView {
  key: string;
  kind: 'ORDERED' | 'DEPARTED' | 'DELIVERED' | 'RECEIVED' | 'SELLING' | 'SETTLEMENT' | 'CLOSED' | 'CANCELLED';
  state: 'DONE' | 'UPCOMING' | 'NOT_RECORDED';
  day: string | null;
  leg: { sequence: number; origin: string; destination: string } | null;
  part: number | null;
  parts: number | null;
  rest: boolean;
  completesLeg: boolean;
  receipt: 'ONLY' | 'FIRST' | 'LAST' | null;
  since: { days: number; measure: TimelineMeasure; from: string } | null;
  soFar: { days: number; measure: TimelineMeasure; from: string } | null;
  flag: 'BEFORE_PREVIOUS' | null;
  recorded: boolean;
}

export interface TimelineView {
  cycleId: string;
  code: string;
  steps: TimelineStepView[];
  summary: { from: string; to: string; days: number; until: 'SELLING' | 'CANCELLED' | 'TODAY' } | null;
  today: string;
}

/** A calendar day at midday UTC, so the reader's own timezone cannot move it to the day before. */
const atNoon = (day: string) => `${day}T12:00:00Z`;

export function useTimeline(cycleId: string) {
  return useQuery<TimelineView>({
    // Under the cycle's own key, so whatever refreshes the cycle — a departure,
    // a delivery, a receipt, a status change — refreshes its timeline too.
    queryKey: ['cycle', cycleId, 'timeline'],
    queryFn: () => api.get(`/cycles/${cycleId}/timeline`).then((r) => r.data.data ?? r.data),
  });
}

export function TimelineCard({ cycleId }: { cycleId: string }) {
  const t = useTranslations('cycleTimeline');
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const query = useTimeline(cycleId);

  if (query.isLoading) return <TimelineCardSkeleton />;
  const data = query.data;
  if (query.isError || !data || !Array.isArray(data.steps)) {
    return (
      <section data-testid="timeline-error" className="rounded-xl border border-border bg-card p-5">
        <CardTitle />
        <EmptyState
          size="compact"
          icon={AlertTriangle}
          title={t('loadFailed')}
          action={{ label: t('retry'), onClick: () => void query.refetch() }}
          className="text-destructive"
        />
      </section>
    );
  }

  /** A count of days in words, its figure in the app's digits. */
  const days = (key: string, count: number) => t(key, { count, n: formatNumber(count) });
  const summary = data.summary;

  return (
    <section data-testid="timeline-card" className="rounded-xl border border-border bg-card p-5">
      <CardTitle />

      {summary ? (
        <div data-testid="timeline-summary" className="mt-3">
          <p className="text-xs text-muted-foreground">
            {summary.until === 'SELLING'
              ? t('summarySelling')
              : summary.until === 'CANCELLED'
                ? t('summaryCancelled')
                : t('summaryToday')}
          </p>
          <p className="text-lg font-bold tabular-nums text-foreground">
            <span data-testid="timeline-total">{days('days', summary.days)}</span>
            {summary.until === 'TODAY' && (
              <span className="text-sm font-normal text-muted-foreground"> {t('soFarWord')}</span>
            )}
          </p>
          <p className="text-xs tabular-nums text-muted-foreground">
            <bdi>{formatDate(atNoon(summary.from))}</bdi>{' '}
            <span aria-hidden="true" className="inline-block rtl:rotate-180">→</span>
            <span className="sr-only">–</span>{' '}
            <bdi>{summary.until === 'TODAY' ? t('today') : formatDate(atNoon(summary.to))}</bdi>
          </p>
        </div>
      ) : (
        <p data-testid="timeline-no-order" className="mt-3 text-sm text-muted-foreground">
          {t('noOrder')}
        </p>
      )}

      <ol data-testid="timeline-steps" className="mt-4">
        {data.steps.map((s, i) => (
          <Step key={s.key} step={s} last={i === data.steps.length - 1} days={days} formatDay={(d) => formatDate(atNoon(d))} />
        ))}
      </ol>
    </section>
  );
}

function Step({
  step: s,
  last,
  days,
  formatDay,
}: {
  step: TimelineStepView;
  last: boolean;
  days: (key: string, count: number) => string;
  formatDay: (day: string) => string;
}) {
  const t = useTranslations('cycleTimeline');
  const done = s.state === 'DONE';
  const label = useStepLabel(s);

  const length = s.since ? days(sinceKey(s), s.since.days) : null;
  const soFar = s.soFar ? t('soFar', { days: days('days', s.soFar.days) }) : null;

  return (
    <li
      data-testid="timeline-step"
      data-step={s.key}
      data-state={s.state}
      className="relative flex gap-3 pb-4 last:pb-0"
    >
      {/* The line down to the next step, behind the dots. */}
      {!last && <span aria-hidden="true" className="absolute start-[5px] top-3.5 -bottom-0.5 w-px bg-border" />}
      <span
        aria-hidden="true"
        className={cn(
          'relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full',
          done ? 'bg-primary-600' : s.state === 'NOT_RECORDED' ? 'border border-dashed border-muted-foreground bg-card' : 'border-2 border-muted-foreground/40 bg-card',
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:justify-between sm:gap-x-3">
        <div className="min-w-0">
          {/* The pill is a flex item: on a phone it drops under the label at the label's own edge. */}
          <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm', done ? 'font-medium text-foreground' : 'text-muted-foreground')}>
            <span className="min-w-0">{label}</span>
            {s.completesLeg && (
              <span data-testid="timeline-all-arrived" className="whitespace-nowrap rounded bg-success/10 px-1.5 py-0.5 text-[11px] font-normal text-success">
                {t('allArrived')}
              </span>
            )}
          </p>
          {done && (
            <p className="text-xs tabular-nums text-muted-foreground">
              {s.day ? (
                <span data-testid="timeline-date">{formatDay(s.day)}</span>
              ) : (
                <span data-testid="timeline-no-date">{t('noDate')}</span>
              )}
              {s.recorded && s.day && (
                <span data-testid="timeline-recorded" title={t('recordedHint')} className="ms-1.5 whitespace-nowrap text-[11px] italic">
                  · {t('recorded')}
                </span>
              )}
            </p>
          )}
          {s.state === 'NOT_RECORDED' && <p className="text-xs text-muted-foreground">{t('notRecorded')}</p>}
          {s.flag === 'BEFORE_PREVIOUS' && (
            <p data-testid="timeline-flag" className="mt-0.5 flex items-start gap-1 text-xs text-accent-800">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              {t('beforePrevious')}
            </p>
          )}
        </div>
        {(length || soFar) && (
          <span
            data-testid={length ? 'timeline-length' : 'timeline-so-far'}
            className={cn(
              'shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs tabular-nums',
              length ? 'bg-muted text-foreground' : 'border border-border text-muted-foreground',
            )}
          >
            {length ?? soFar}
          </span>
        )}
      </div>
    </li>
  );
}

/** Which phrase a length is said with: the measure, and for "after the first" what the first was. */
function sinceKey(s: TimelineStepView): string {
  const m = s.since!.measure;
  if (m === 'AFTER_FIRST') {
    return s.kind === 'DEPARTED' ? 'afterFirstPart' : s.kind === 'RECEIVED' ? 'afterFirstReceipt' : 'afterFirstDelivery';
  }
  return {
    AFTER_ORDER: 'afterOrder',
    WAITED: 'waited',
    ON_THE_WAY: 'onTheWay',
    AFTER_ARRIVAL: 'afterArrival',
    AFTER_RECEIVED: 'afterReceived',
    SELLING_FOR: 'sellingFor',
    LATER: 'later',
  }[m];
}

function useStepLabel(s: TimelineStepView): ReactNode {
  const t = useTranslations('cycleTimeline');
  const { formatNumber } = useNumberFormat();
  const done = s.state === 'DONE';
  const nth = { n: s.part ?? 1, num: formatNumber(s.part ?? 1) };
  // A place as recorded on the leg — Latin in an Arabic line keeps its own order.
  const place = (name: string) =>
    function Place() {
      return <bdi>{name}</bdi>;
    };
  const numbered = (s.parts ?? 0) > 1 || s.rest;
  switch (s.kind) {
    case 'ORDERED':
      return done ? t('ordered') : t('orderUpcoming');
    case 'DEPARTED': {
      const origin = place(s.leg?.origin ?? '—');
      if (s.rest) return t.rich('departRest', { place: origin });
      if (!done) return t.rich('departUpcoming', { place: origin });
      if (!numbered) return t.rich('departed', { place: origin });
      return t.rich('departedPart', { place: origin, ordinal: t('ordinalPart', nth) });
    }
    case 'DELIVERED': {
      const destination = place(s.leg?.destination ?? '—');
      if (s.rest) return t.rich('arriveRest', { place: destination });
      if (!done) return t.rich('arriveUpcoming', { place: destination });
      if (!numbered) return t.rich('arrived', { place: destination });
      return t.rich('deliveryArrived', { place: destination, ordinal: t('ordinalDelivery', nth) });
    }
    case 'RECEIVED':
      if (!done) return t('receiveUpcoming');
      return s.receipt === 'FIRST' ? t('receivedFirst') : s.receipt === 'LAST' ? t('receivedLast') : t('received');
    case 'SELLING':
      return done ? t('selling') : t('sellingUpcoming');
    case 'SETTLEMENT':
      return done ? t('settlement') : t('settlementUpcoming');
    case 'CLOSED':
      return done ? t('closed') : t('closedUpcoming');
    case 'CANCELLED':
      return t('cancelled');
  }
}

function CardTitle() {
  const t = useTranslations('cycleTimeline');
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
      <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      {t('title')}
    </h2>
  );
}

/** The card while its timeline loads: the title, the summary and six steps. */
export function TimelineCardSkeleton() {
  return (
    <section data-testid="timeline-loading" className="rounded-xl border border-border bg-card p-5">
      <CardTitle />
      <SkeletonRegion testId="timeline-skeleton">
        <div className="mt-3">
          <SkeletonText size="xs" className="w-32" />
          <SkeletonText size="lg" className="w-24" />
          <SkeletonText size="xs" className="w-44" />
        </div>
        <div className="mt-4">
          {repeat(6, (i) => (
            <div key={i} data-testid="skeleton-row" className="flex gap-3 pb-4 last:pb-0">
              <span className="mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full bg-muted" />
              <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:justify-between sm:gap-x-3">
                <div>
                  <SkeletonText className={i % 2 ? 'w-40' : 'w-52 max-w-full'} />
                  <SkeletonText size="xs" className="w-24" />
                </div>
                <SkeletonText size="xs" className="w-24" />
              </div>
            </div>
          ))}
        </div>
      </SkeletonRegion>
    </section>
  );
}
