'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useCodeLabel } from '@/lib/labels';
import { useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { viewPath } from '@/lib/page-views';
import { cn } from '@/lib/utils';
import { Money } from '@/components/ui/money';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { AlertTriangle, ArrowDownRight, ArrowUpRight } from '@/components/ui/icons';

/**
 * One batch's stock movements, each naming the record it came from by the
 * number a person knows it by — ORD-…, RET-…, PO-… — as a link that opens it
 * (2026-10-22). The screens used to print the database id: "Sale order
 * (4d2d3158-…)". The API sends the numbers (`reference`), so this asks nothing.
 *
 * Since 2026-11-06 (owner: "in movement I want to see the customer name and
 * the price") each row also says who it went to or came back from, and the
 * price per unit: charged on a sale, refunded on a return, and on a receipt
 * the landed cost — marked "cost" so it is never read as a selling price.
 * Samples went at no price, and say "—". The API resolves both.
 *
 * Shared by the product page and the inventory page: the same list, written once.
 * `layout`: the shared table, the row cards, or the table from md up and the
 * cards below it. The product page picks one per place it sits (its desktop
 * table row, its phone card), so the list is never in the page twice.
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
  /** The order's customer; null for the walk-in record, a receipt, a transfer. */
  customerName?: string | null;
  /** The shared walk-in record: said as "Walk-in", never by its stored name. */
  walkIn?: boolean;
  branchName?: string | null;
  /** Per unit, in `currency`. Null: nothing to show ("—"). */
  unitPrice?: string | null;
  priceKind?: 'sale' | 'refund' | 'cost' | null;
  currency?: string | null;
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

// Sized at text-sm in both languages: "+1,000" beside "Sample back" / "عودة
// عينة"; "1,234,567.89 EGP" with "cost" under it; a record's label over its
// number; a date with its time. The customer takes the rest.
const WIDTHS = {
  movement: '10.5rem',
  customer: 'auto',
  price: '9rem',
  record: '8.5rem',
  date: '9.75rem',
} as const;

function useMovementParts() {
  const t = useTranslations('inventory');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();

  const movement = (mov: BatchMovement) => {
    const qty = Number(mov.qtyDelta);
    return (
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn('inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tone(mov))}>
          <MovementIcon mov={mov} />
          <span className="truncate">{codeLabel('movementType', mov.movementType)}</span>
        </span>
        <bdi dir="ltr" className={cn('font-medium tabular-nums', qty >= 0 ? 'text-success' : 'text-destructive')}>
          {qty >= 0 ? '+' : '−'}
          {formatNumber(Math.abs(qty))}
        </bdi>
      </span>
    );
  };

  const customerText = (mov: BatchMovement) => (mov.walkIn ? t('movementWalkIn') : (mov.customerName ?? null));

  const customer = (mov: BatchMovement) => {
    const name = customerText(mov);
    if (!name) return <span className="text-muted-foreground">—</span>;
    return (
      <span data-testid="movement-customer" className="block min-w-0">
        <span className="block truncate font-medium text-foreground">{name}</span>
        {mov.branchName && (
          <span data-testid="movement-branch" className="block truncate text-xs text-muted-foreground">
            {mov.branchName}
          </span>
        )}
      </span>
    );
  };

  const price = (mov: BatchMovement) => {
    if (!mov.unitPrice || !mov.priceKind) {
      return (
        <span data-testid="movement-price" className="text-muted-foreground">
          —
        </span>
      );
    }
    return (
      <span data-testid="movement-price" data-kind={mov.priceKind} className="whitespace-nowrap">
        <Money
          value={mov.unitPrice}
          currency={mov.currency ?? undefined}
          className={mov.priceKind === 'cost' ? 'text-muted-foreground' : 'font-medium text-foreground'}
        />
        {mov.priceKind === 'cost' && (
          <>
            {' '}
            <span data-testid="movement-cost-label" title={t('movementCostHint')} className="text-xs text-muted-foreground">
              {t('movementCost')}
            </span>
          </>
        )}
      </span>
    );
  };

  const record = (mov: BatchMovement) => {
    if (!mov.referenceType) return <span className="text-muted-foreground">—</span>;
    const href = referenceHref(mov.reference);
    return (
      <span data-testid="movement-record" className="block min-w-0 text-xs text-muted-foreground">
        <span className="block truncate">{codeLabel('referenceType', mov.referenceType)}</span>
        {mov.reference &&
          (href ? (
            <Link
              href={href}
              data-testid="movement-reference"
              className="font-mono font-medium text-primary-600 hover:text-primary-700 hover:underline"
            >
              <bdi dir="ltr">{mov.reference.number}</bdi>
            </Link>
          ) : (
            <bdi dir="ltr" className="font-mono">
              {mov.reference.number}
            </bdi>
          ))}
      </span>
    );
  };

  const date = (mov: BatchMovement) => formatDate(mov.occurredAt, { includeTime: true });

  return { t, movement, customer, customerText, price, record, date };
}

/** The shared table: one column per thing a movement says. */
function MovementTable({ movements, loading }: { movements: readonly BatchMovement[]; loading: boolean }) {
  const parts = useMovementParts();
  const { t } = parts;
  const columns: Column<BatchMovement>[] = [
    { key: 'movement', header: t('movementColumn'), width: WIDTHS.movement, kind: 'plain', cell: parts.movement, skeleton: { kind: 'pill', share: 'w-3/4' } },
    {
      key: 'customer',
      header: t('movementCustomer'),
      width: WIDTHS.customer,
      kind: 'plain',
      cell: parts.customer,
      title: (m) => [parts.customerText(m), m.branchName].filter(Boolean).join(' · ') || null,
      skeleton: { kind: 'text', share: 'w-1/2' },
    },
    {
      key: 'price',
      header: t('movementPrice'),
      headerTitle: t('movementPriceHint'),
      width: WIDTHS.price,
      kind: 'value',
      align: 'end',
      cell: parts.price,
      skeleton: { kind: 'text', share: 'w-2/3' },
    },
    { key: 'record', header: t('movementRecord'), width: WIDTHS.record, kind: 'plain', cell: parts.record, skeleton: { kind: 'text', share: 'w-3/4', size: 'xs' } },
    { key: 'date', header: t('movementDate'), width: WIDTHS.date, kind: 'value', className: 'text-xs text-muted-foreground', cell: parts.date, skeleton: { kind: 'text', share: 'w-3/4', size: 'xs' } },
  ];
  return (
    <DataTable
      tableTestId="batch-movements"
      density="compact"
      autoMin="7rem"
      columns={columns}
      rows={movements}
      rowKey={(m) => m.id}
      isLoading={loading}
      skeletonRows={2}
      rowProps={() => ({ 'data-testid': 'batch-movement' })}
    />
  );
}

/** One movement while loading: the badge and quantity, the date, the customer and price, the record. */
function MovementCardSkeleton() {
  return (
    <li data-testid="skeleton-row" className="space-y-1.5 rounded-lg border border-muted bg-card px-3 py-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-24 rounded-full" />
          <SkeletonText className="w-6" />
        </div>
        <SkeletonText size="xs" className="w-28" />
      </div>
      <div className="flex items-center justify-between gap-4">
        <SkeletonText className="w-32" />
        <SkeletonText className="w-20" />
      </div>
      <SkeletonText size="xs" className="w-24" />
    </li>
  );
}

/** A card a movement: the badge and date, then the customer and price, then the record. */
function MovementCards({ movements, loading }: { movements: readonly BatchMovement[]; loading: boolean }) {
  const parts = useMovementParts();
  if (loading) {
    return (
      <SkeletonGroup as="ul" className="space-y-2">
        {repeat(2, (i) => <MovementCardSkeleton key={i} />)}
      </SkeletonGroup>
    );
  }
  return (
    <ul data-testid="batch-movement-cards" className="space-y-2">
      {movements.map((mov) => (
        <li key={mov.id} data-testid="batch-movement" className="space-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            {parts.movement(mov)}
            <span className="whitespace-nowrap text-xs text-muted-foreground">{parts.date(mov)}</span>
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">{parts.customer(mov)}</div>
            <div className="shrink-0 text-end">{parts.price(mov)}</div>
          </div>
          {mov.referenceType && <div>{parts.record(mov)}</div>}
        </li>
      ))}
    </ul>
  );
}

export function BatchMovementList({
  movements,
  loading = false,
  layout = 'responsive',
}: {
  movements: readonly BatchMovement[];
  loading?: boolean;
  layout?: 'table' | 'cards' | 'responsive';
}) {
  const t = useTranslations('inventory');

  if (!loading && movements.length === 0) {
    return <EmptyState size="compact" icon={null} title={t('noMovementsTitle')} />;
  }

  const table = <MovementTable movements={movements} loading={loading} />;
  const cards = <MovementCards movements={movements} loading={loading} />;
  return (
    <>
      {loading && <LoadingStatus />}
      {layout === 'table' && table}
      {layout === 'cards' && cards}
      {layout === 'responsive' && (
        <>
          <div className="hidden md:block">{table}</div>
          <div className="md:hidden">{cards}</div>
        </>
      )}
    </>
  );
}
