'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useNumberFormat } from '@/lib/numbers';
import { Banknote, Clock } from '@/components/ui/icons';
import { SkeletonGroup } from '@/components/ui/skeleton';
import { StatTile, StatTileSkeleton } from '@/components/dashboard/stat-tile';
import { useProfitPill } from '@/components/dashboard/profit-pill';
import { TILE_TARGETS } from '@/components/dashboard/dashboard-model';

/** The dashboard figures this card reads — the same response, the same query (rule 11). */
interface SalesCashFigures {
  cashFromSalesEgp?: number;
  receivables?: number;
  profitOnCollectedEgp?: number;
  profitToCollectEgp?: number;
}

const GRID = 'grid grid-cols-2 gap-3 sm:gap-4';

/**
 * Sales cash, all time (owner 2026-11-06: "where to see the current cash from
 * sales, and what left to collect, why is it not shown in analytics?"). Two of
 * the dashboard's tiles, as the dashboard draws them: Collected is its Cash
 * from sales, Still to collect its To collect, each with the profit pill and
 * each leading where the dashboard tile leads (Analytics itself is for the
 * roles those lists let in). Not tied to the period picker
 * above it — its heading says All time.
 */
export function SalesCashSection() {
  const t = useTranslations('analytics.salesCash');
  const { formatMoney: egp } = useNumberFormat();
  const profitPill = useProfitPill();

  const { data, isLoading } = useQuery<SalesCashFigures>({
    queryKey: ['analytics', 'dashboard'],
    queryFn: () => api.get('/analytics/dashboard').then((r) => r.data.data ?? r.data),
  });

  return (
    <section data-testid="analytics-sales-cash" aria-labelledby="analytics-sales-cash-title" className="space-y-3">
      <h2 id="analytics-sales-cash-title" className="flex items-baseline gap-2 text-lg font-semibold text-foreground">
        {t('title')}
        <span data-testid="analytics-sales-cash-period" className="text-sm font-normal text-muted-foreground">
          {t('allTime')}
        </span>
      </h2>
      {isLoading ? (
        <SkeletonGroup className={GRID}>
          <StatTileSkeleton badge="wide" />
          <StatTileSkeleton badge="wide" />
        </SkeletonGroup>
      ) : (
        <div data-testid="analytics-sales-cash-grid" className={GRID}>
          <StatTile
            testId="sales-cash-collected"
            label={t('collected')}
            value={egp(data?.cashFromSalesEgp ?? 0)}
            icon={Banknote}
            color={(data?.cashFromSalesEgp ?? 0) < 0 ? 'bg-red-600' : 'bg-cyan-600'}
            href={TILE_TARGETS.cashFromSales.href}
            badge={profitPill(data?.profitOnCollectedEgp, 'collected')}
          />
          <StatTile
            testId="sales-cash-to-collect"
            label={t('toCollect')}
            value={egp(data?.receivables ?? 0)}
            icon={Clock}
            color="bg-yellow-500"
            href={TILE_TARGETS.receivables.href}
            badge={profitPill(data?.profitToCollectEgp, 'toCome')}
          />
        </div>
      )}
    </section>
  );
}
