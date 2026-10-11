'use client';
import { NoMatch } from '@/components/ui/no-match';
import { Money } from '../../../components/ui/money';
import { useNumberFormat } from '@/lib/numbers';

import { useTranslations, useLocale } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useDateFormat } from '../../../lib/dates';
import { useCodeLabel } from '../../../lib/labels';
import { EmptyState } from '../../../components/ui/empty-state';
import { ContinueSetupLink } from '../../../components/cycles/continue-setup';
import { useRouter } from 'next/navigation';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import Link from 'next/link';
import { Route, Plus, Search, Loader2 } from 'lucide-react';

import { useCan } from '../../../lib/can';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';
// ─── Types ────────────────────────────────────────────────────────────
interface Cycle {
  id: string;
  code: string;
  originType: string;
  status: string;
  currency: string;
  startedOn: string;
  participants?: any[];
  purchaseOrders?: any[];
  shippingLegs?: any[];
  inventoryBatches?: any[];
}

const STATUS_ORDER = [
  'PLANNING', 'FUNDING', 'PURCHASING', 'IN_TRANSIT', 'ARRIVED_UAE',
  'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION', 'SELLING', 'SETTLEMENT', 'CLOSED',
];

/**
 * One cycle's line from the Analytics page's profitability figure.
 *
 * The list reads the same endpoint the Analytics page does rather than adding
 * up sales itself: profit is defined once, and a second sum here would drift
 * from it on the first change (rule 11). A cycle with nothing received yet is
 * absent from that figure, and shows a dash.
 */
interface CycleProfit {
  cycleCode: string;
  profit: number;
  roiPct: number | null;
}

const STATUS_COLORS: Record<string, string> = {
  PLANNING: 'bg-gray-100 text-gray-600',
  FUNDING: 'bg-blue-100 text-blue-700',
  PURCHASING: 'bg-indigo-100 text-indigo-700',
  IN_TRANSIT: 'bg-yellow-100 text-yellow-700',
  ARRIVED_UAE: 'bg-amber-100 text-amber-700',
  IN_TRANSIT_TO_EGYPT: 'bg-orange-100 text-orange-700',
  ARRIVED_EGYPT: 'bg-teal-100 text-teal-700',
  VERIFICATION: 'bg-cyan-100 text-cyan-700',
  SELLING: 'bg-green-100 text-green-700',
  SETTLEMENT: 'bg-emerald-100 text-emerald-700',
  CLOSED: 'bg-gray-200 text-gray-700',
  CANCELLED: 'bg-red-100 text-red-700',
};

// ─── Main Page ────────────────────────────────────────────────────────
export default function CyclesPage() {
  const t = useTranslations('cycles');
  const tc = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  // The wizard writes the cycle (POST /cycles and the steps after it) — a
  // partner's. An investor is not offered a new cycle (R1b). Changing a
  // cycle's status is on its details page (CycleStatusButton), not here.
  const canCreate = useCan('cycle.create');

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, statusFilter]);

  // ── Queries ───────────────────────────────────────────────────────
  const { items: cycles, capped, isLoading } = useAllRecords(['cycles'], '/cycles');

  const { data: profitability = [] } = useQuery({
    queryKey: ['analytics', 'cycle-profitability'],
    queryFn: () => api.get('/analytics/cycle-profitability').then((r) => r.data.data ?? r.data),
  });
  const profitByCode = useMemo(
    () =>
      new Map<string, CycleProfit>(
        (Array.isArray(profitability) ? (profitability as CycleProfit[]) : []).map((p) => [
          p.cycleCode,
          p,
        ]),
      ),
    [profitability],
  );

  // ── Derived ───────────────────────────────────────────────────────
  const cycleList: Cycle[] = Array.isArray(cycles) ? cycles : [];
  const filtered = cycleList.filter((c) => {
    const matchSearch = !search || c.code?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = !statusFilter || c.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  // Nothing at all says what a cycle is and offers the first one; nothing for
  // this filter or search says only that.
  const emptyList =
    cycleList.length === 0 ? (
      <EmptyState
        icon={Route}
        title={t('emptyTitle')}
        description={t('emptyHint')}
        action={canCreate ? { label: t('create'), href: '/cycles/new' } : undefined}
      />
    ) : (
      <NoMatch filtered={!!statusFilter} onClear={() => { setSearch(''); setStatusFilter(''); }} />
    );
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        {canCreate && (
        <Link
          href={`/${locale}/cycles/new`}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
        </Link>
        )}
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        <button
          onClick={() => setStatusFilter('')}
          className={`whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
            statusFilter === '' ? 'bg-primary-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
          }`}
        >
          {t('all')} ({cycleList.length})
        </button>
        {STATUS_ORDER.map((s) => {
          const count = cycleList.filter((c) => c.status === s).length;
          if (count === 0) return null;
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                statusFilter === s ? 'bg-primary-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
              }`}
            >
              {codeLabel('cycleStatus', s)} ({count})
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          placeholder={t('search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full ps-10 pe-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      </div>

      <ListCapNotice capped={capped} count={cycles.length} />

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin me-2" /> {tc('loading')}
        </div>
      )}

      {/* Desktop Table */}
      {!isLoading && (
        // Short values — the code, a status chip, money, a date — never
        // wrap: they were breaking at 1440 while the counts beside them sat
        // half empty. Only the origin may wrap. At tablet width, if the row
        // still does not fit, the table scrolls inside its own box.
        <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm [&_th]:whitespace-nowrap">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-start px-4 py-3 font-medium text-gray-600">{t('code')}</th>
                <th className="text-start px-4 py-3 font-medium text-gray-600">{t('origin')}</th>
                <th className="text-start px-4 py-3 font-medium text-gray-600">{t('status')}</th>
                <th className="text-start px-4 py-3 font-medium text-gray-600">{t('participants')}</th>
                <th className="text-start px-4 py-3 font-medium text-gray-600">{t('purchases')}</th>
                <th className="text-end px-4 py-3 font-medium text-gray-600">{t('profit')}</th>
                <th className="text-end px-4 py-3 font-medium text-gray-600">{t('roi')}</th>
                <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('date')}</th>
                <th className="text-end px-4 py-3 font-medium text-gray-600">{tc('actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9}>{emptyList}</td>
                </tr>
              ) : (
                paginated.map((cycle) => {
                  const figure = profitByCode.get(cycle.code);
                  return (
                    <tr
                      key={cycle.id}
                      data-testid="cycle-row"
                      // Always the cycle's page. A cycle still being set up
                      // used to open the wizard here, and the only way from the
                      // wizard to the details was to finish it; resuming setup
                      // is the separate "Continue setup" in the last column.
                      onClick={() => router.push(`/${locale}/cycles/${cycle.id}/details`)}
                      className="cursor-pointer transition-colors hover:bg-primary-50"
                    >
                      <td className="px-4 py-3 font-mono text-xs font-medium text-gray-900">
                        <bdi className="whitespace-nowrap">{cycle.code}</bdi>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{cycle.originType === 'CHINA' ? t('china') : t('uaeDirect')}</td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <StatusBadge status={cycle.status} label={codeLabel('cycleStatus', cycle.status)} />
                      </td>
                      <td className="px-4 py-3 text-gray-600">{cycle.participants?.length ?? 0}</td>
                      <td className="px-4 py-3 text-gray-600">{cycle.purchaseOrders?.length ?? 0}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-end" data-testid="cycle-profit">
                        <ProfitFigure figure={figure} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-end" data-testid="cycle-roi">
                        <RoiFigure figure={figure} />
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-500 text-xs">
                        <bdi>{formatDate(cycle.startedOn)}</bdi>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="flex items-center justify-end gap-3">
                          {/* Continue setup comes first and Details last, so
                              Details sits at the column's end in every row
                              whether or not the cycle still has setup to do. */}
                          <ContinueSetupLink cycleId={cycle.id} status={cycle.status} />
                          {/* Details is offered for every cycle, in every
                              status. A closed one is the one you most want to
                              look back at and it used to show the least. */}
                          <button
                            type="button"
                            data-testid="cycle-details"
                            onClick={(e) => {
                              e.stopPropagation();
                              router.push(`/${locale}/cycles/${cycle.id}/details`);
                            }}
                            className="inline-flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-gray-900"
                          >
                            {tc('details')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile Cards */}
      {!isLoading && (
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="rounded-xl border border-border bg-card">{emptyList}</div>
          ) : (
            paginated.map((cycle) => {
                const figure = profitByCode.get(cycle.code);
                return (
              <div
                key={cycle.id}
                data-testid="cycle-card"
                // Always the cycle's page, as the table row does; setup is
                // resumed from the card's own "Continue setup".
                onClick={() => router.push(`/${locale}/cycles/${cycle.id}/details`)}
                className="cursor-pointer rounded-xl border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-sm font-bold text-gray-900">{cycle.code}</span>
                  <StatusBadge status={cycle.status} label={codeLabel('cycleStatus', cycle.status)} />
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  <span>{cycle.originType === 'CHINA' ? t('china') : t('uaeDirect')}</span>
                   <span>{t('participants')}: {cycle.participants?.length ?? 0}</span>
                  <span>{t('purchases')}: {cycle.purchaseOrders?.length ?? 0}</span>
                </div>
                <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                  <span>
                    {t('profit')}: <ProfitFigure figure={figure} />
                  </span>
                  <span>
                    {t('roi')}: <RoiFigure figure={figure} />
                  </span>
                </div>
                <ContinueSetupLink
                  cycleId={cycle.id}
                  status={cycle.status}
                  className="mt-3 flex min-h-11 w-full items-center justify-center gap-1 rounded-lg border border-primary-200 bg-primary-50 px-3 text-sm font-medium text-primary-700 touch-manipulation active:bg-primary-100"
                />
              </div>
              );
            })
          )}
        </div>
      )}

      {/* Pagination */}
      {!isLoading && filtered.length > 0 && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} totalItems={filtered.length} />
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────
/** A status pill. The words come from `useCodeLabel`, so they are translated. */
function StatusBadge({ status, label }: { status: string; label: string }) {
  const color = STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-600';

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}

/** Profit from the analytics figure; a dash for a cycle it does not cover yet. */
function ProfitFigure({ figure }: { figure?: CycleProfit }) {
  if (!figure) return <span className="text-muted-foreground">—</span>;
  return (
    <Money
      value={figure.profit}
      className={signTone(figure.profit)}
    />
  );
}

/** A gain reads green, a loss red, nothing earned yet stays plain. */
const signTone = (n: number) =>
  n > 0 ? 'text-success' : n < 0 ? 'text-destructive' : 'text-foreground';

/** ROI is only meaningful once something has sold; otherwise a dash. */
function RoiFigure({ figure }: { figure?: CycleProfit }) {
  const { formatNumber } = useNumberFormat();
  if (!figure || figure.roiPct == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span dir="ltr" className={signTone(figure.roiPct)}>
      {formatNumber(figure.roiPct, { maximumFractionDigits: 1 })}%
    </span>
  );
}
