'use client';
import { CustomerLink, ProductLink } from '@/components/ui/entity-link';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Activity, Banknote, PackageCheck, ShoppingCart } from 'lucide-react';
import { api } from '@/lib/api';
import { useDateFormat } from '@/lib/dates';
import { useCodeLabel } from '@/lib/labels';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';

/** One line of `GET /analytics/recent-activity`, as the API sends it. */
export interface RecentActivityItem {
  kind: 'SALE' | 'PAYMENT' | 'RECEIPT';
  id: string;
  occurredAt: string;
  recordedAt: string;
  reference: string | null;
  status?: string;
  amount?: number;
  currency?: string;
  quantity?: number;
  customer?: { id: string; displayName: string; isWalkIn?: boolean };
  product?: { id: string; name: string; sku: string };
  cycleId?: string;
}

/** Under `analytics` so a confirmed sale (which invalidates `['analytics']`) refreshes it. */
export const RECENT_ACTIVITY_KEY = ['analytics', 'recent-activity'] as const;

const KIND_ICON = { SALE: ShoppingCart, PAYMENT: Banknote, RECEIPT: PackageCheck } as const;

/**
 * The latest realised sales, standing payments and verified receipts. Only
 * rendered for roles the endpoint allows — the caller decides that.
 *
 * Refetched every time the dashboard mounts: the app-wide stale time is a
 * minute, and a sale confirmed elsewhere (another tab, the shop portal, the
 * assistant) invalidates nothing in this browser, so a cached list would leave
 * it out after clicking back here.
 */
export function RecentActivity() {
  const t = useTranslations('dashboard');
  const ts = useTranslations('sales');
  const { formatDate } = useDateFormat();
  const codeLabel = useCodeLabel();

  const { data, isLoading, isError } = useQuery({
    queryKey: RECENT_ACTIVITY_KEY,
    queryFn: () =>
      api.get('/analytics/recent-activity?limit=10').then((r) => r.data.data ?? r.data),
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const items: RecentActivityItem[] = Array.isArray(data) ? data : [];

  return (
    <section
      aria-labelledby="recent-activity-heading"
      className="rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <h3 id="recent-activity-heading" className="mb-4 text-lg font-semibold text-card-foreground">
        {t('recentActivity')}
      </h3>

      {isLoading ? (
        <ul aria-hidden="true" className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="h-11 animate-pulse rounded-md bg-muted" />
          ))}
        </ul>
      ) : isError ? (
        <p role="alert" className="py-4 text-center text-sm text-muted-foreground">
          {t('recentActivityError')}
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={t('recentActivityEmpty')}
          description={t('recentActivityEmptyHint')}
          className="py-6"
        />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => {
            const Icon = KIND_ICON[item.kind] ?? Activity;
            return (
              <li key={`${item.kind}-${item.id}`} className="flex items-start gap-3 py-2.5">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-8 flex-shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-medium text-card-foreground">{t.has(`kind.${item.kind}`) ? t(`kind.${item.kind}`) : item.kind}</span>
                    {item.kind === 'SALE' && item.reference && (
                      <span className="text-muted-foreground" dir="ltr">{item.reference}</span>
                    )}
                    {item.kind === 'PAYMENT' && item.reference && (
                      <span className="text-muted-foreground">{codeLabel('paymentMethod', item.reference)}</span>
                    )}
                    {item.kind === 'SALE' && item.status && (
                      <span className="text-xs text-muted-foreground">{codeLabel('orderStatus', item.status)}</span>
                    )}
                  </p>
                  {/* Who or what it was, linked to its own page (I2): a shop's
                      name opens the shop. The walk-in record has no page, and
                      reads "Walk-in" in the reader's language. */}
                  <p className="min-w-0 text-xs text-muted-foreground" data-testid="recent-activity-subject">
                    {item.customer ? (
                      item.customer.isWalkIn ? (
                        <span>{ts('walkInCustomer')}</span>
                      ) : (
                        <CustomerLink truncate id={item.customer.id} name={item.customer.displayName} />
                      )
                    ) : item.product ? (
                      <ProductLink truncate id={item.product.id} name={item.product.name} />
                    ) : (
                      '—'
                    )}
                  </p>
                </div>
                <div className="flex-shrink-0 text-end">
                  {item.amount !== undefined ? (
                    <Money value={item.amount} currency={item.currency} className="text-sm font-medium text-card-foreground" />
                  ) : item.quantity !== undefined ? (
                    <span className="text-sm font-medium text-card-foreground">
                      {t('units', { count: item.quantity })}
                    </span>
                  ) : null}
                  <p className="text-xs text-muted-foreground">{formatDate(item.occurredAt)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
