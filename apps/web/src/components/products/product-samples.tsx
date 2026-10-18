'use client';

import { useTranslations } from 'next-intl';
import { ChevronRight, PackageOpen } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useAllRecords } from '@/lib/list-all';
import { useNumberFormat } from '@/lib/numbers';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';

/**
 * A product's units out as samples at shops (BUSINESS_LOGIC §4, samples at
 * shops; owner 2026-10-18 round 2), on its own page: how many in all, and per
 * open samples order the shop, the units, how long ago, and a way to the order.
 *
 * Read from the open samples orders the Sales list reads (`status=SAMPLES`),
 * so this card and the order cannot disagree about what is out.
 */

interface OpenSamplesOrder {
  id: string;
  orderNo: string;
  customer?: { displayName: string } | null;
  items?: { productId: string; quantity: number | string }[];
  samples?: { daysAtShop: number } | null;
}

export interface ProductSampleRow {
  orderId: string;
  orderNo: string;
  shop: string;
  units: number;
  daysAtShop: number;
}

/** This product's lines on open samples orders, one row per order, longest out first. */
export function productSampleRows(orders: OpenSamplesOrder[], productId: string): ProductSampleRow[] {
  return orders
    .map((o) => ({
      orderId: o.id,
      orderNo: o.orderNo,
      shop: o.customer?.displayName ?? '—',
      units: (o.items ?? [])
        .filter((i) => i.productId === productId)
        .reduce((s, i) => s + Number(i.quantity), 0),
      daysAtShop: o.samples?.daysAtShop ?? 0,
    }))
    .filter((r) => r.units > 0)
    .sort((a, b) => b.daysAtShop - a.daysAtShop || a.orderNo.localeCompare(b.orderNo));
}

/** The open samples orders holding this product, and their units in all. */
export function useProductSamples(productId: string) {
  const query = useAllRecords<OpenSamplesOrder>(['sales', 'samples-open'], '/sales/orders', { status: 'SAMPLES' });
  const rows = productSampleRows(query.items, productId);
  return { rows, units: rows.reduce((s, r) => s + r.units, 0), isLoading: query.isLoading };
}

export function ProductSamplesCard({ productId }: { productId: string }) {
  const t = useTranslations('products.samples');
  const tsm = useTranslations('sales.samples');
  const { formatNumber } = useNumberFormat();
  const { rows, units, isLoading } = useProductSamples(productId);

  return (
    <div className="bg-card rounded-xl border border-border p-5" data-testid="product-samples">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <PackageOpen className="h-4 w-4 text-muted-foreground" />
          {t('title')}
        </h2>
        {!isLoading && units > 0 && (
          <span
            data-testid="product-samples-total"
            className="rounded-full bg-accent-100 px-2.5 py-0.5 text-xs font-medium text-accent-800"
          >
            {t('units', { count: units })}
          </span>
        )}
      </div>
      {isLoading ? (
        <SkeletonRegion className="space-y-2">
          {repeat(2, (i) => (
            <div key={i} data-testid="skeleton-row" className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5">
              <div className="space-y-1.5">
                <SkeletonText className="w-28" />
                <SkeletonText size="xs" className="w-20" />
              </div>
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </SkeletonRegion>
      ) : rows.length === 0 ? (
        <EmptyState size="compact" icon={PackageOpen} title={t('emptyTitle')} description={t('emptyHint')} />
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.orderId}>
              <Link
                href={`/sales?order=${r.orderId}`}
                data-testid="product-samples-row"
                className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2.5 hover:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground" title={r.shop}>
                    {r.shop}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    <span className="font-mono">{r.orderNo}</span> · {tsm('leftAgo', { days: r.daysAtShop })}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-foreground">
                  {formatNumber(r.units)}
                  <ChevronRight className="h-4 w-4 text-muted-foreground rtl:rotate-180" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
