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
  Plus, Search, Eye, X, Loader2,
  RotateCcw, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import { useDateFormat } from '../../../lib/dates';
import { useToast } from '../../../components/ui/toast';
import { TextareaField } from '../../../components/ui/textarea-field';
import { LedgerEntryDialog } from '@/components/ledger/LedgerEntryDialog';
import { MANUAL_CATEGORIES, manualKindOf } from '@/lib/ledger-categories';
import { downloadCsv, datedFilename } from '../../../lib/export-csv';
import { Download } from 'lucide-react';
import { ValidatedForm } from '@/components/ui/validated-form';
import { EmptyState } from '@/components/ui/empty-state';
import { useCodeLabel } from '@/lib/labels';

// ─── Types ────────────────────────────────────────────────────────────
interface LedgerEntry {
  id: string;
  type: string;
  category: string;
  direction: string;
  amount: number;
  currency: string;
  fxRateToEgp?: number;
  cycle?: { id: string; code: string };
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

// ─── Main Page ────────────────────────────────────────────────────────
export default function LedgerPage() {
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const t = useTranslations('ledger');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');

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
        action={{ label: t('create'), onClick: () => setShowCreateModal(true) }}
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

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <div className="flex items-center gap-2">
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
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
        </button>
        </div>
      </div>

      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder={t('search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full ps-10 pe-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
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
      </div>

      <ListCapNotice capped={capped} count={entries.length} />

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin me-2" /> {tc('loading')}
        </div>
      )}

      {/* Desktop Table */}
      {!isLoading && (
        <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('date')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('type')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('category')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('direction')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('amount')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('cycle')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={7}>{emptyList}</td></tr>
                ) : (
                  paginated.map((entry) => (
                    <tr key={entry.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(entryDate(entry))}</td>
                      <td className="px-4 py-3 text-gray-600">{typeLabel(entry.type)}</td>
                      <td className="px-4 py-3 text-gray-600"><bdi>{categoryLabel(entry.category)}</bdi></td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${DIRECTION_COLORS[entry.direction] ?? 'bg-gray-100 text-gray-600'}`}>
                          {entry.direction === 'INFLOW' ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                          {t(entry.direction?.toLowerCase() ?? entry.direction)}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        <Money value={entry.amount} currency={entry.currency} />
                      </td>
                      <td className="px-4 py-3 text-gray-600">{entry.cycle?.code ?? '—'}</td>
                      <td className="px-4 py-3">
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
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Mobile Cards */}
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
        <Modal title={t('reverse')} onClose={() => { setShowReverseModal(false); setSelectedEntry(null); }}>
          <ValidatedForm onSubmit={handleReverse} className="space-y-4">
            <p className="text-sm text-gray-600">
              {t('amount')}: <span className="font-medium text-gray-900"><Money value={selectedEntry.amount} currency={selectedEntry.currency} /></span>
            </p>
            <TextareaField label={t('reverseReason')} name="reason" required minLength={3} placeholder={tph('reverseReason')} />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => { setShowReverseModal(false); setSelectedEntry(null); }} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">{t('reverse')}</button>
            </div>
          </ValidatedForm>
        </Modal>
      )}

      {/* ─── View Entry Detail ─────────────────────────────────────── */}
      {viewingEntry && detail && (
        <Modal title={`${t('type')}: ${typeLabel(detail.type)}`} onClose={() => setViewingEntry(null)}>
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
        </Modal>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-hidden">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6 overflow-y-auto min-h-0">{children}</div>
      </div>
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
