'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { businessToday } from '@/lib/dates';
import { useCodeLabel } from '@/lib/labels';
import { useNumberFormat } from '@/lib/numbers';
import { Money } from '@/components/ui/money';
import { LatinText } from '@/components/ui/latin-text';
import { Link } from '@/i18n/navigation';
import { Select } from '@/components/ui/select';

/**
 * Running costs on the Partners page (BUSINESS_LOGIC §8, owner 2026-10-11;
 * built L7; reworked 2026-11-08).
 *
 * Costs with no cycle — rent, fuel, packaging — are shared equally to the
 * cycles running when each is recorded — goods paid for, not yet settled (or
 * wait for the next cycle whose goods are paid for). On that cycle they are a cost inside its profit, so everyone in it
 * bears them by share, investors too. For the period chosen this shows what
 * was spent by category, what went to which cycle, what still waits for a
 * running cycle and, as history, what partners' payouts took before the
 * change. Every figure is the API's (`GET /settlements/running-costs`);
 * nothing is added up here.
 */

export interface RunningCostsSummary {
  from: string | null;
  to: string | null;
  spentEgp: string;
  /** Shared to cycles: a cost inside their profit. */
  sharedEgp: string;
  /** Taken from partners' payouts before 2026-11-08 — history only. */
  chargedEgp: string;
  /** No cycle running yet: goes to the next one whose goods are paid for. */
  waitingEgp: string;
  waitingAllTimeEgp: string;
  byCategory: { category: string; spentEgp: string }[];
  cycles: { cycleId: string; code: string; status: string; sharedEgp: string }[];
}

export type PeriodKey = 'month' | 'quarter' | 'lastQuarter' | 'year' | 'all';

const pad = (n: number) => String(n).padStart(2, '0');
/** Last day of a month; month is 1-12, and may overflow into the next year. */
const lastDay = (y: number, m: number) =>
  new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

/** The calendar days a period covers, from today's day in Cairo. */
export function periodRange(key: PeriodKey, today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  const q = Math.floor((m - 1) / 3) * 3 + 1; // first month of this quarter
  switch (key) {
    case 'month':
      return { from: `${y}-${pad(m)}-01`, to: lastDay(y, m) };
    case 'lastQuarter': {
      const start = q - 3 < 1 ? { y: y - 1, m: q + 9 } : { y, m: q - 3 };
      return { from: `${start.y}-${pad(start.m)}-01`, to: lastDay(start.y, start.m + 2) };
    }
    case 'year':
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'all':
      // Nothing is recorded before the business ran on this system, and no
      // cost can be dated after today.
      return { from: '2000-01-01', to: today };
    case 'quarter':
    default:
      return { from: `${y}-${pad(q)}-01`, to: lastDay(y, q + 2) };
  }
}

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'month', label: 'periodThisMonth' },
  { key: 'quarter', label: 'periodThisQuarter' },
  { key: 'lastQuarter', label: 'periodLastQuarter' },
  { key: 'year', label: 'periodThisYear' },
  { key: 'all', label: 'periodAll' },
];

export function RunningCostsSection() {
  const t = useTranslations('partners');
  const tph = useTranslations('placeholders');
  const codeLabel = useCodeLabel();
  const { formatMoney } = useNumberFormat();
  const [period, setPeriod] = useState<PeriodKey>('quarter');
  const range = periodRange(period, businessToday());

  const { data, isLoading } = useQuery<RunningCostsSummary>({
    queryKey: ['running-costs', range.from, range.to],
    queryFn: () =>
      api
        .get('/settlements/running-costs', { params: range })
        .then((r) => r.data.data ?? r.data),
  });

  const nothingSpent = data && Number(data.spentEgp) === 0;
  const waiting = data ? Number(data.waitingEgp) : 0;
  const charged = data ? Number(data.chargedEgp) : 0;

  return (
    <section data-testid="running-costs" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">{t('runningCostsTitle')}</h2>
        <div className="flex items-center gap-2">
          <label htmlFor="running-costs-period" className="text-sm text-muted-foreground">
            {t('period')}
          </label>
          <Select
            id="running-costs-period"
            className="w-44"
            value={period}
            placeholder={tph('choosePeriod')}
            onChange={(v) => setPeriod((v || 'quarter') as PeriodKey)}
            options={PERIODS.map((p) => ({ value: p.key, label: t(p.label) }))}
          />
        </div>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{t('runningCostsIntro')}</p>

      {isLoading || !data ? (
        <SkeletonRegion className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {repeat(2, (i) => <FigureSkeleton key={i} />)}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {repeat(2, (i) => (
              <div key={i}>
                <SkeletonText size="xs" className="mb-2 w-24" />
                <div className="divide-y divide-border">
                  {repeat(3, (j) => (
                    <div key={j} className="flex justify-between gap-3 py-1.5">
                      <SkeletonText className="w-28" />
                      <SkeletonText className="w-20" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SkeletonRegion>
      ) : (
        <div className="space-y-4">
          {/* Waiting, and what payouts took before 2026-11-08, only when there
              is any: most periods have neither, and a zero reads as a figure. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
            <Figure testId="running-costs-spent" label={t('spent')} value={data.spentEgp} />
            <Figure testId="running-costs-shared" label={t('sharedToCycles')} value={data.sharedEgp} />
            {waiting > 0 && (
              <Figure
                testId="running-costs-waiting"
                label={t('waitingForCycle')}
                value={data.waitingEgp}
                hint={t('waitingForCycleHint')}
              />
            )}
            {charged > 0 && (
              <Figure
                testId="running-costs-charged"
                label={t('chargedBefore')}
                value={data.chargedEgp}
                tone="text-muted-foreground"
              />
            )}
          </div>

          {nothingSpent ? (
            <p className="text-sm text-muted-foreground">{t('noRunningCosts')}</p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('byCategory')}</h3>
                <dl data-testid="running-costs-categories" className="divide-y divide-border text-sm">
                  {data.byCategory.map((c) => (
                    <div key={c.category} className="flex justify-between gap-3 py-1.5">
                      <dt className="text-foreground">{codeLabel('ledgerCategory', c.category)}</dt>
                      <dd className="whitespace-nowrap tabular-nums text-foreground">
                        <Money value={c.spentEgp} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div>
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('sharedToCycles')}</h3>
                {data.cycles.length === 0 ? (
                  <p data-testid="running-costs-no-cycles" className="py-1.5 text-sm text-muted-foreground">
                    {t('noCyclesShared')}
                  </p>
                ) : (
                  <dl data-testid="running-costs-cycles" className="divide-y divide-border text-sm">
                    {data.cycles.map((c) => (
                      <div key={c.cycleId} className="flex items-baseline justify-between gap-3 py-1.5">
                        <dt className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                          <Link
                            href={`/cycles/${c.cycleId}/details`}
                            className="cursor-pointer font-mono font-medium text-primary underline-offset-2 hover:underline"
                          >
                            <LatinText>{c.code}</LatinText>
                          </Link>
                          <span className="text-xs text-muted-foreground">{codeLabel('cycleStatus', c.status)}</span>
                        </dt>
                        <dd className="whitespace-nowrap tabular-nums text-foreground">
                          <Money value={c.sharedEgp} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </div>
          )}

          {Number(data.waitingAllTimeEgp) > 0 && (
            <p data-testid="running-costs-all-waiting" className="text-xs text-muted-foreground">
              {/* Isolated left-to-right inside the sentence, as <Money> does (§11). */}
              {t('waitingAllTime', { amount: `⁦${formatMoney(data.waitingAllTimeEgp)}⁩` })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** `Figure` before its number arrives: the same bordered box, label line and text-lg figure line. */
function FigureSkeleton() {
  return (
    <div data-testid="skeleton-row" className="rounded-lg border border-border p-3">
      <SkeletonText size="xs" className="w-16" />
      <SkeletonText size="lg" className="w-28" lineClassName="mt-0.5" />
    </div>
  );
}

function Figure({
  label,
  value,
  tone = 'text-foreground',
  hint,
  testId,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${tone}`}>
        <Money value={value} />
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
