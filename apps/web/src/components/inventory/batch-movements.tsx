'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useCodeLabel } from '@/lib/labels';
import { useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { viewPath } from '@/lib/page-views';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { AlertTriangle, ArrowDownRight, ArrowUpRight } from '@/components/ui/icons';

/**
 * One batch's stock movements, each naming the record it came from by the
 * number a person knows it by — ORD-…, RET-…, PO-… — as a link that opens it
 * (2026-10-22). The screens used to print the database id: "Sale order
 * (4d2d3158-…)". The API sends the numbers (`reference`), so this asks nothing.
 *
 * Shared by the product page and the inventory page: the same list, written once.
 */

export interface BatchMovement {
  id: string;
  movementType: string;
  qtyDelta: number | string;
  occurredAt: string;
  referenceType?: string | null;
  referenceId?: string | null;
  /** The record by its own number, and what to open (GET /inventory/batches/:id/movements). */
  reference?: { number: string; saleOrderId?: string; purchaseOrderId?: string } | null;
}

/** Where a movement's record opens: a sale order's popup, or a purchase order's. */
export function referenceHref(ref: BatchMovement['reference']): string | null {
  if (!ref) return null;
  if (ref.saleOrderId) return `/sales?order=${encodeURIComponent(ref.saleOrderId)}`;
  if (ref.purchaseOrderId) return viewPath('purchases', { open: ref.purchaseOrderId });
  return null;
}

const OUT_OF_THE_ORDINARY = new Set(['ADJUSTMENT', 'WRITE_OFF']);

function tone(mov: BatchMovement) {
  if (OUT_OF_THE_ORDINARY.has(mov.movementType)) return 'bg-accent-100 text-accent-800';
  return Number(mov.qtyDelta) >= 0 ? 'bg-success/10 text-success' : 'bg-primary-100 text-primary-700';
}

function MovementIcon({ mov }: { mov: BatchMovement }) {
  if (OUT_OF_THE_ORDINARY.has(mov.movementType)) return <AlertTriangle className="h-3.5 w-3.5 shrink-0" />;
  return Number(mov.qtyDelta) >= 0 ? (
    <ArrowDownRight className="h-3.5 w-3.5 shrink-0 rtl:-scale-x-100" />
  ) : (
    <ArrowUpRight className="h-3.5 w-3.5 shrink-0 rtl:-scale-x-100" />
  );
}

/** One movement while loading: the badge and quantity, the date and record under. */
function MovementRowSkeleton() {
  return (
    <li data-testid="skeleton-row" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-muted bg-card px-3 py-2">
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-24 rounded-full" />
        <SkeletonText className="w-6" />
      </div>
      <div className="flex items-center gap-3">
        <SkeletonText size="xs" className="w-28" />
        <SkeletonText size="xs" className="w-24" />
      </div>
    </li>
  );
}

export function BatchMovementList({
  movements,
  loading = false,
}: {
  movements: readonly BatchMovement[];
  loading?: boolean;
}) {
  const t = useTranslations('inventory');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();

  if (loading) {
    return (
      <>
        <LoadingStatus />
        <SkeletonGroup as="ul" className="space-y-2">
          {repeat(2, (i) => <MovementRowSkeleton key={i} />)}
        </SkeletonGroup>
      </>
    );
  }
  if (movements.length === 0) {
    return <EmptyState size="compact" icon={null} title={t('noMovementsTitle')} />;
  }

  return (
    <ul data-testid="batch-movements" className="space-y-2">
      {movements.map((mov) => {
        const qty = Number(mov.qtyDelta);
        const href = referenceHref(mov.reference);
        return (
          <li
            key={mov.id}
            data-testid="batch-movement"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"
          >
            <div className="order-1 flex min-w-0 items-center gap-2">
              <span className={cn('inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tone(mov))}>
                <MovementIcon mov={mov} />
                <span className="truncate">{codeLabel('movementType', mov.movementType)}</span>
              </span>
              <bdi dir="ltr" className={cn('font-medium tabular-nums', qty >= 0 ? 'text-success' : 'text-destructive')}>
                {qty >= 0 ? '+' : '−'}
                {formatNumber(Math.abs(qty))}
              </bdi>
            </div>
            {/* A phone: the date at the end of the first line, the record on a
                line of its own. Wider: one line, the record then the date at the end. */}
            <span className={cn('order-2 ms-auto whitespace-nowrap text-xs text-muted-foreground sm:order-3', mov.referenceType && 'sm:ms-0')}>
              {formatDate(mov.occurredAt, { includeTime: true })}
            </span>
            {mov.referenceType && (
              <span data-testid="movement-record" className="order-3 basis-full text-xs text-muted-foreground sm:order-2 sm:ms-auto sm:basis-auto">
                {codeLabel('referenceType', mov.referenceType)}
                {mov.reference && (
                  <>
                    {' '}
                    {href ? (
                      <Link
                        href={href}
                        data-testid="movement-reference"
                        className="font-mono font-medium text-primary-600 hover:text-primary-700 hover:underline"
                      >
                        <bdi dir="ltr">{mov.reference.number}</bdi>
                      </Link>
                    ) : (
                      <bdi dir="ltr" className="font-mono">{mov.reference.number}</bdi>
                    )}
                  </>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
