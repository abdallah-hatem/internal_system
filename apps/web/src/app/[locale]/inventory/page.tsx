'use client';
import { NoMatch } from '@/components/ui/no-match';
import { localName, matchesName } from '@/lib/localized-name';
import { ProductLink } from '../../../components/ui/entity-link';
import { BatchRef } from '../../../components/ui/batch-ref';
import { Money } from '../../../components/ui/money';

import { useTranslations, useLocale } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { isBelowMinStock } from '@/lib/low-stock';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { ReceiveStockList } from '../../../components/shipment/ReceiveStockList';
import { Suspense, useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import {
  Search, ChevronDown, AlertTriangle,
  ArrowUpDown, CheckCircle2, Clock, PackageCheck,
} from 'lucide-react';
import { useCodeLabel } from '@/lib/labels';
import { useCan } from '@/lib/can';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingStatus, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/ui/data-table';

// ─── Types ────────────────────────────────────────────────────────────
interface InventorySummary {
  productId: string;
  productName: string;
  /** The Arabic name, null when none was entered (§3, 2026-10-14). */
  productNameAr?: string | null;
  totalStock: number;
  reservedStock: number;
  availableStock: number;
  batches: any[];
}

interface Movement {
  id: string;
  movementType: string;
  qtyDelta: number;
  occurredAt: string;
  referenceType?: string;
  referenceId?: string;
}

// ─── Skeletons ────────────────────────────────────────────────────────
// The table's skeleton rows are drawn by DataTable from each column's
// `skeleton`; the phone card below is traced by hand: the name and three
// counts. Change one, change the other.

function InventoryCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="p-4">
        <SkeletonText size="base" className="w-2/3" />
        <div className="grid grid-cols-3 gap-3 mt-3">
          {repeat(3, (i) => (
            <div key={i}>
              {/* A text-xs label inline in a text-sm cell: an 18px line. */}
              <SkeletonText size="xs" className="w-14" lineClassName="h-[18px]" />
              <SkeletonText className="w-8" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
/**
 * Reads `?stock=low` (the dashboard's Low stock tile) to show only products
 * under their minimum. `useSearchParams` cannot be prerendered, so Next
 * requires a Suspense boundary or `next build` fails on this page.
 */
export default function InventoryPage() {
  return (
    <Suspense fallback={null}>
      <InventoryPageContent />
    </Suspense>
  );
}

function InventoryPageContent() {
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const t = useTranslations('inventory');
  const tc = useTranslations('common');
  const td = useTranslations('dashboard');
  const router = useRouter();
  const locale = useLocale();
  const lowOnly = useSearchParams().get('stock') === 'low';

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  // "Receive stock" replaced a dialog that asked for product IDs typed by hand
  // (UX #4): it now lists the deliveries waiting to be counted in.
  const [showReceive, setShowReceive] = useState(false);
  // Receiving is a partner's act (POST /receipts/verify); an investor reads
  // the stock and is not offered the list of deliveries to receive (R1b).
  const canReceive = useCan('inventory.receive');
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, lowOnly]);

  // ── Queries ───────────────────────────────────────────────────────
  const { data: inventory = [], isLoading } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => api.get('/inventory').then((r) => r.data.data ?? r.data),
  });

  const { data: movements = [] } = useQuery({
    queryKey: ['inventoryMovements', selectedBatchId],
    queryFn: () =>
      api.get(`/inventory/batches/${selectedBatchId}/movements`).then((r) => r.data.data ?? r.data),
    enabled: !!selectedBatchId,
  });

  // ── Derived ───────────────────────────────────────────────────────
  const inventoryList: InventorySummary[] = Array.isArray(inventory) ? inventory : [];
  const movementList: Movement[] = Array.isArray(movements) ? movements : [];

  const filtered = inventoryList.filter((item) => {
    if (lowOnly && !isBelowMinStock(item)) return false;
    if (!search) return true;
    // Either language (§3, 2026-10-14).
    return matchesName({ name: item.productName, nameAr: item.productNameAr }, search);
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  // Nothing at all says what goes here and offers the first one; nothing for
  // this search or filter says only that (UX #12).
  const emptyList =
    inventoryList.length === 0 ? (
      <EmptyState
        title={t('emptyTitle')}
        description={t('emptyHint')}
        action={{ label: t('emptyAction'), href: '/cycles' }}
      />
    ) : (
      <NoMatch onClear={() => setSearch('')} />
    );

  // ── Columns ───────────────────────────────────────────────────────
  // The chevron, product, total, reserved, available, batches
  // (components/ui/data-table.tsx). Each fixed column fits its title in
  // English and Arabic; the product takes what is left.
  const columns: Column<InventorySummary>[] = [
    {
      key: 'expand', header: null, width: '3rem', skeleton: { kind: 'text', share: 'w-4' },
      cell: (item) => (
        <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${expandedProduct === item.productId ? 'rotate-180' : ''}`} />
      ),
    },
    {
      key: 'product', header: t('product'), width: 'auto',
      cell: (item) => {
        const name = localName({ name: item.productName, nameAr: item.productNameAr }, locale);
        return (
          // The name wraps to two lines and is cut after them; the badge keeps its line.
          <div className="flex items-center gap-2" title={name}>
            <p className="min-w-0 font-medium text-gray-900 line-clamp-2 break-words">
              <ProductLink id={item.productId} name={name} />
            </p>
            {isBelowMinStock(item) && (
              <span data-testid="low-stock-badge" className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-red-600 bg-red-100 rounded-full px-2 py-0.5">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" /> {t('low')}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'totalStock', header: t('totalStock'), width: '8rem', kind: 'value', className: 'font-medium text-gray-900',
      skeleton: { kind: 'text', share: 'w-1/4' }, cell: (item) => item.totalStock,
    },
    {
      key: 'reserved', header: t('reserved'), width: '7rem', kind: 'value', className: 'text-gray-600',
      skeleton: { kind: 'text', share: 'w-1/4' }, cell: (item) => item.reservedStock,
    },
    {
      key: 'available', header: t('available'), width: '7rem', kind: 'value',
      className: (item) => `font-medium ${isBelowMinStock(item) ? 'text-red-600' : 'text-green-600'}`,
      skeleton: { kind: 'text', share: 'w-1/4' }, cell: (item) => item.availableStock,
    },
    {
      key: 'batches', header: t('batches'), width: '7rem', kind: 'value', className: 'text-gray-600',
      skeleton: { kind: 'text', share: 'w-1/5' }, cell: (item) => item.batches?.length ?? 0,
    },
  ];

  // A product's batches, opened under its row: batch, cycle, arrived,
  // received, remaining, landed cost, verification, actions. The cycle takes
  // what is left.
  const batchColumns: Column<InventorySummary['batches'][number]>[] = [
    {
      key: 'batch', header: t('batch'), width: '6.5rem', kind: 'value', className: 'font-mono text-xs text-gray-600',
      cell: (batch) => <BatchRef id={batch.id} />,
    },
    {
      key: 'cycle', header: t('cycle'), width: 'auto', kind: 'label', className: 'text-gray-600',
      title: (batch) => batch.cycle?.code, cell: (batch) => batch.cycle?.code ?? '—',
    },
    {
      // Dated from the shipping leg, so it is empty until the leg is dated —
      // said plainly rather than shown as a dash, which reads as "no data"
      // when it means "nobody entered it yet".
      key: 'arrived', header: t('arrived'), headerTitle: t('arrivedHint'), width: '7.5rem', kind: 'value', className: 'text-gray-600',
      cell: (batch) => (batch.arrivedOn ? formatDate(batch.arrivedOn) : <span className="text-gray-400">{t('notArrivedYet')}</span>),
    },
    {
      key: 'received', header: t('received'), headerTitle: t('receivedHint'), width: '8rem', kind: 'value', className: 'text-gray-600',
      cell: (batch) => formatDate(batch.receivedAt),
    },
    {
      key: 'remaining', header: t('remaining'), width: '6rem', kind: 'value', className: 'font-medium text-gray-900',
      cell: (batch) => batch.remainingQty,
    },
    {
      key: 'landedCost', header: t('landedCost'), width: '8.5rem', kind: 'value', className: 'text-gray-600',
      cell: (batch) => <Money value={batch.landedUnitCostEgp} />,
    },
    {
      key: 'verification', header: t('verificationStatus'), width: '7rem',
      cell: (batch) => <VerificationBadge status={batch.verificationStatus} />,
    },
    {
      key: 'actions', header: tc('actions'), width: '7.5rem',
      cell: (batch) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setSelectedBatchId(selectedBatchId === batch.id ? null : batch.id);
          }}
          className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-primary-600 hover:text-primary-700 font-medium"
        >
          <ArrowUpDown className="h-3.5 w-3.5" /> {t('movements')}
        </button>
      ),
    },
  ];

  /** The row under an opened product: its batches, and a batch's movements. */
  const batchesRow = (item: InventorySummary) =>
    expandedProduct === item.productId && (
      <tr>
        <td colSpan={columns.length} className="px-4 py-4 bg-gray-50">
          {(item.batches ?? []).length === 0 ? (
            <EmptyState size="compact" icon={null} title={t('noBatchesTitle')} />
          ) : (
            <div className="space-y-3">
              <DataTable
                frame="none"
                density="compact"
                autoMin="8rem"
                columns={batchColumns}
                rows={item.batches ?? []}
                rowKey={(batch) => batch.id}
                rowClassName={() => 'hover:bg-white'}
              />

              {/* Movements */}
              {selectedBatchId && (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h4 className="text-sm font-semibold text-gray-900 mb-3">{t('movements')}</h4>
                  {movementList.length === 0 ? (
                    <EmptyState size="compact" icon={null} title={t('noMovementsTitle')} />
                  ) : (
                    <div className="space-y-2">
                      {movementList.map((mov) => (
                        <div key={mov.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm">
                          <div className="flex items-center gap-2">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                              mov.movementType === 'RECEIVE' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                            }`}>
                              {codeLabel('movementType', mov.movementType)}
                            </span>
                            <span className="text-gray-700">{mov.qtyDelta}</span>
                          </div>
                          <div className="text-right">
                            <span className="text-gray-500 text-xs">{formatDate(mov.occurredAt)}</span>
                            {(mov.referenceType || mov.referenceId) && <p className="text-xs text-gray-400">{codeLabel('referenceType', mov.referenceType)}{mov.referenceId ? ` (${mov.referenceId})` : ''}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </td>
      </tr>
    );

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        {canReceive && (
        <button
          type="button"
          data-testid="receive-stock-toggle"
          aria-expanded={showReceive}
          onClick={() => setShowReceive((v) => !v)}
          className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <PackageCheck className="h-4 w-4" aria-hidden="true" />
          {t('receiveStock')}
        </button>
        )}
      </div>

      {canReceive && showReceive && <ReceiveStockList />}

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          placeholder={t('search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full ps-10 pe-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      </div>

      {lowOnly && (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="low-stock-chip">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 font-medium text-destructive">
            <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
            {td('showingLowStock')}
          </span>
          <button
            type="button"
            onClick={() => router.replace(`/${locale}/inventory`, { scroll: false })}
            className="min-h-11 cursor-pointer px-2 text-primary hover:underline sm:min-h-0"
          >
            {td('showAll')}
          </button>
        </div>
      )}

      {/* Loading: the table's own header over skeleton rows, skeleton cards on a phone. */}
      {isLoading && <LoadingStatus />}

      {/* Desktop Table — the shared one (components/ui/data-table.tsx). */}
      <DataTable
        className="hidden md:block"
        columns={columns}
        rows={paginated}
        rowKey={(item) => item.productId}
        isLoading={isLoading}
        empty={emptyList}
        onRowClick={(item) => setExpandedProduct(expandedProduct === item.productId ? null : item.productId)}
        rowClassName={(item) => (isBelowMinStock(item) ? 'bg-red-50/50' : undefined)}
        rowProps={(item) => ({
          'data-testid': 'inventory-row',
          'data-product': item.productName,
          'data-low': isBelowMinStock(item) ? 'true' : 'false',
        })}
        afterRow={batchesRow}
      />

      {/* Mobile Cards */}
      {isLoading && (
        <SkeletonGroup className="md:hidden space-y-3">
          {repeat(PAGE_SIZE, (i) => <InventoryCardSkeleton key={i} />)}
        </SkeletonGroup>
      )}
      {!isLoading && (
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200">{emptyList}</div>
          ) : (
            paginated.map((item) => {
              const isExpanded = expandedProduct === item.productId;
              const isLow = isBelowMinStock(item);
              return (
                <div key={item.productId} className={`bg-white rounded-xl border border-gray-200 overflow-hidden ${isLow ? 'border-red-200' : ''}`}>
                  <div
                    onClick={() => setExpandedProduct(isExpanded ? null : item.productId)}
                    className="p-4 cursor-pointer"
                  >
                    <div className="flex items-start justify-between">
                       <div>
                        <p className="font-medium text-gray-900">
                          <ProductLink id={item.productId} name={localName({ name: item.productName, nameAr: item.productNameAr }, locale)} />
                        </p>
                      </div>
                      {isLow && (
                        <span data-testid="low-stock-badge" className="inline-flex items-center gap-1 text-xs text-red-600 bg-red-100 rounded-full px-2 py-0.5">
                          <AlertTriangle className="h-3 w-3" aria-hidden="true" /> {t('low')}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-3 mt-3 text-sm">
                      <div>
                        <span className="text-gray-500 text-xs">{t('totalStock')}</span>
                        <p className="font-medium">{item.totalStock}</p>
                      </div>
                       <div>
                        <span className="text-gray-500 text-xs">{t('available')}</span>
                        <p className={`font-medium ${isLow ? 'text-red-600' : 'text-green-600'}`}>{item.availableStock}</p>
                      </div>
                      <div>
                        <span className="text-gray-500 text-xs">{t('batches')}</span>
                        <p className="font-medium">{item.batches?.length ?? 0}</p>
                      </div>
                    </div>
                  </div>

                  {isExpanded && (item.batches ?? []).length > 0 && (
                    <div className="border-t border-gray-200 bg-gray-50 p-4 space-y-2">
                      {(item.batches ?? []).map((batch: any) => (
                        <div key={batch.id} className="bg-white rounded-lg p-3 text-sm">
                          <div className="flex items-center justify-between">
                            <BatchRef id={batch.id} className="font-mono text-xs text-gray-500" />
                            <VerificationBadge status={batch.verificationStatus} />
                          </div>
                          <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
                            <div>
                              <span className="text-gray-500">{t('cycle')}:</span>{' '}
                              <span className="font-medium">{batch.cycle?.code ?? '—'}</span>
                            </div>
                             <div>
                              <span className="text-gray-500">{t('remaining')}:</span>{' '}
                              <span className="font-medium">{batch.remainingQty}</span>
                            </div>
                            <div>
                              <span className="text-gray-500">{t('landedCost')}:</span>{' '}
                              <span className="font-medium"><Money value={batch.landedUnitCostEgp} /></span>
                            </div>
                            {/* Same two dates as the desktop table — the phone
                                view is the one used on a warehouse floor, which
                                is exactly where "how long has this been here"
                                gets asked. */}
                            <div>
                              <span className="text-gray-500">{t('arrived')}:</span>{' '}
                              <span className="font-medium">
                                {batch.arrivedOn ? formatDate(batch.arrivedOn) : t('notArrivedYet')}
                              </span>
                            </div>
                            <div>
                              <span className="text-gray-500">{t('received')}:</span>{' '}
                              <span className="font-medium">{formatDate(batch.receivedAt)}</span>
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedBatchId(selectedBatchId === batch.id ? null : batch.id);
                            }}
                            className="mt-2 inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
                          >
                            <ArrowUpDown className="h-3.5 w-3.5" /> {t('movements')}
                          </button>

                          {selectedBatchId === batch.id && movementList.length > 0 && (
                            <div className="mt-2 space-y-1 border-t border-gray-100 pt-2">
                              {movementList.map((mov) => (
                                <div key={mov.id} className="flex items-center justify-between text-xs bg-gray-50 rounded px-2 py-1.5">
                                   <span className={`px-1.5 py-0.5 rounded-full font-medium ${
                                    mov.movementType === 'RECEIVE' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                                  }`}>
                                    {codeLabel('movementType', mov.movementType)}
                                  </span>
                                  <span>{mov.qtyDelta}</span>
                                  <span className="text-gray-500">{formatDate(mov.occurredAt)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Pagination */}
      {!isLoading && filtered.length > 0 && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} totalItems={filtered.length} />
      )}

    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

import { useDateFormat } from '../../../lib/dates';
function VerificationBadge({ status }: { status: string }) {
  const t = useTranslations('inventory');
  if (status === 'VERIFIED') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
        <CheckCircle2 className="h-3 w-3" /> {t('verified')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
      <Clock className="h-3 w-3" /> {t('pending')}
    </span>
  );
}
