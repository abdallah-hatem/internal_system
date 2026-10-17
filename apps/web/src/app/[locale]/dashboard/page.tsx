'use client';
import { LatinText } from '@/components/ui/latin-text';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useNumberFormat } from '@/lib/numbers';
import { useAuth } from '../../../lib/auth-context';
import { EmptyState } from '../../../components/ui/empty-state';
import { QuickActions } from '../../../components/dashboard/quick-actions';
import { StatTile, StatTileSkeleton } from '../../../components/dashboard/stat-tile';
import { LoadingStatus, SkeletonGroup, SkeletonText, repeat } from '../../../components/ui/skeleton';
import {
  dashboardView,
  tileHref,
  type TileKey,
} from '../../../components/dashboard/dashboard-model';
import { YourCycles } from '../../../components/dashboard/your-cycles';
import { ToCollect } from '../../../components/dashboard/to-collect';
import { Money } from '../../../components/ui/money';
import {
  TrendingUp, Package, AlertTriangle, DollarSign,
  Activity, Route, Wallet, Clock, Receipt, Landmark, HandCoins, Boxes,
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
  unitsInStock?: number;
  receivables: number;
  collected: number;
  lowStockAlerts: number;
  totalCustomers: number;
  totalProducts: number;
  /** What friends who paid suppliers are still owed (§18). */
  owedToLenders?: {
    lines: { currency: string; owed: string; rateToEgp: string | null; owedEgp: string | null }[];
    totalEgp: string;
    missingRate: boolean;
  };
}

interface TopProduct {
  productId: string;
  name: string;
  sku: string;
  totalQuantitySold: number;
}

// ─── Skeletons ────────────────────────────────────────────────────────

/** How many tiles the business dashboard shows; the last one carries a second line. */
const TILE_COUNT = 13;

/**
 * Thirteen tiles leave one alone on the last row in two columns and in three,
 * so the last tile — the one with a second line — takes the whole row.
 */
const LAST_TILE_SPAN = 'col-span-2 lg:col-span-3';

/**
 * The tile grid before the figures arrive — the same grid, one skeleton per
 * tile. The page renders the one "Loading" announcement beside it.
 */
function StatTilesSkeleton() {
  return (
    <SkeletonGroup className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
      {repeat(TILE_COUNT, (i) => (
        <StatTileSkeleton
          key={i}
          sub={i === TILE_COUNT - 1}
          className={i === TILE_COUNT - 1 ? LAST_TILE_SPAN : ''}
        />
      ))}
    </SkeletonGroup>
  );
}

/** One top-product line, traced: name over SKU, the units sold at the end. */
function TopProductRowSkeleton() {
  return (
    <li data-testid="skeleton-row" className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <SkeletonText className="w-36" />
        <SkeletonText size="xs" className="w-20" />
      </div>
      <SkeletonText className="w-14" />
    </li>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  // Money tiles read as money: two decimals, grouped thousands, Latin digits.
  const { formatMoney: egp, formatNumber } = useNumberFormat();
  const { user } = useAuth();
  const role = user?.role;
  // A temporary investor sees only their own cycles (R1): the business-wide
  // figures are refused them, so they are neither fetched nor shown.
  const view = dashboardView(role);

  const { data: dashData, isLoading: loadingDash } = useQuery({
    queryKey: ['analytics', 'dashboard'],
    queryFn: () => api.get('/analytics/dashboard').then((r) => r.data.data ?? r.data),
    enabled: view === 'business',
  });

  const { data: topProducts = [], isLoading: loadingProducts } = useQuery({
    queryKey: ['analytics', 'top-products', 'dashboard'],
    queryFn: () => api.get('/analytics/top-products?limit=5').then((r) => r.data.data ?? r.data),
    enabled: view === 'business',
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

  const owedLines = data.owedToLenders?.lines ?? [];

  const stats: { key: TileKey; value: string; icon: LucideIcon; color: string; sub?: React.ReactNode }[] = [
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
    // Every unit on the shelf, all products together — not how many products exist.
    { key: 'unitsInStock', value: formatNumber(Number(data.unitsInStock ?? 0), { maximumFractionDigits: 3 }), icon: Boxes, color: 'bg-orange-400' },
    { key: 'lowStockAlerts', value: data.lowStockAlerts?.toString() ?? '0', icon: AlertTriangle, color: 'bg-red-500' },
    // In each friend's currency — the debt itself — and in pounds at today's
    // rate, which is what paying it all today would cost (§18).
    {
      key: 'owedToLenders',
      value: egp(Number(data.owedToLenders?.totalEgp ?? 0)),
      icon: HandCoins,
      color: 'bg-accent-600',
      sub:
        owedLines.length === 0 ? (
          t('owedToLendersNone')
        ) : (
          <span className="flex flex-col gap-0.5">
            <span className="flex flex-wrap gap-x-2" data-testid="owed-to-lenders-lines">
              {owedLines.map((l) => (
                <Money key={l.currency} value={l.owed} currency={l.currency} />
              ))}
            </span>
            {data.owedToLenders?.missingRate && <span>{t('owedToLendersNoRate')}</span>}
          </span>
        ),
    },
  ];

  if (view !== 'business') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          {view === 'cycles' && (
            <p className="mt-1 text-sm text-muted-foreground">{t('investorSubtitle')}</p>
          )}
        </div>
        {view === 'cycles' ? (
          <YourCycles />
        ) : (
          <>
            <LoadingStatus />
            <StatTilesSkeleton />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <QuickActions role={role} />
      </div>

      {(loadingDash || loadingProducts) && <LoadingStatus />}

      {/* Stat tiles — two columns on a phone, each one a link to its list. */}
      {loadingDash ? (
        <StatTilesSkeleton />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          {stats.map((stat, i) => (
            <StatTile
              key={stat.key}
              testId={`tile-${stat.key}`}
              label={t(stat.key)}
              value={stat.value}
              icon={stat.icon}
              color={stat.color}
              href={tileHref(stat.key, role)}
              sub={stat.sub}
              className={i === stats.length - 1 ? LAST_TILE_SPAN : ''}
            />
          ))}
        </div>
      )}

      {/* Who to chase beside what sells (owner, 2026-10-15). */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ToCollect />

        <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
          <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-card-foreground">
            <Route aria-hidden="true" className="size-5 text-muted-foreground" />
            {t('topProducts')}
          </h3>
          {loadingProducts ? (
            <SkeletonGroup as="ul" className="divide-y divide-border">
              {repeat(5, (i) => <TopProductRowSkeleton key={i} />)}
            </SkeletonGroup>
          ) : productList.length === 0 ? (
            <EmptyState icon={Package} title={t('topProductsEmpty')} className="py-6" />
          ) : (
            <ul className="divide-y divide-border">
              {productList.map((item) => (
                <li key={item.productId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <LatinText truncate className="text-sm font-medium text-card-foreground">{item.name}</LatinText>
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
