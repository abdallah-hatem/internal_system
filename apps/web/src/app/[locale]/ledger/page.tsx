'use client';
import { NoMatch } from '@/components/ui/no-match';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';
import { Money } from '../../../components/ui/money';
import { Select } from '../../../components/ui/select';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import {
  Plus, Eye, 
  RotateCcw, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import { useDateFormat } from '../../../lib/dates';
import { useToast } from '../../../components/ui/toast';
import { TextareaField } from '../../../components/ui/textarea-field';
import { LedgerEntryDialog } from '@/components/ledger/LedgerEntryDialog';
import { LedgerQuickActions } from '@/components/dashboard/quick-actions';
import { useAuth } from '@/lib/auth-context';
import { MANUAL_CATEGORIES, manualKindOf } from '@/lib/ledger-categories';
import { downloadCsv, datedFilename } from '../../../lib/export-csv';
import { Download } from 'lucide-react';
import { ValidatedForm } from '@/components/ui/validated-form';
import { EmptyState } from '@/components/ui/empty-state';
import { useCodeLabel } from '@/lib/labels';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { LatinText } from '@/components/ui/latin-text';
import { DataTable, CellBadge, type Column } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { ListToolbar } from '@/components/ui/list-toolbar';

// ─── Types ────────────────────────────────────────────────────────────
/** Who recorded a ledger row: the partner's name, else the login's email. */
const actorName = (e: { actor?: LedgerEntry['actor'] }) => e.actor?.partner?.displayName ?? e.actor?.email ?? '—';

interface LedgerEntry {
  id: string;
  type: string;
  category: string;
  direction: string;
  amount: number;
  currency: string;
  fxRateToEgp?: number;
  cycle?: { id: string; code: string };
  /** Who recorded it (owner 2026-10-22); null on rows from before anyone was recorded. */
  actor?: { id: string; email: string; partner?: { displayName: string } | null } | null;
  relatedType?: string;
  relatedId?: string;
  reason?: string;
  reversalOfId?: string | null;
  /** The Cairo day the money moved (manual entries, L6); else createdAt. */
  occurredOn?: string | null;
  originalAmount?: number | string | null;
  originalCurrency?: string | null;
  createdAt: string;
}

/** When it happened: the day a manual entry names, else when it was written. */
const entryDate = (e: LedgerEntry) => e.occurredOn ?? e.createdAt;

/**
 * Only a hand-written entry is reversed from here; a flow's row is undone
 * where it was made, and a reversal is never reversed (§9).
 */
const reversible = (e: LedgerEntry) => !e.relatedType && !e.reversalOfId;

const TYPE_KEYS: Record<string, string> = {
  PURCHASE: 'purchase',
  PURCHASE_PAYMENT: 'purchase',
  PURCHASE_COST: 'purchaseCost',
  PURCHASE_REFUND: 'refund',
  SHIPPING: 'shipping',
  SHIPPING_COST: 'shipping',
  CUSTOMS_FEES: 'fees',
  FEES: 'fees',
  SALE: 'sale',
  SALE_REVENUE: 'saleRevenue',
  PAYMENT: 'payment',
  PAYMENT_RECEIVED: 'paymentReceived',
  REFUND: 'refund',
  ADJUSTMENT: 'adjustment',
  INVESTMENT: 'investment',
  SETTLEMENT: 'settlement',
  SETTLEMENT_PAYOUT: 'settlementPayout',
  SETTLEMENT_REVERSAL: 'settlementReversal',
  SUPPLIER_REFUND: 'supplierRefund',
  SALE_RETURN: 'saleReturn',
  REFUND_PAID: 'refundPaid',
  EXPENSE: 'expense',
  OTHER_INCOME: 'otherIncome',
  CAPITAL_CONTRIBUTION: 'capitalContribution',
  LENDER_FINANCING: 'lenderFinancing',
  LENDER_REPAYMENT: 'lenderRepayment',
  STOCK_TRANSFER: 'stockTransfer',
  STOCK_TRANSFER_REVERSAL: 'stockTransferReversal',
};

const DIRECTION_COLORS: Record<string, string> = {
  INFLOW: 'bg-green-100 text-green-700',
  OUTFLOW: 'bg-red-100 text-red-700',
};

// ─── Skeletons ────────────────────────────────────────────────────────
// The table's skeleton rows are drawn by DataTable from each column's
// `skeleton`; the phone card below is traced by hand, with no Reverse footer
// (most rows are a flow's). Change one, change the other.

function LedgerCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <Skeleton className="h-5 w-20 rounded-full" />
        <SkeletonText size="base" className="w-24" />
      </div>
      <div className="flex items-center gap-2 mb-1">
        <SkeletonText className="w-24" />
        <SkeletonText className="w-20" />
      </div>
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-muted">
        <SkeletonText size="xs" className="w-20" />
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function LedgerPage() {
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const t = useTranslations('ledger');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const { user } = useAuth();

  // `type` is a free-form column: fall back to the raw value rather than
  // asking next-intl for a message key that does not exist.
  const typeLabel = (type: string) => (TYPE_KEYS[type] ? t(TYPE_KEYS[type]) : type);
  // A category in the reader's language — the manual list and the ones the
  // flows write; free text written before L6 comes back exactly as written.
  const categoryLabel = (category?: string | null) =>
    !category ? '—' : codeLabel('ledgerCategory', category);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [directionFilter, setDirectionFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const openCreate = () => setShowCreateModal(true);
  const [showReverseModal, setShowReverseModal] = useState(false);
  const [viewingEntry, setViewingEntry] = useState<LedgerEntry | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<LedgerEntry | null>(null);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, directionFilter, typeFilter, categoryFilter]);

  // ── Queries ───────────────────────────────────────────────────────
  const { items: entries, capped, isLoading } = useAllRecords(['ledger'], '/ledger');

  const { data: entryDetail } = useQuery({
    queryKey: ['ledger-entry', viewingEntry?.id],
    queryFn: () =>
      api.get(`/ledger/${viewingEntry!.id}`).then((r) => r.data.data ?? r.data),
    enabled: !!viewingEntry,
  });

  // ── Mutations ─────────────────────────────────────────────────────
  const reverseMutation = useMutation({
    mutationFn: (data: any) => api.post(`/ledger/${selectedEntry!.id}/reverse`, data),
    onSuccess: () => {
      toast(t('entryReversed'), 'success');
      queryClient.invalidateQueries({ queryKey: ['ledger'] });
      setShowReverseModal(false);
      setSelectedEntry(null);
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const entryList: LedgerEntry[] = Array.isArray(entries) ? entries : [];

  const filtered = entryList.filter((e) => {
    if (directionFilter && e.direction !== directionFilter) return false;
    if (typeFilter && TYPE_KEYS[e.type] !== typeFilter) return false;
    if (categoryFilter && e.category !== categoryFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.type?.toLowerCase().includes(q) ||
      e.category?.toLowerCase().includes(q) ||
      categoryLabel(e.category).toLowerCase().includes(q) ||
      e.reason?.toLowerCase().includes(q) ||
      e.amount?.toString().includes(q)
    );
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  // Nothing at all says what goes here and offers the first one; nothing for
  // this search or filter says only that (UX #12).
  const emptyList =
    entryList.length === 0 ? (
      <EmptyState
        title={t('emptyTitle')}
        description={t('emptyHint')}
        action={{ label: t('create'), onClick: openCreate }}
      />
    ) : (
      <NoMatch filtered={!!(directionFilter || typeFilter || categoryFilter)} onClear={() => { setSearch(''); setDirectionFilter(''); setTypeFilter(''); setCategoryFilter(''); }} />
    );

  const detail = (entryDetail as LedgerEntry) ?? viewingEntry;

  // ── Handlers ──────────────────────────────────────────────────────
  const handleReverse = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    reverseMutation.mutate({
      reason: fd.get('reason'),
    });
  };

  // ── Columns ───────────────────────────────────────────────────────
  // Date, type, category, direction, amount, cycle, actions
  // (components/ui/data-table.tsx). The category is what tells rows apart and
  // takes what is left; a long type is cut with the whole of it on hover; the
  // amount fits "-123,456.00 EGP".
  const columns: Column<LedgerEntry>[] = [
    {
      key: 'date', header: t('date'), width: '7.5rem', kind: 'value', className: 'text-gray-500 text-xs',
      skeleton: { kind: 'text', size: 'xs', share: 'w-3/4' }, cell: (e) => formatDate(entryDate(e)),
    },
    {
      key: 'type', header: t('type'), width: '11.5rem', kind: 'label', className: 'text-gray-600',
      title: (e) => typeLabel(e.type), skeleton: { kind: 'text', share: 'w-2/3' }, cell: (e) => typeLabel(e.type),
    },
    {
      key: 'category', header: t('category'), width: 'auto', kind: 'name', className: 'text-gray-600',
      title: (e) => categoryLabel(e.category), cell: (e) => <bdi>{categoryLabel(e.category)}</bdi>,
    },
    {
      key: 'direction', header: t('direction'), width: '7rem', skeleton: { kind: 'pill', share: 'w-3/4' },
      cell: (entry) => (
        <CellBadge className={DIRECTION_COLORS[entry.direction] ?? 'bg-gray-100 text-gray-600'}>
          {entry.direction === 'INFLOW' ? <ArrowUpRight className="inline h-3 w-3" /> : <ArrowDownRight className="inline h-3 w-3" />}{' '}
          {t(entry.direction?.toLowerCase() ?? entry.direction)}
        </CellBadge>
      ),
    },
    {
      key: 'amount', header: t('amount'), width: '9.5rem', kind: 'value', className: 'font-medium text-gray-900',
      skeleton: { kind: 'text', share: 'w-2/3' }, cell: (e) => <Money value={e.amount} currency={e.currency} />,
    },
    {
      key: 'cycle', header: t('cycle'), width: '8rem', kind: 'label', className: 'text-gray-600',
      title: (e) => e.cycle?.code, skeleton: { kind: 'text', share: 'w-2/3' }, cell: (e) => e.cycle?.code ?? '—',
    },
    {
      // Who recorded the row (owner 2026-10-22): the partner's name, else the login.
      key: 'by', header: t('by'), width: '8rem', kind: 'label', className: 'text-gray-600',
      title: (e) => actorName(e), skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (e) => <LatinText truncate>{actorName(e)}</LatinText>,
    },
    {
      // Most rows are a flow's, which has only the View button (a hand-written
      // entry adds Reverse), so the skeleton carries one.
      key: 'actions', header: tc('actions'), width: '6rem', skeleton: { kind: 'buttons', count: 1 },
      cell: (entry) => (
        <div className="flex items-center gap-1">
          <button
            onClick={() => setViewingEntry(entry)}
            className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
            title={tc('view')}
          >
            <Eye className="h-4 w-4" />
          </button>
          {reversible(entry) && (
            <button
              type="button"
              onClick={() => { setSelectedEntry(entry); setShowReverseModal(true); }}
              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              title={t('reverse')}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          {/* A quick action, not a toolbar button (owner 2026-10-18). */}
          <LedgerQuickActions role={user?.role} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
        {/* Whatever the filters currently show, not the whole table — the
            filtered view is the question being asked. Amount goes out as a
            number so the spreadsheet can total it. */}
        <button
          type="button"
          onClick={() =>
            downloadCsv(datedFilename('ledger'), filtered, [
              { header: tc('date'), value: (e) => entryDate(e)?.slice(0, 10) ?? '' },
              { header: t('direction'), value: (e) => e.direction },
              { header: t('category'), value: (e) => categoryLabel(e.category) },
              { header: tc('amount'), value: (e) => e.amount },
              { header: t('currency'), value: (e) => e.currency },
              { header: t('cycle'), value: (e) => e.cycle?.code ?? '' },
              { header: t('by'), value: (e) => (e.actor ? actorName(e) : '') },
              { header: t('reason'), value: (e) => e.reason ?? '' },
            ])
          }
          disabled={filtered.length === 0}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <Download className="h-4 w-4" />
          {tc('export')}
        </button>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
        </button>
        </div>
      </div>

      {/* Search + Filters */}
      <ListToolbar search={{ value: search, onChange: setSearch, placeholder: t('search') }}>
        <Select
          className="w-full sm:w-44"
          value={directionFilter}
          onChange={setDirectionFilter}
          clearable
          placeholder={t('allDirections')}
          options={[
            { value: 'INFLOW', label: t('inflow') },
            { value: 'OUTFLOW', label: t('outflow') },
          ]}
        />
        <Select
          className="w-full sm:w-52"
          value={typeFilter}
          onChange={setTypeFilter}
          clearable
          placeholder={t('allTypes')}
          searchPlaceholder={tph('searchTypes')}
          options={[...new Set(Object.values(TYPE_KEYS))].map((label) => ({
            value: label,
            label: t(label),
          }))}
        />
        {/* The one manual list (L6), in words, then any other category the
            loaded rows carry — a flow's, or free text from before — as written. */}
        <Select
          className="w-full sm:w-56"
          value={categoryFilter}
          onChange={setCategoryFilter}
          clearable
          placeholder={t('allCategories')}
          searchPlaceholder={tph('searchCategories')}
          options={[
            ...MANUAL_CATEGORIES.map((c) => ({
              value: c,
              label: codeLabel('ledgerCategory', c),
              hint: manualKindOf(c) === 'EXPENSE' ? t('kindExpense') : t('kindIncome'),
            })),
            ...[...new Set(entryList.map((e) => e.category).filter(Boolean))]
              .filter((c) => !manualKindOf(c))
              .sort()
              .map((c) => ({ value: c, label: categoryLabel(c) })),
          ]}
        />
      </ListToolbar>

      <ListCapNotice capped={capped} count={entries.length} />

      {/* Loading: the table's own header over skeleton rows, skeleton cards on a phone. */}
      {isLoading && <LoadingStatus />}

      {/* Desktop Table — the shared one (components/ui/data-table.tsx). */}
      <DataTable
        className="hidden md:block"
        // Categories are short labels; with the By column (2026-10-22) the
        // default 14rem pushed the table past a 1440px page.
        autoMin="9rem"
        columns={columns}
        rows={paginated}
        rowKey={(e) => e.id}
        isLoading={isLoading}
        empty={emptyList}
      />

      {/* Mobile Cards */}
      {isLoading && (
        <SkeletonGroup className="md:hidden space-y-3">
          {repeat(PAGE_SIZE, (i) => <LedgerCardSkeleton key={i} />)}
        </SkeletonGroup>
      )}
      {!isLoading && (
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200">{emptyList}</div>
          ) : (
            paginated.map((entry) => (
              <div
                key={entry.id}
                onClick={() => setViewingEntry(entry)}
                className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${DIRECTION_COLORS[entry.direction] ?? 'bg-gray-100 text-gray-600'}`}>
                    {entry.direction === 'INFLOW' ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {t(entry.direction?.toLowerCase() ?? entry.direction)}
                  </span>
                  <span className="font-medium text-gray-900"><Money value={entry.amount} currency={entry.currency} /></span>
                </div>
                <div className="flex items-center gap-2 text-sm text-gray-600 mb-1">
                  <span>{typeLabel(entry.type)}</span>
                  <span className="text-gray-400">•</span>
                  <bdi>{categoryLabel(entry.category)}</bdi>
                </div>
                <div className="flex items-center justify-between text-xs text-gray-500 mt-2 pt-2 border-t border-gray-100">
                  <span>{formatDate(entryDate(entry))}</span>
                </div>
                {reversible(entry) && (
                  <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-100">
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedEntry(entry); setShowReverseModal(true); }}
                      className="flex items-center gap-1 text-xs text-red-600 hover:text-red-700 px-2 py-1 rounded"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> {t('reverse')}
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Pagination */}
      {!isLoading && filtered.length > 0 && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} totalItems={filtered.length} />
      )}

      {/* ─── Record money in or out (L6) ───────────────────────────── */}
      <LedgerEntryDialog open={showCreateModal} onClose={() => setShowCreateModal(false)} />

      {/* ─── Reverse Modal ─────────────────────────────────────────── */}
      {showReverseModal && selectedEntry && (
        <Dialog
          title={t('reverse')}
          onClose={() => { setShowReverseModal(false); setSelectedEntry(null); }}
          footer={
            <>
              <button type="button" onClick={() => { setShowReverseModal(false); setSelectedEntry(null); }} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit"
                form="ledger-1-form" className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">{t('reverse')}</button>
            </>
          }
        >
          <ValidatedForm id="ledger-1-form" onSubmit={handleReverse} className="space-y-4">
            <p className="text-sm text-gray-600">
              {t('amount')}: <span className="font-medium text-gray-900"><Money value={selectedEntry.amount} currency={selectedEntry.currency} /></span>
            </p>
            <TextareaField label={t('reverseReason')} name="reason" required minLength={3} placeholder={tph('reverseReason')} />
          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── View Entry Detail ─────────────────────────────────────── */}
      {viewingEntry && detail && (
        <Dialog title={`${t('type')}: ${typeLabel(detail.type)}`} onClose={() => setViewingEntry(null)}>
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('date')} value={formatDate(entryDate(detail))} />
              <Detail label={t('type')} value={typeLabel(detail.type)} />
              <Detail label={t('category')} value={<bdi>{categoryLabel(detail.category)}</bdi>} />
              <Detail
                label={t('direction')}
                value={
                  <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${DIRECTION_COLORS[detail.direction] ?? 'bg-gray-100 text-gray-600'}`}>
                    {detail.direction === 'INFLOW' ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {t(detail.direction?.toLowerCase() ?? detail.direction)}
                  </span>
                }
              />
              <Detail label={t('amount')} value={<Money value={detail.amount} currency={detail.currency} />} />
              {detail.originalAmount != null && detail.originalCurrency && (
                <Detail label={t('originalAmount')} value={<Money value={detail.originalAmount} currency={detail.originalCurrency} />} />
              )}
              <Detail label={t('fxRate')} value={detail.fxRateToEgp?.toString() ?? '—'} />
              <Detail label={t('cycle')} value={detail.cycle?.code ?? '—'} />
              <Detail label={t('relatedTo')} value={detail.relatedType && detail.relatedId ? `${codeLabel('referenceType', detail.relatedType)} (${detail.relatedId})` : '—'} />
              <Detail label={t('reason')} value={detail.reason ?? '—'} />
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <span className="text-gray-500 text-xs">{label}</span>
      <p className="font-medium text-gray-900">{value}</p>
    </div>
  );
}
