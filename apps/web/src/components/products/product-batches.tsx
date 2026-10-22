'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { cn } from '@/lib/utils';
import { Money } from '@/components/ui/money';
import { EmptyState } from '@/components/ui/empty-state';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { ChevronDown, Layers } from '@/components/ui/icons';
import { BatchMovementList, type BatchMovement } from '@/components/inventory/batch-movements';

/**
 * A product's stock, one batch a line, on the product page (2026-10-22 audit).
 *
 * - Desktop (md and up): the shared table, one column per figure under its own
 *   header, the whole width of the page. It used to be one button per batch
 *   with "Label: value" pairs side by side, each wrapping onto two lines even
 *   at 1440 and clipped past the card on a phone.
 * - Phone: a card per batch, each figure on its own labelled line.
 *
 * Opening a batch shows its movements under it, and only there — the page
 * used to repeat them in a Movement History card of their own.
 *
 * "Received" is the quantity; the day it went into stock is "Checked in", the
 * cycle page's word for it ("not checked in yet"), so the two never share a
 * label.
 */

export interface ProductBatch {
  id: string;
  cycleId: string;
  cycle?: { code: string } | null;
  receivedQty: number | string;
  remainingQty: number | string;
  landedUnitCostEgp: number | string;
  /** When the shipment landed. Null until the shipping leg carries a date. */
  arrivedOn?: string | null;
  /** When it was verified into stock — the order FIFO consumes in. */
  receivedAt?: string | null;
}

function useBatchLabels() {
  const t = useTranslations('products');
  const tInv = useTranslations('inventory');
  return {
    cycle: t('cycle'),
    received: t('receivedQty'),
    remaining: t('remainingQty'),
    landedCost: t('landedCost'),
    arrived: tInv('arrived'),
    arrivedHint: tInv('arrivedHint'),
    checkedIn: t('checkedIn'),
    checkedInHint: tInv('receivedHint'),
  };
}

/** The card's heading, the same in the page, its skeleton and every state. */
function Heading() {
  const t = useTranslations('products');
  return (
    <h2 className="mb-4 flex items-center gap-2 px-5 pt-5 text-sm font-semibold text-foreground">
      <Layers className="h-4 w-4 text-muted-foreground" />
      {t('inventoryBatches')}
    </h2>
  );
}

// Sized for their content in both languages at md (≈720px of content with or
// without the sidebar; 718px at 1024 beside it): the figures add to 41.5rem,
// 44.75rem with the toggle, and sit together from the
// start; the toggle takes what is left, so its chevron is at the row's end and
// a wide screen does not spread the figures apart (a 546px cycle column at
// 1440 put the code half a page away from its numbers).
const WIDTHS = {
  cycle: '8.75rem',
  received: '5.25rem',
  remaining: '5.25rem',
  landedCost: '7.25rem',
  arrived: '7.5rem',
  checkedIn: '7.5rem',
  toggle: 'auto',
} as const;
const AUTO_MIN = '3.25rem';

export function ProductBatches({ batches }: { batches: readonly ProductBatch[] }) {
  const t = useTranslations('products');
  const tInv = useTranslations('inventory');
  const labels = useBatchLabels();
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id));

  const { data, isLoading } = useQuery({
    queryKey: ['batchMovements', expanded],
    queryFn: () => api.get(`/inventory/batches/${expanded}/movements`).then((r) => r.data.data ?? r.data),
    enabled: !!expanded,
  });
  const movements: BatchMovement[] = Array.isArray(data) ? data : [];
  const movementList = <BatchMovementList movements={movements} loading={isLoading} />;

  const arrived = (b: ProductBatch) => (b.arrivedOn ? formatDate(b.arrivedOn) : tInv('notArrivedYet'));
  const cycleCode = (b: ProductBatch) => <bdi dir="ltr" className="font-mono">{b.cycle?.code ?? '—'}</bdi>;

  const ToggleIcon = ({ open }: { open: boolean }) => (
    <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')} />
  );

  const columns: Column<ProductBatch>[] = [
    { key: 'cycle', header: labels.cycle, width: WIDTHS.cycle, kind: 'label', cell: cycleCode, className: 'font-medium text-foreground', title: (b) => b.cycle?.code },
    { key: 'received', header: labels.received, width: WIDTHS.received, kind: 'value', align: 'end', cell: (b) => formatNumber(b.receivedQty) },
    { key: 'remaining', header: labels.remaining, width: WIDTHS.remaining, kind: 'value', align: 'end', className: 'font-medium text-foreground', cell: (b) => formatNumber(b.remainingQty) },
    { key: 'landedCost', header: labels.landedCost, width: WIDTHS.landedCost, kind: 'value', align: 'end', cell: (b) => <Money value={b.landedUnitCostEgp} /> },
    { key: 'arrived', header: labels.arrived, headerTitle: labels.arrivedHint, width: WIDTHS.arrived, kind: 'value', className: 'text-muted-foreground', cell: arrived },
    { key: 'checkedIn', header: labels.checkedIn, headerTitle: labels.checkedInHint, width: WIDTHS.checkedIn, kind: 'value', className: 'text-muted-foreground', cell: (b) => formatDate(b.receivedAt) },
    {
      key: 'toggle',
      header: <span className="sr-only">{tInv('movements')}</span>,
      width: WIDTHS.toggle,
      align: 'end',
      skeleton: { kind: 'none' },
      cell: (b) => (
        <button
          type="button"
          aria-expanded={expanded === b.id}
          aria-label={t('batchMovements', { cycle: b.cycle?.code ?? '—' })}
          data-testid="batch-toggle"
          onClick={(e) => {
            e.stopPropagation();
            toggle(b.id);
          }}
          className="-my-1 inline-flex size-6 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ToggleIcon open={expanded === b.id} />
        </button>
      ),
    },
  ];

  return (
    <section data-testid="product-batches" className="rounded-xl border border-border bg-card">
      <Heading />
      {batches.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyState size="compact" icon={Layers} title={t('noBatchesTitle')} description={t('noBatchesHint')} />
        </div>
      ) : (
        <>
          {/* Desktop: the shared table, flush with the card's sides. */}
          <DataTable
            className="hidden md:block"
            tableTestId="batches-table"
            frame="none"
            density="dense"
            autoMin={AUTO_MIN}
            columns={columns}
            rows={batches}
            rowKey={(b) => b.id}
            onRowClick={(b) => toggle(b.id)}
            rowProps={(b) => ({ 'data-testid': 'batch-row', 'data-expanded': expanded === b.id ? 'true' : undefined })}
            rowClassName={(b) => (expanded === b.id ? 'bg-muted/50' : undefined)}
            afterRow={(b) =>
              expanded === b.id ? (
                <tr data-testid="batch-movements-row">
                  <td colSpan={columns.length} className="bg-muted/50 px-4 pb-4 pt-1">
                    {movementList}
                  </td>
                </tr>
              ) : null
            }
          />

          {/* Phone: a card per batch, a figure a line. */}
          <ul className="space-y-3 px-4 pb-4 md:hidden" data-testid="batch-cards">
            {batches.map((b) => {
              const open = expanded === b.id;
              return (
                <li key={b.id} data-testid="batch-card" className="overflow-hidden rounded-lg border border-border">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggle(b.id)}
                    className="w-full px-4 py-3 text-start hover:bg-muted/50"
                  >
                    <dl className="space-y-1.5 text-sm">
                      <Line label={labels.cycle} strong end={<ToggleIcon open={open} />}>
                        {cycleCode(b)}
                      </Line>
                      <Line label={labels.received}>{formatNumber(b.receivedQty)}</Line>
                      <Line label={labels.remaining} strong>{formatNumber(b.remainingQty)}</Line>
                      <Line label={labels.landedCost}><Money value={b.landedUnitCostEgp} /></Line>
                      <Line label={labels.arrived}>{arrived(b)}</Line>
                      <Line label={labels.checkedIn}>{formatDate(b.receivedAt)}</Line>
                    </dl>
                  </button>
                  {open && (
                    <div data-testid="batch-card-movements" className="border-t border-border bg-muted/50 p-3">
                      {movementList}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** A label at the start, its value at the end, on one line. */
function Line({ label, children, strong = false, end }: { label: string; children: ReactNode; strong?: boolean; end?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('flex items-center gap-2 whitespace-nowrap tabular-nums', strong ? 'font-medium text-foreground' : 'text-foreground')}>
        {children}
        {end && <span className="text-muted-foreground">{end}</span>}
      </dd>
    </div>
  );
}

/** The card above while the stock loads: the same heading, the table's rows on desktop, the cards on a phone. */
export function ProductBatchesSkeleton() {
  const labels = useBatchLabels();
  const columns: Column<ProductBatch>[] = [
    { key: 'cycle', header: labels.cycle, width: WIDTHS.cycle, cell: () => null, skeleton: { kind: 'text', share: 'w-28' } },
    { key: 'received', header: labels.received, width: WIDTHS.received, align: 'end', cell: () => null, skeleton: { kind: 'text', share: 'w-8' } },
    { key: 'remaining', header: labels.remaining, width: WIDTHS.remaining, align: 'end', cell: () => null, skeleton: { kind: 'text', share: 'w-8' } },
    { key: 'landedCost', header: labels.landedCost, width: WIDTHS.landedCost, align: 'end', cell: () => null, skeleton: { kind: 'text', share: 'w-20' } },
    { key: 'arrived', header: labels.arrived, width: WIDTHS.arrived, cell: () => null, skeleton: { kind: 'text', share: 'w-20' } },
    { key: 'checkedIn', header: labels.checkedIn, width: WIDTHS.checkedIn, cell: () => null, skeleton: { kind: 'text', share: 'w-20' } },
    { key: 'toggle', header: '', width: WIDTHS.toggle, cell: () => null, skeleton: { kind: 'custom', render: () => <Skeleton className="ms-auto size-4 rounded" /> } },
  ];
  return (
    <div className="rounded-xl border border-border bg-card">
      <Heading />
      <DataTable
        className="hidden md:block"
        frame="none"
        density="dense"
        autoMin={AUTO_MIN}
        columns={columns}
        rows={[]}
        rowKey={(b) => b.id}
        isLoading
        skeletonRows={2}
        skeletonRowTestId={null}
      />
      <SkeletonGroup as="ul" className="space-y-3 px-4 pb-4 md:hidden">
        {repeat(2, (i) => (
          <li key={i} className="rounded-lg border border-border px-4 py-3">
            <div className="space-y-1.5">
              {repeat(6, (j) => (
                <div key={j} className="flex items-center justify-between gap-3">
                  <SkeletonText className="w-20" />
                  <SkeletonText className={j === 0 ? 'w-32' : 'w-16'} />
                </div>
              ))}
            </div>
          </li>
        ))}
      </SkeletonGroup>
    </div>
  );
}
