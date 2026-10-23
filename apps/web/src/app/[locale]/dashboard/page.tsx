'use client';
import { LatinText } from '@/components/ui/latin-text';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useNumberFormat } from '@/lib/numbers';
import { useAuth } from '../../../lib/auth-context';
import { EmptyState } from '../../../components/ui/empty-state';
import { QuickActions } from '../../../components/dashboard/quick-actions';
import { useTopProductsBy } from '../../../components/dashboard/top-products-by';
import { Segmented } from '@/components/ui/segmented';
import { StatTile, StatTileSkeleton } from '../../../components/dashboard/stat-tile';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '../../../components/ui/skeleton';
import {
  dashboardView,
  tileHref,
  PNL_THIS_MONTH_HREF,
  RIGHT_NOW_TILES,
  THIS_MONTH_TILES,
  type TileKey, PHONE_FIRST_TILES } from '../../../components/dashboard/dashboard-model';
import { ToCollect } from '../../../components/dashboard/to-collect';
import { Money } from '../../../components/ui/money';
import { Link } from '@/i18n/navigation';
import {
  TrendingUp, Package, AlertTriangle, DollarSign,
  Activity, Route, Wallet, Clock, Receipt, Landmark, HandCoins, Boxes,
  type IconComponent, ChevronDown, ArrowRight } from '@/components/ui/icons';

// ─── Types ────────────────────────────────────────────────────────────
/** This calendar month in Cairo — Analytics' profit and loss This month, figure for figure. */
interface MonthFigures {
  from: string;
  to: string;
  revenue: number;
  collected: number;
  netProfit: number;
  expenses: number;
}

interface DashboardData {
  totalRevenue: number;
  totalExpenses: number;
  totalCashIn?: number;
  cashOnHand?: number;
  /** Absent from an API older than 2026-10-23: This month then reads zeros, never all time. */
  month?: MonthFigures;
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
  /** What it brought in, net of returns — the order the list is in. */
  revenueEgp: number;
}

// ─── Skeletons ────────────────────────────────────────────────────────

/** How many Right now tiles a phone shows before "See more" (the rest of PHONE_FIRST_TILES is This month). */
const PHONE_RIGHT_NOW = RIGHT_NOW_TILES.filter((k) => PHONE_FIRST_TILES.includes(k)).length;

/**
 * A Right now tile's span. Four across, the grid has twelve columns: the first four
 * take three each and the last three four each — a row of four, then a row of
 * three, both filling the width (owner 2026-10-23). In two columns seven
 * leave one alone, so the last takes the whole row.
 */
function rightNowSpan(i: number): string {
  const wide = i < 4 ? '@[68rem]:col-span-3' : '@[68rem]:col-span-4';
  return i === RIGHT_NOW_TILES.length - 1 ? `col-span-2 ${wide}` : wide;
}

/** Hidden on a phone until "See more", unless it is one of the first figures. */
function phoneClass(key: TileKey, allTiles: boolean): string {
  return allTiles || PHONE_FIRST_TILES.includes(key) ? '' : 'max-sm:hidden';
}

/**
 * Two columns until the group itself is 68rem wide (a 1440 screen with the
 * sidebar is 71rem), then four across — read off the group's width, not the
 * screen's, because four tiles need room for their figures whatever the
 * sidebar takes (stat-tile.tsx).
 */
const RIGHT_NOW_GRID = 'grid grid-cols-2 gap-3 sm:gap-4 @[68rem]:grid-cols-12';
const THIS_MONTH_GRID = 'grid grid-cols-2 gap-3 sm:gap-4 @[68rem]:grid-cols-4';

/**
 * One headed group of tiles. The heading is what tells a reader whether a
 * figure is today's or this month's (owner 2026-10-23: "are the data
 * filtered or all time?"); This month's carries the way to its full account.
 */
function TileGroup({
  testId,
  title,
  withPnlLink = false,
  gridClass,
  skeleton = false,
  children,
}: {
  testId: string;
  title: string;
  withPnlLink?: boolean;
  gridClass: string;
  /** The figures have not arrived: the heading is real, the grid a skeleton. */
  skeleton?: boolean;
  children: React.ReactNode;
}) {
  const ta = useTranslations('analytics');
  return (
    <section data-testid={testId} aria-labelledby={`${testId}-title`} className="@container space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={`${testId}-title`} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        {withPnlLink && (
          <Link
            href={PNL_THIS_MONTH_HREF}
            data-testid="dashboard-pnl-link"
            className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary-600 hover:underline"
          >
            {ta('pnl.title')}
            <ArrowRight aria-hidden="true" className="size-4 rtl:rotate-180" />
          </Link>
        )}
      </div>
      {skeleton ? (
        <SkeletonGroup className={gridClass}>{children}</SkeletonGroup>
      ) : (
        <div data-testid={`${testId}-grid`} className={gridClass}>
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * The two groups before the figures arrive — the real headings over the same
 * grids and spans, one skeleton per tile, the phone's hidden ones hidden too.
 * The page renders the one "Loading" announcement beside it.
 */
function StatTilesSkeleton() {
  const t = useTranslations('dashboard');
  return (
    <div className="space-y-6">
      <TileGroup testId="dashboard-right-now" title={t('rightNow')} gridClass={RIGHT_NOW_GRID} skeleton>
        {RIGHT_NOW_TILES.map((key, i) => (
          <StatTileSkeleton
            key={key}
            sub={key === 'owedToLenders'}
            className={`${rightNowSpan(i)} ${phoneClass(key, false)}`}
          />
        ))}
      </TileGroup>
      <TileGroup testId="dashboard-this-month" title={t('thisMonth')} withPnlLink gridClass={THIS_MONTH_GRID} skeleton>
        {THIS_MONTH_TILES.map((key) => (
          <StatTileSkeleton key={key} />
        ))}
      </TileGroup>
    </div>
  );
}

/** One top-product line, traced: name and the ranked figure, then the bar and the other figure. */
function TopProductRowSkeleton() {
  return (
    <li data-testid="skeleton-row" className="py-2.5">
      <div className="flex items-center justify-between gap-3">
        <SkeletonText className="w-40" />
        <SkeletonText className="w-16" />
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <Skeleton className="h-1.5 flex-1 rounded-full" />
        <SkeletonText size="xs" className="w-20" />
      </div>
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
  // Only the roles the business-wide figures let in fetch them (dashboardView).
  const view = dashboardView(role);
  // A phone shows PHONE_FIRST_TILES until this is opened; wider screens, all.
  const [allTiles, setAllTiles] = useState(false);

  const { data: dashData, isLoading: loadingDash } = useQuery({
    queryKey: ['analytics', 'dashboard'],
    queryFn: () => api.get('/analytics/dashboard').then((r) => r.data.data ?? r.data),
    enabled: view === 'business',
  });

  // Units or revenue, as the person last chose (units by default).
  const [topBy, setTopBy] = useTopProductsBy();
  const { data: topProducts = [], isLoading: loadingProducts } = useQuery({
    queryKey: ['analytics', 'top-products', 'dashboard', topBy],
    queryFn: () => api.get(`/analytics/top-products?limit=5&by=${topBy}`).then((r) => r.data.data ?? r.data),
    enabled: view === 'business',
  });

  const data: DashboardData = dashData ?? {
    totalRevenue: 0,
    totalExpenses: 0,
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
  // The month's own figures from the server, never the all-time ones under a
  // This month heading, and never summed here (LEARNINGS).
  const month: Omit<MonthFigures, 'from' | 'to'> = data.month ?? { revenue: 0, collected: 0, netProfit: 0, expenses: 0 };

  const productList: TopProduct[] = Array.isArray(topProducts) ? topProducts : [];

  const owedLines = data.owedToLenders?.lines ?? [];

  const tiles: Record<TileKey, { label: string; value: string; icon: IconComponent; color: string; sub?: React.ReactNode }> = {
    // ── Right now ──
    // Everything in less everything out. It could not be shown before
    // contributions were recorded: the ledger held the purchase going out and
    // nothing for the capital coming in, so the figure was short by exactly
    // what the partners had put in.
    cashOnHand: {
      label: t('cashOnHand'),
      value: egp(data.cashOnHand ?? 0),
      icon: Landmark,
      color: (data.cashOnHand ?? 0) < 0 ? 'bg-red-600' : 'bg-cyan-600',
    },
    // What customers owe today: confirmed sales not fully paid.
    receivables: { label: t('toCollect'), value: egp(data.receivables), icon: Clock, color: 'bg-yellow-500' },
    // In each friend's currency — the debt itself — and in pounds at today's
    // rate, which is what paying it all today would cost (§18).
    owedToLenders: {
      label: t('owedToLenders'),
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
    // "Stock value", the product page's word since 2026-10-22, from the same
    // common/stock-value.ts.
    inventoryValue: { label: t('inventoryValue'), value: egp(data.inventoryValue), icon: Package, color: 'bg-orange-500' },
    // Every unit on the shelf, all products together — not how many products exist.
    unitsInStock: {
      label: t('unitsInStock'),
      value: formatNumber(Number(data.unitsInStock ?? 0), { maximumFractionDigits: 3 }),
      icon: Boxes,
      color: 'bg-orange-400',
    },
    lowStockAlerts: { label: t('lowStockAlerts'), value: data.lowStockAlerts?.toString() ?? '0', icon: AlertTriangle, color: 'bg-red-500' },
    activeCycles: { label: t('activeCycles'), value: data.activeCycles?.toString() ?? '0', icon: Activity, color: 'bg-purple-500' },
    // ── This month ──
    // Sold and collected sit together on purpose: a strong month of selling
    // with an empty till looks identical to a strong month of collecting if
    // only one is shown. Net profit subtracts the expenses beside it.
    revenue: { label: t('revenue'), value: egp(month.revenue), icon: DollarSign, color: 'bg-green-500' },
    collected: { label: t('collected'), value: egp(month.collected), icon: Wallet, color: 'bg-emerald-600' },
    netProfit: { label: t('netProfit'), value: egp(month.netProfit), icon: TrendingUp, color: 'bg-blue-500' },
    expenses: { label: t('expenses'), value: egp(month.expenses), icon: Receipt, color: 'bg-rose-500' },
  };

  const renderTile = (key: TileKey, className: string) => {
    const tile = tiles[key];
    return (
      <StatTile
        key={key}
        testId={`tile-${key}`}
        label={tile.label}
        value={tile.value}
        icon={tile.icon}
        color={tile.color}
        href={tileHref(key, role)}
        sub={tile.sub}
        className={className}
      />
    );
  };

  if (view !== 'business') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        </div>
        {view === 'loading' && (
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
      {/* Four actions do not fit beside the title until the screen is wide; below
          that they take their own row rather than leave one button alone on a second line. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <QuickActions role={role} />
      </div>

      {(loadingDash || loadingProducts) && <LoadingStatus />}

      {/* Two headed groups — Right now, then This month (owner 2026-10-23) —
          two columns on a phone, each tile a link to its list. */}
      {loadingDash ? (
        <StatTilesSkeleton />
      ) : (
        <div className="space-y-6">
          <TileGroup testId="dashboard-right-now" title={t('rightNow')} gridClass={RIGHT_NOW_GRID}>
            {RIGHT_NOW_TILES.map((key, i) => renderTile(key, `${rightNowSpan(i)} ${phoneClass(key, allTiles)}`))}
            {RIGHT_NOW_TILES.length > PHONE_RIGHT_NOW && (
              <button
                type="button"
                data-testid="tiles-toggle"
                aria-expanded={allTiles}
                onClick={() => setAllTiles((v) => !v)}
                className="col-span-2 inline-flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-border bg-card text-sm font-medium text-primary hover:bg-muted sm:hidden"
              >
                {allTiles ? t('seeLess') : t('seeMore', { count: RIGHT_NOW_TILES.length - PHONE_RIGHT_NOW })}
                <ChevronDown aria-hidden="true" className={`size-4 transition-transform ${allTiles ? 'rotate-180' : ''}`} />
              </button>
            )}
          </TileGroup>
          <TileGroup testId="dashboard-this-month" title={t('thisMonth')} withPnlLink gridClass={THIS_MONTH_GRID}>
            {THIS_MONTH_TILES.map((key) => renderTile(key, phoneClass(key, allTiles)))}
          </TileGroup>
        </div>
      )}

      {/* Who to chase beside what sells (owner, 2026-10-15). */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ToCollect />

        <section data-testid="top-products" className="relative rounded-xl border border-border bg-card p-4 sm:p-6">
          <h3 className="mb-4 flex items-center gap-2 pe-36 text-lg font-semibold text-card-foreground">
            <Route aria-hidden="true" className="size-5 text-muted-foreground" />
            {t('topProducts')}
          </h3>
          <Segmented
            testId="top-products-by"
            label={t('topProductsRankedBy')}
            value={topBy}
            onChange={setTopBy}
            options={[
              { value: 'units', label: t('byUnits') },
              { value: 'revenue', label: t('byRevenue') },
            ]}
            className="absolute end-4 top-4 sm:end-6 sm:top-6"
          />
          {loadingProducts ? (
            <SkeletonGroup as="ul" className="divide-y divide-border">
              {repeat(5, (i) => <TopProductRowSkeleton key={i} />)}
            </SkeletonGroup>
          ) : productList.length === 0 ? (
            <EmptyState icon={Package} title={t('topProductsEmpty')} className="py-6" />
          ) : (
            <ul className="divide-y divide-border">
              {productList.map((item) => {
                // The figure the list is ranked by comes first and sets the
                // bar; the other sits beside it, smaller (owner 2026-10-18:
                // "how is 21 sold on top of 28?").
                const measure = (p: TopProduct) => (topBy === 'units' ? p.totalQuantitySold : p.revenueEgp);
                const top = Math.max(...productList.map(measure), 0);
                const share = top > 0 ? Math.round((measure(item) / top) * 100) : 0;
                const units = <span data-testid="top-product-units">{t('sold', { count: item.totalQuantitySold })}</span>;
                const revenue = <span data-testid="top-product-revenue"><Money value={item.revenueEgp} /></span>;
                return (
                  <li key={item.productId} data-testid="top-product" className="py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <LatinText truncate className="min-w-0 text-sm font-medium text-card-foreground">{item.name}</LatinText>
                      <span className="flex-shrink-0 text-sm font-semibold text-card-foreground">{topBy === 'units' ? units : revenue}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3">
                      <div
                        role="progressbar"
                        aria-label={item.name}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={share}
                        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
                      >
                        <div data-testid="top-product-bar" className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
                      </div>
                      <span className="flex-shrink-0 text-xs text-muted-foreground">{topBy === 'units' ? revenue : units}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
