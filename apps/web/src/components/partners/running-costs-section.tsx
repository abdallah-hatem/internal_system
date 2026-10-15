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
import { Select } from '@/components/ui/select';

/**
 * Running costs on the Partners page (BUSINESS_LOGIC §8, owner 2026-10-11;
 * built L7).
 *
 * Costs with no cycle — rent, salaries, power — are the active core partners',
 * equally, and come out of their payouts. For the period chosen this shows what
 * was spent by category, what payouts have taken, what is still waiting, and
 * each core partner's share. Every figure is the API's
 * (`GET /settlements/running-costs`), worked out by the same arithmetic Mark
 * paid runs; nothing is added up here.
 */

export interface RunningCostsSummary {
  from: string | null;
  to: string | null;
  spentEgp: string;
  chargedEgp: string;
  waitingEgp: string;
  waitingAllTimeEgp: string;
  byCategory: { category: string; spentEgp: string }[];
  partners: {
    userId: string;
    name: string | null;
    shareEgp: string;
    chargedEgp: string;
    waitingEgp: string;
    takesResidual: boolean;
    /** False for a partner who left and still owes his fixed share (§8, review 2026-10-12). */
    active?: boolean;
  }[];
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

  const residual = data?.partners.find((p) => p.takesResidual);
  const nothingSpent = data && Number(data.spentEgp) === 0;

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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {repeat(3, (i) => <FigureSkeleton key={i} />)}
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Figure testId="running-costs-spent" label={t('spent')} value={data.spentEgp} />
            <Figure testId="running-costs-taken" label={t('taken')} value={data.chargedEgp} />
            <Figure testId="running-costs-waiting" label={t('waiting')} value={data.waitingEgp} tone="text-foreground" />
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
              {/* Phone: a card per partner, every amount labelled — four columns of
                  money do not fit 390px (UI review, L7). */}
              <ul data-testid="running-costs-partner-cards" className="divide-y divide-border text-sm sm:hidden">
                {data.partners.map((p) => (
                  <li key={p.userId} className="py-2">
                    <p className="font-medium text-foreground">
                      <bdi>{p.name ?? '—'}</bdi>
                      {p.active === false && <Left label={t('leftPartner')} />}
                    </p>
                    <dl className="mt-1 grid grid-cols-3 gap-2">
                      {[
                        [t('share'), p.shareEgp],
                        [t('taken'), p.chargedEgp],
                        [t('waiting'), p.waitingEgp],
                      ].map(([label, value]) => (
                        <div key={label} className="min-w-0">
                          <dt className="text-[11px] text-muted-foreground">{label}</dt>
                          <dd className="whitespace-nowrap text-xs tabular-nums text-foreground"><Money value={value} /></dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto sm:block">
                <table data-testid="running-costs-partners" className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="py-1.5 text-start font-medium">{t('name')}</th>
                      <th scope="col" className="py-1.5 ps-3 text-end font-medium">{t('share')}</th>
                      <th scope="col" className="py-1.5 ps-3 text-end font-medium">{t('taken')}</th>
                      <th scope="col" className="py-1.5 ps-3 text-end font-medium">{t('waiting')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.partners.map((p) => (
                      <tr key={p.userId}>
                        <td className="py-1.5 text-foreground">
                          <bdi>{p.name ?? '—'}</bdi>
                          {p.active === false && <Left label={t('leftPartner')} />}
                        </td>
                        <td className="whitespace-nowrap py-1.5 ps-3 text-end tabular-nums"><Money value={p.shareEgp} /></td>
                        <td className="whitespace-nowrap py-1.5 ps-3 text-end tabular-nums text-muted-foreground"><Money value={p.chargedEgp} /></td>
                        <td className="whitespace-nowrap py-1.5 ps-3 text-end tabular-nums text-foreground"><Money value={p.waitingEgp} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {residual?.name && (
            <p data-testid="running-costs-residual" className="text-xs text-muted-foreground">
              {t('residualNote', { name: residual.name })}
            </p>
          )}
          <p data-testid="running-costs-all-waiting" className="text-xs text-muted-foreground">
            {/* Isolated left-to-right inside the sentence, as <Money> does (§11). */}
            {t('waitingAllTime', { amount: `\u2066${formatMoney(data.waitingAllTimeEgp)}\u2069` })}
          </p>
        </div>
      )}
    </section>
  );
}

/** A partner who left keeps owing his share; it is still his (§8). */
function Left({ label }: { label: string }) {
  return (
    <span data-testid="running-costs-left" className="ms-2 text-[11px] font-normal text-muted-foreground">
      {label}
    </span>
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
  testId,
}: {
  label: string;
  value: string;
  tone?: string;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${tone}`}>
        <Money value={value} />
      </p>
    </div>
  );
}
