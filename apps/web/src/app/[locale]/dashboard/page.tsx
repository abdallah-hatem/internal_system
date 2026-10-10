'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth-context';
import { EmptyState } from '../../../components/ui/empty-state';
import { QuickActions } from '../../../components/dashboard/quick-actions';
import { RecentActivity } from '../../../components/dashboard/recent-activity';
import { StatTile } from '../../../components/dashboard/stat-tile';
import {
  canSeeRecentActivity,
  tileHref,
  type TileKey,
} from '../../../components/dashboard/dashboard-model';
import {
  TrendingUp, Package, AlertTriangle, DollarSign,
  Activity, Route, Wallet, Clock, Receipt, Landmark,
  type LucideIcon,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────
interface DashboardData {
  totalRevenue: number;
  totalExpenses: number;
  totalCogs?: number;
  totalCashOut?: number;
  totalCashIn?: number;
  cashOnHand?: number;
  netProfit: number;
  activeCycles: number;
  inventoryValue: number;
  receivables: number;
  collected: number;
  lowStockAlerts: number;
  totalCustomers: number;
  totalProducts: number;
}

interface TopProduct {
  productId: string;
  name: string;
  sku: string;
  totalQuantitySold: number;
}

// ─── Main Page ────────────────────────────────────────────────────────

/** Money tiles read as money: always two decimals, grouped thousands. */
const egp = (v: number | undefined) =>
  `${Number(v ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} EGP`;

const TILE_COUNT = 11;

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const { user } = useAuth();
  const role = user?.role;

  const { data: dashData, isLoading: loadingDash } = useQuery({
    queryKey: ['analytics', 'dashboard'],
    queryFn: () => api.get('/analytics/dashboard').then((r) => r.data.data ?? r.data),
  });

  const { data: topProducts = [], isLoading: loadingProducts } = useQuery({
    queryKey: ['analytics', 'top-products', 'dashboard'],
    queryFn: () => api.get('/analytics/top-products?limit=5').then((r) => r.data.data ?? r.data),
  });

  const data: DashboardData = dashData ?? {
    totalRevenue: 0,
    totalExpenses: 0,
    totalCogs: 0,
    totalCashOut: 0,
    totalCashIn: 0,
    cashOnHand: 0,
    netProfit: 0,
    activeCycles: 0,
    inventoryValue: 0,
    receivables: 0,
    collected: 0,
    lowStockAlerts: 0,
    totalCustomers: 0,
    totalProducts: 0,
  };

  const productList: TopProduct[] = Array.isArray(topProducts) ? topProducts : [];

  const stats: { key: TileKey; value: string; icon: LucideIcon; color: string }[] = [
    // Sold, collected and still owed sit together on purpose: the first two
    // differ by the third, and a strong month of selling with an empty till
    // looks identical to a strong month of collecting if only one is shown.
    { key: 'revenue', value: egp(data.totalRevenue), icon: DollarSign, color: 'bg-green-500' },
    { key: 'collected', value: egp(data.collected), icon: Wallet, color: 'bg-emerald-600' },
    { key: 'receivables', value: egp(data.receivables), icon: Clock, color: 'bg-yellow-500' },
    { key: 'cogs', value: egp(data.totalCogs), icon: Package, color: 'bg-slate-500' },
    // Net profit subtracts this, and it was fetched and then never shown — so
    // revenue less cost of goods did not equal the profit on screen and nothing
    // accounted for the difference. Buying stock is not here: it converts cash
    // into inventory and becomes a cost when the goods sell.
    { key: 'expenses', value: egp(data.totalExpenses), icon: Receipt, color: 'bg-rose-500' },
    { key: 'netProfit', value: egp(data.netProfit), icon: TrendingUp, color: 'bg-blue-500' },
    { key: 'cashOut', value: egp(data.totalCashOut), icon: DollarSign, color: 'bg-teal-600' },
    // Everything in less everything out. It could not be shown before
    // contributions were recorded: the ledger held the purchase going out and
    // nothing for the capital coming in, so the figure was short by exactly
    // what the partners had put in.
    {
      key: 'cashOnHand',
      value: egp(data.cashOnHand ?? 0),
      icon: Landmark,
      color: (data.cashOnHand ?? 0) < 0 ? 'bg-red-600' : 'bg-cyan-600',
    },
    { key: 'activeCycles', value: data.activeCycles?.toString() ?? '0', icon: Activity, color: 'bg-purple-500' },
    { key: 'inventoryValue', value: egp(data.inventoryValue), icon: Package, color: 'bg-orange-500' },
    { key: 'lowStockAlerts', value: data.lowStockAlerts?.toString() ?? '0', icon: AlertTriangle, color: 'bg-red-500' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <QuickActions role={role} />
      </div>

      {/* Stat tiles — two columns on a phone, each one a link to its list. */}
      {loadingDash ? (
        <div aria-hidden="true" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          {Array.from({ length: TILE_COUNT }, (_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-muted sm:h-28" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          {stats.map((stat) => (
            <StatTile
              key={stat.key}
              testId={`tile-${stat.key}`}
              label={t(stat.key)}
              value={stat.value}
              icon={stat.icon}
              color={stat.color}
              href={tileHref(stat.key, role)}
            />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {canSeeRecentActivity(role) && <RecentActivity />}

        <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
          <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-card-foreground">
            <Route aria-hidden="true" className="size-5 text-muted-foreground" />
            {t('topProducts')}
          </h3>
          {loadingProducts ? (
            <ul aria-hidden="true" className="space-y-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <li key={i} className="h-11 animate-pulse rounded-md bg-muted" />
              ))}
            </ul>
          ) : productList.length === 0 ? (
            <EmptyState icon={Package} title={t('topProductsEmpty')} className="py-6" />
          ) : (
            <ul className="divide-y divide-border">
              {productList.map((item) => (
                <li key={item.productId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-card-foreground">{item.name}</p>
                    <p className="text-xs text-muted-foreground" dir="ltr">{item.sku}</p>
                  </div>
                  <span className="flex-shrink-0 text-sm font-medium text-card-foreground">
                    {t('sold', { count: item.totalQuantitySold })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
