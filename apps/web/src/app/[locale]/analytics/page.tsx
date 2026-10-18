'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useTopProductsBy } from '@/components/dashboard/top-products-by';
import { Segmented } from '@/components/ui/segmented';
import { localName } from '@/lib/localized-name';
import { Suspense } from 'react';
import { ProfitAndLossSection, ProfitAndLossSkeleton } from '@/components/analytics/profit-and-loss-section';
import { Money } from '../../../components/ui/money';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import {
  TrendingUp, TrendingDown, Package, Route,
} from 'lucide-react';
import { useCodeLabel } from '@/lib/labels';
import { useNumberFormat } from '@/lib/numbers';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingStatus, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/ui/data-table';
import { ANALYTICS_TOP, mostProfitableCycles, topSoldProducts } from '@/components/analytics/analytics-top';

// ─── Types ────────────────────────────────────────────────────────────
interface TopProduct {
  productId: string;
  name: string;
  sku: string;
  totalQuantitySold: number;
  revenueEgp: number;
  cogsEgp: number;
  profitEgp: number;
  marginPct: number | null;
}

interface CycleProfit {
  cycleCode: string;
  status: string;
  originType: string;
  investment: number;
  totalCost: number;
  totalRevenue: number;
  profit: number;
  roiPct: number | null;
  unitsSold: number;
  unitsRemaining: number;
  unsoldValueEgp: number;
}

// ─── Skeletons ────────────────────────────────────────────────────────
// Traced from the sections below: each section keeps its frame and heading
// while its own figures load, and only the body becomes a placeholder.

/** A top product's name over its SKU, as the real cell. */
function TopProductNameSkeleton() {
  return (
    <>
      <SkeletonText className="w-2/3" />
      <SkeletonText size="xs" className="w-1/3" />
    </>
  );
}

/** One cycle card: code and origin, the profit and ROI at the end, three figures under a rule. */
function CycleProfitCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="rounded-lg bg-muted/50 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <SkeletonText size="base" className="w-24" />
          <SkeletonText size="xs" className="w-32" />
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <SkeletonText className="w-20" />
          <SkeletonText size="xs" className="w-14" />
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-border pt-2">
        {repeat(3, (i) => (
          <div key={i}>
            <SkeletonText size="xs" className="w-14" />
            <SkeletonText size="xs" className="w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function AnalyticsPage() {
  const locale = useLocale();
  const codeLabel = useCodeLabel();
  const t = useTranslations('analytics');
  const td = useTranslations('dashboard');
  const { formatNumber } = useNumberFormat();
  const pct = (v: number) => `${formatNumber(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

  // Units or revenue — the same choice the dashboard's card keeps (owner 2026-10-18).
  const [topBy, setTopBy] = useTopProductsBy();
  const { data: topProducts = [], isLoading: loadingProducts } = useQuery({
    queryKey: ['analytics', 'top-products', topBy],
    queryFn: () => api.get(`/analytics/top-products?limit=${ANALYTICS_TOP}&by=${topBy}`).then((r) => r.data.data ?? r.data),
  });

  const { data: cycleProfitability = [], isLoading: loadingCycles } = useQuery({
    queryKey: ['analytics', 'cycle-profitability'],
    queryFn: () => api.get('/analytics/cycle-profitability').then((r) => r.data.data ?? r.data),
  });

  // The top five of each (owner 2026-10-19): products that sold, in the API's
  // ranking; cycles by profit, highest first.
  const productList: TopProduct[] = topSoldProducts(Array.isArray(topProducts) ? (topProducts as TopProduct[]) : []);
  const cycleList: CycleProfit[] = mostProfitableCycles(
    Array.isArray(cycleProfitability) ? (cycleProfitability as CycleProfit[]) : [],
  );

  const isLoading = loadingProducts || loadingCycles;

  // Top products: the name (its SKU under it), quantity sold, revenue,
  // margin. The revenue fits "123,456.00 EGP".
  const topProductColumns: Column<TopProduct>[] = [
    {
      key: 'product', header: t('product'), width: 'auto', title: (p) => localName(p, locale),
      skeleton: { kind: 'custom', render: () => <TopProductNameSkeleton /> },
      cell: (p) => (
        <>
          <p className="font-medium text-gray-900 line-clamp-2 break-words" title={localName(p, locale)}>{localName(p, locale)}</p>
          <p className="truncate font-mono text-xs text-gray-500" title={p.sku}><bdi dir="ltr">{p.sku}</bdi></p>
        </>
      ),
    },
    {
      key: 'quantity', header: t('quantitySold'), width: '6.5rem', kind: 'value', align: 'end', className: 'text-gray-900',
      skeleton: { kind: 'text', share: 'w-1/4' }, cell: (p) => formatNumber(p.totalQuantitySold),
    },
    {
      key: 'revenue', header: t('revenue'), width: '8rem', kind: 'value', align: 'end', className: 'text-gray-900',
      skeleton: { kind: 'text', share: 'w-2/3' }, cell: (p) => <Money value={p.revenueEgp} />,
    },
    {
      key: 'margin', header: t('margin'), width: '5rem', kind: 'value', align: 'end',
      skeleton: { kind: 'text', share: 'w-1/2' },
      cell: (p) =>
        p.marginPct === null ? (
          <span className="text-gray-400">—</span>
        ) : (
          <span className={p.marginPct >= 0 ? 'text-green-600' : 'text-red-600'}>{pct(p.marginPct)}</span>
        ),
    },
  ];

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      </div>

      {/* Loading: every section keeps its frame and heading; its body is traced. */}
      {isLoading && <LoadingStatus />}

      {/* Profit and loss for a period, above the rest (owner 2026-10-18). It
          reads its period from the address, and `useSearchParams` cannot be
          prerendered, so it sits in a Suspense boundary traced in its shape. */}
      <Suspense
        fallback={
          <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
            <ProfitAndLossSkeleton />
          </section>
        }
      >
        <ProfitAndLossSection />
      </Suspense>

        <>
          {/* Revenue by month lived here; its figures are the profit and loss
              chart's columns now (owner 2026-10-18, "Option A"). */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top Products */}
            <section className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                  <Package className="h-5 w-5 text-gray-400" />
                  {t('topProducts')}
                </h2>
                <Segmented
                  testId="analytics-top-products-by"
                  label={td('topProductsRankedBy')}
                  value={topBy}
                  onChange={setTopBy}
                  options={[
                    { value: 'units', label: td('byUnits') },
                    { value: 'revenue', label: td('byRevenue') },
                  ]}
                />
              </div>
              {!loadingProducts && productList.length === 0 ? (
                <EmptyState size="compact" icon={Package} title={t('noData')} description={t('noTopProductsHint')} />
              ) : (
                // The shared table (components/ui/data-table.tsx). The card is
                // half the page wide, so the SKU sits under the name rather than
                // in a column of its own (its header was an untranslated "SKU"),
                // and the name takes what the three figures leave.
                <DataTable
                  frame="none"
                  density="compact"
                  autoMin="9rem"
                  isLoading={loadingProducts}
                  skeletonRows={ANALYTICS_TOP}
                  rows={productList}
                  rowKey={(p) => p.productId}
                  columns={topProductColumns}
                />
              )}
            </section>

            {/* Cycle Profitability */}
            <section className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Route className="h-5 w-5 text-gray-400" />
                {t('cycleProfitability')}
              </h2>
              {loadingCycles ? (
                <SkeletonGroup className="space-y-3">
                  {repeat(ANALYTICS_TOP, (i) => <CycleProfitCardSkeleton key={i} />)}
                </SkeletonGroup>
              ) : cycleList.length === 0 ? (
                <EmptyState size="compact" icon={Route} title={t('noData')} description={t('noCycleProfitHint')} />
              ) : (
                <div className="space-y-3">
                  {cycleList.map((c) => (
                    <div key={c.cycleCode} className="rounded-lg bg-gray-50 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900">{c.cycleCode}</p>
                          <p className="text-xs text-gray-500">
                            {codeLabel('originType', c.originType)} · {codeLabel('cycleStatus', c.status)}
                          </p>
                        </div>
                        <div className="text-end shrink-0">
                          <p
                            className={`text-sm font-medium flex items-center gap-1 justify-end ${
                              c.profit >= 0 ? 'text-green-600' : 'text-red-600'
                            }`}
                          >
                            {c.profit >= 0 ? (
                              <TrendingUp className="h-3.5 w-3.5" />
                            ) : (
                              <TrendingDown className="h-3.5 w-3.5" />
                            )}
                            <Money value={c.profit} />
                          </p>
                          {c.roiPct !== null && (
                            <p className="text-xs text-gray-500">ROI {pct(c.roiPct)}</p>
                          )}
                        </div>
                      </div>

                      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-gray-200 pt-2 text-xs">
                        <div>
                          <span className="block text-gray-500">{t('revenue')}</span>
                          <Money value={c.totalRevenue} className="text-gray-900" />
                        </div>
                        <div>
                          <span className="block text-gray-500">{t('totalCost')}</span>
                          <Money value={c.totalCost} className="text-gray-900" />
                        </div>
                        <div>
                          {/* Unsold stock keeps its cost with the cycle, so profit
                              so far covers only what has actually sold. */}
                          <span className="block text-gray-500">{t('unsoldStock')}</span>
                          <Money value={c.unsoldValueEgp} className="text-gray-900" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
    </div>
  );
}
