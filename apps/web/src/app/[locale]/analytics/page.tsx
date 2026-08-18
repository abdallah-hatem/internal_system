'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import {
  BarChart3, Loader2, TrendingUp, TrendingDown, Package, Route,
} from 'lucide-react';

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
}

interface CycleProfit {
  cycleCode: string;
  totalCost: number;
  totalRevenue: number;
  profit: number;
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function AnalyticsPage() {
  const t = useTranslations('analytics');
  const tc = useTranslations('common');

  const { data: monthlyRevenue = [], isLoading: loadingRevenue } = useQuery({
    queryKey: ['analytics', 'revenue-by-month'],
    queryFn: () => api.get('/analytics/revenue-by-month?months=12').then((r) => r.data.data ?? r.data),
  });

  const { data: topProducts = [], isLoading: loadingProducts } = useQuery({
    queryKey: ['analytics', 'top-products'],
    queryFn: () => api.get('/analytics/top-products?limit=10').then((r) => r.data.data ?? r.data),
  });

  const { data: cycleProfitability = [], isLoading: loadingCycles } = useQuery({
    queryKey: ['analytics', 'cycle-profitability'],
    queryFn: () => api.get('/analytics/cycle-profitability').then((r) => r.data.data ?? r.data),
  });

  const revenueList: MonthlyRevenue[] = Array.isArray(monthlyRevenue) ? monthlyRevenue : [];
  const productList: TopProduct[] = Array.isArray(topProducts) ? topProducts : [];
  const cycleList: CycleProfit[] = Array.isArray(cycleProfitability) ? cycleProfitability : [];

  const maxRevenue = Math.max(...revenueList.map((r) => r.revenue), 1);

  const isLoading = loadingRevenue || loadingProducts || loadingCycles;

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin me-2" /> {tc('loading')}
        </div>
      )}

      {!isLoading && (
        <>
          {/* Revenue by Month — CSS Bar Chart */}
          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('revenueByMonth')}</h2>
            {revenueList.length === 0 ? (
              <p className="text-sm text-gray-400 py-8 text-center">{t('noData')}</p>
            ) : (
              <div className="flex items-end gap-2 h-48 overflow-x-auto">
                {revenueList.map((item) => {
                  const heightPct = maxRevenue > 0 ? (item.revenue / maxRevenue) * 100 : 0;
                  const monthLabel = item.month?.slice(5) ?? item.month; // show MM
                  return (
                    <div key={item.month} className="flex flex-col items-center gap-1 min-w-[3rem] flex-1">
                      <span className="text-[10px] text-gray-500 font-medium">
                        {item.revenue >= 1000 ? `${(item.revenue / 1000).toFixed(0)}k` : item.revenue}
                      </span>
                      <div
                        className="w-full bg-primary-500 rounded-t-md transition-all"
                        style={{ height: `${Math.max(heightPct, 2)}%` }}
                      />
                      <span className="text-[10px] text-gray-500">{monthLabel}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top Products */}
            <section className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Package className="h-5 w-5 text-gray-400" />
                {t('topProducts')}
              </h2>
              {productList.length === 0 ? (
                <p className="text-sm text-gray-400 py-8 text-center">{t('noData')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="text-start py-2 font-medium text-gray-600">{t('product')}</th>
                        <th className="text-start py-2 font-medium text-gray-600">SKU</th>
                        <th className="text-end py-2 font-medium text-gray-600">{t('quantitySold')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {productList.map((p) => (
                        <tr key={p.productId} className="hover:bg-gray-50">
                          <td className="py-2.5 text-gray-900 font-medium">{p.name}</td>
                          <td className="py-2.5 text-gray-500 font-mono text-xs">{p.sku}</td>
                          <td className="py-2.5 text-end text-gray-900">{p.totalQuantitySold}</td>
                        </tr>
                      ))}
                    </tbody>
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
              {cycleList.length === 0 ? (
                <p className="text-sm text-gray-400 py-8 text-center">{t('noData')}</p>
              ) : (
                <div className="space-y-3">
                  {cycleList.map((c) => (
                    <div key={c.cycleCode} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3">
                      <div>
                        <p className="font-medium text-gray-900">{c.cycleCode}</p>
                        <p className="text-xs text-gray-500">
                          {t('totalCost')}: {c.totalCost?.toLocaleString()} EGP
                        </p>
                      </div>
                      <div className="text-end">
                        <p className="text-sm text-gray-600">{t('revenue')}: {c.totalRevenue?.toLocaleString()} EGP</p>
                        <p className={`text-sm font-medium flex items-center gap-1 justify-end ${c.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {c.profit >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                          {t('profit')}: {c.profit?.toLocaleString()} EGP
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
