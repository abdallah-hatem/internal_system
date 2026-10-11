'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Boxes } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useCodeLabel } from '@/lib/labels';
import { Money } from '@/components/ui/money';
import { EmptyState } from '@/components/ui/empty-state';

/** One line of GET /analytics/cycle-profitability — the API scopes it. */
interface CycleProfit {
  cycleId: string;
  cycleCode: string;
  status: string;
  totalRevenue: number;
  totalCost: number;
  profit: number;
}

/**
 * A temporary investor's dashboard: the cycles they put money into and what
 * each has earned so far (R1, owner 2026-10-10). The figures are the same
 * profitability line the cycle list and Analytics read, so profit is defined
 * once (rule 11); the API returns only the investor's own cycles.
 */
export function YourCycles() {
  const t = useTranslations('dashboard');
  const codeLabel = useCodeLabel();
  const { data, isLoading, isError } = useQuery<CycleProfit[]>({
    queryKey: ['analytics', 'cycle-profitability'],
    queryFn: () =>
      api.get('/analytics/cycle-profitability').then((r) => r.data.data ?? r.data),
  });
  const rows = Array.isArray(data) ? data : [];

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-6" data-testid="your-cycles">
      <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-card-foreground">
        <Boxes aria-hidden="true" className="size-5 text-muted-foreground" />
        {t('yourCycles')}
      </h3>
      {isLoading ? (
        <ul aria-hidden="true" className="space-y-3">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-14 animate-pulse rounded-md bg-muted" />
          ))}
        </ul>
      ) : isError ? (
        <p role="alert" className="text-sm text-destructive">{t('yourCyclesError')}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={t('yourCyclesEmpty')}
          description={t('yourCyclesEmptyHint')}
          className="py-6"
        />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((c) => (
            <li key={c.cycleCode}>
              <Link
                href={`/cycles/${c.cycleId}/details`}
                className="flex items-center justify-between gap-3 py-3 hover:bg-muted/50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-card-foreground" dir="ltr">
                    {c.cycleCode}
                  </p>
                  <p className="text-xs text-muted-foreground">{codeLabel('cycleStatus', c.status)}</p>
                </div>
                <div className="flex-shrink-0 text-end">
                  <p className="text-xs text-muted-foreground">{t('cycleProfit')}</p>
                  <Money
                    value={c.profit}
                    className={`text-sm font-semibold ${c.profit > 0 ? 'text-success' : c.profit < 0 ? 'text-destructive' : 'text-card-foreground'}`}
                  />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
