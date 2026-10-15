'use client';

import { useLocale, useTranslations } from 'next-intl';
import { localName } from '@/lib/localized-name';
import { useEffect, useRef } from 'react';
import { Money } from '../../../components/ui/money';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import {
  BarChart3, TrendingUp, TrendingDown, Package, Route,
} from 'lucide-react';
import { useCodeLabel } from '@/lib/labels';
import { useNumberFormat } from '@/lib/numbers';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';

// ─── Types ────────────────────────────────────────────────────────────
interface MonthlyRevenue {
  month: string;
  revenue: number;
}

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

/** How many months the chart asks for, and how many products the table. */
const MONTHS = 12;
const TOP_PRODUCTS = 10;
/** Bar heights for the placeholder chart — a shape, not data. */
const BAR_HEIGHTS = [30, 45, 25, 60, 40, 70, 55, 35, 80, 50, 65, 90];

/** The bar chart: the same strip of columns, a label line above and below each bar. */
function RevenueChartSkeleton() {
  return (
    <SkeletonGroup className="flex items-end gap-2 h-48 overflow-hidden">
      {repeat(MONTHS, (i) => (
        <div key={i} className="flex h-full flex-col items-center gap-1 min-w-[3rem] flex-1">
          <SkeletonText size="xs" lineClassName="h-[15px]" className="h-2 w-6" />
          <div className="flex w-full flex-1 items-end">
            <Skeleton className="w-full rounded-b-none rounded-t-md" style={{ height: `${BAR_HEIGHTS[i % BAR_HEIGHTS.length]}%` }} />
          </div>
          <SkeletonText size="xs" lineClassName="h-[15px]" className="h-2 w-4" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** One top-product row: name, SKU, then three figures at the end. */
function TopProductRowSkeleton() {
  return (
    <tr data-testid="skeleton-row">
      {/* A product name and its revenue wrap to two lines in a phone's narrow table. */}
      <td className="py-2.5"><SkeletonText className="w-28" /><SkeletonText className="w-16" lineClassName="sm:hidden" /></td>
      <td className="py-2.5"><SkeletonText size="xs" lineClassName="h-5" className="w-16" /></td>
      <td className="py-2.5"><SkeletonText lineClassName="justify-end" className="w-8" /></td>
      <td className="py-2.5"><SkeletonText lineClassName="justify-end" className="w-20" /></td>
      <td className="py-2.5"><SkeletonText lineClassName="justify-end" className="w-10" /></td>
    </tr>
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
  const { formatNumber, formatMoney } = useNumberFormat();
  const pct = (v: number) => `${formatNumber(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

  const { data: monthlyRevenue = [], isLoading: loadingRevenue } = useQuery({
    queryKey: ['analytics', 'revenue-by-month'],
    queryFn: () => api.get(`/analytics/revenue-by-month?months=${MONTHS}`).then((r) => r.data.data ?? r.data),
  });

  const { data: topProducts = [], isLoading: loadingProducts } = useQuery({
    queryKey: ['analytics', 'top-products'],
    queryFn: () => api.get(`/analytics/top-products?limit=${TOP_PRODUCTS}`).then((r) => r.data.data ?? r.data),
  });

  const { data: cycleProfitability = [], isLoading: loadingCycles } = useQuery({
    queryKey: ['analytics', 'cycle-profitability'],
    queryFn: () => api.get('/analytics/cycle-profitability').then((r) => r.data.data ?? r.data),
  });

  const revenueList: MonthlyRevenue[] = Array.isArray(monthlyRevenue) ? monthlyRevenue : [];
  const productList: TopProduct[] = Array.isArray(topProducts) ? topProducts : [];
  const cycleList: CycleProfit[] = Array.isArray(cycleProfitability) ? cycleProfitability : [];

  const maxRevenue = Math.max(...revenueList.map((r) => r.revenue), 1);
  const hasAnyRevenue = revenueList.some((r) => r.revenue > 0);

  // The series runs oldest to newest inside a horizontally scrolling strip, so
  // the most recent months — the only ones with data in a young system — start
  // off past the right edge. The page looked empty because its one non-zero bar
  // was scrolled out of view.
  const chartRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chartRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [revenueList]);

  const isLoading = loadingRevenue || loadingProducts || loadingCycles;

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      </div>

      {/* Loading: every section keeps its frame and heading; its body is traced. */}
      {isLoading && <LoadingStatus />}

        <>
          {/* Revenue by Month — CSS Bar Chart */}
          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('revenueByMonth')}</h2>
            {loadingRevenue ? (
              <RevenueChartSkeleton />
            ) : revenueList.length === 0 ? (
              <EmptyState size="compact" icon={BarChart3} title={t('noData')} description={t('noRevenueHint')} />
            ) : (
              <>
                {!hasAnyRevenue && (
                  <p className="mb-3 text-xs text-gray-500">{t('noRevenueInPeriod')}</p>
                )}
                <div ref={chartRef} className="flex items-end gap-2 h-48 overflow-x-auto">
                  {revenueList.map((item) => {
                    const heightPct = maxRevenue > 0 ? (item.revenue / maxRevenue) * 100 : 0;
                    const [year, month] = (item.month ?? '').split('-');
                    // A bare "01" is ambiguous across a 13-month window; mark
                    // where the year turns over.
                    const label = month === '01' || item.month === revenueList[0]?.month
                      ? `${month}/${year?.slice(2)}`
                      : month;
                    return (
                      <div
                        key={item.month}
                        title={`${item.month}: ${formatMoney(item.revenue)}`}
                        className="flex h-full flex-col items-center gap-1 min-w-[3rem] flex-1"
                      >
                        <span className={`text-[10px] font-medium ${item.revenue > 0 ? 'text-gray-700' : 'text-gray-300'}`}>
                          {item.revenue >= 1000
                            ? `${formatNumber(item.revenue / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`
                            : formatNumber(item.revenue)}
                        </span>
                        {/* The bar's height is a percentage, so it needs a
                            parent with a resolved height — inside an auto-height
                            column it collapses to nothing and the chart renders
                            as a row of labels with no bars. */}
                        <div className="flex w-full flex-1 items-end">
                          <div
                            className={`w-full rounded-t-md transition-all ${item.revenue > 0 ? 'bg-primary-500' : 'bg-gray-100'}`}
                            style={{ height: `${Math.max(heightPct, 2)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-gray-500 whitespace-nowrap">{label}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top Products */}
            <section className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Package className="h-5 w-5 text-gray-400" />
                {t('topProducts')}
              </h2>
              {!loadingProducts && productList.length === 0 ? (
                <EmptyState size="compact" icon={Package} title={t('noData')} description={t('noTopProductsHint')} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="text-start py-2 font-medium text-gray-600">{t('product')}</th>
                        <th className="text-start py-2 font-medium text-gray-600">SKU</th>
                        <th className="text-end py-2 font-medium text-gray-600">{t('quantitySold')}</th>
                        <th className="text-end py-2 font-medium text-gray-600">{t('revenue')}</th>
                        <th className="text-end py-2 font-medium text-gray-600">{t('margin')}</th>
                      </tr>
                    </thead>
                    {loadingProducts ? (
                      <SkeletonGroup as="tbody" className="divide-y divide-muted">
                        {repeat(TOP_PRODUCTS, (i) => <TopProductRowSkeleton key={i} />)}
                      </SkeletonGroup>
                    ) : (
                    <tbody className="divide-y divide-gray-100">
                      {productList.map((p) => (
                        <tr key={p.productId} className="hover:bg-gray-50">
                          <td className="py-2.5 text-gray-900 font-medium">{localName(p, locale)}</td>
                          <td className="py-2.5 text-gray-500 font-mono text-xs">{p.sku}</td>
                          <td className="py-2.5 text-end text-gray-900">{formatNumber(p.totalQuantitySold)}</td>
                          <td className="py-2.5 text-end text-gray-900"><Money value={p.revenueEgp} /></td>
                          <td className="py-2.5 text-end">
                            {p.marginPct === null ? (
                              <span className="text-gray-400">—</span>
                            ) : (
                              <span className={p.marginPct >= 0 ? 'text-green-600' : 'text-red-600'}>
                                {pct(p.marginPct)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    )}
                  </table>
                </div>
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
                  {repeat(3, (i) => <CycleProfitCardSkeleton key={i} />)}
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
