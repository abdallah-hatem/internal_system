'use client';
import { NoMatch } from '@/components/ui/no-match';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';
import { Select } from '../../../components/ui/select';
import { CustomerLink } from '../../../components/ui/entity-link';
import { Money } from '../../../components/ui/money';
import { useNumberFormat } from '@/lib/numbers';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useToast } from '../../../components/ui/toast';
import { Suspense, useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import { useDateFormat } from '../../../lib/dates';
import { useCodeLabel } from '../../../lib/labels';
import { TextareaField } from '../../../components/ui/textarea-field';
import { MoneyInput } from '../../../components/ui/money-input';
import { EmptyState } from '../../../components/ui/empty-state';
import {
  RecordPaymentDialog,
  canTakePayment,
} from '../../../components/payments/RecordPaymentDialog';
import {
  Plus, Eye, Loader2,
  ArrowRightLeft, RotateCcw, Download,
} from '@/components/ui/icons';
import { DateRangeFilter, type DayRange } from '@/components/ui/date-range-filter';
import { downloadCsv, datedFilename } from '@/lib/export-csv';

import { useApiError } from '../../../lib/api-error';
import { useOpenFromQuery } from '../../../lib/open-from-query';
import { ValidatedForm } from '@/components/ui/validated-form';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, CellBadge, type Column } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { TabBar } from '@/components/ui/tab-bar';
import { ContractsList } from '@/components/payments/contracts-list';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { PaymentsSummary } from '@/components/summary/tab-summaries';
// ─── Types ────────────────────────────────────────────────────────────
interface Payment {
  id: string;
  customerId: string;
  customer?: { displayName: string };
  amount: number;
  currency: string;
  method: string;
  reference?: string;
  receivedOn: string;
  status: string;
}

interface SaleOrder {
  id: string;
  orderNo: string;
  customerId: string;
  status: string;
  outstanding: number;
  currency: string;
}

const STATUS_COLORS: Record<string, string> = {
  RECORDED: 'bg-green-100 text-green-700',
  REVERSED: 'bg-red-100 text-red-700',
};


// ─── Skeletons ────────────────────────────────────────────────────────
// The table's skeleton rows are drawn by DataTable from each column's
// `skeleton`; the phone card below is traced by hand, keeping the Allocate /
// Reverse footer a recorded payment has. Change one, change the other.

function PaymentCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <SkeletonText size="base" className="w-36" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex items-center gap-3 mb-2">
        <SkeletonText className="w-20" />
        <SkeletonText className="w-16" />
      </div>
      <div className="flex items-center justify-between">
        <SkeletonText size="xs" className="w-20" />
        <SkeletonText size="xs" className="w-16" />
      </div>
      <div className="flex items-center gap-2 mt-3 pt-2 border-t border-muted">
        {repeat(2, (i) => <Skeleton key={i} className="h-6 w-20 rounded" />)}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
/**
 * The page reads `?new=1` (the dashboard's "Record payment") to open the form
 * on arrival. `useSearchParams` cannot be prerendered, so Next requires a
 * Suspense boundary or `next build` fails on this page.
 */
export default function PaymentsPage() {
  return (
    <Suspense fallback={null}>
      <PaymentsViews />
    </Suspense>
  );
}

/**
 * The two views of the page; `?view=contracts` opens the second. `?view=plans`
 * was its address before plans became contracts (2026-10-17) and still opens
 * it — a bookmark, an old notification — swapped for the new one in place.
 */
type PaymentsView = 'payments' | 'contracts';

const LEGACY_VIEW = 'plans';

const viewOf = (param: string | null): PaymentsView =>
  param === 'contracts' || param === LEGACY_VIEW ? 'contracts' : 'payments';

/** The page's address with `view` set for a tab, every other parameter kept. */
function viewHref(pathname: string, current: URLSearchParams, next: PaymentsView) {
  const params = new URLSearchParams(current.toString());
  if (next === 'contracts') params.set('view', 'contracts');
  else params.delete('view');
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * Payments, and the contracts being followed up, as two tabs of one page
 * (owner, 2026-10-16; instalment plans became Contracts 2026-10-17). The open
 * tab lives in the URL, so a refresh or the back button returns to it, and
 * switching does not move the page (`scroll: false`).
 */
function PaymentsViews() {
  const t = useTranslations('payments.tabs');
  const tk = useTranslations('contracts');
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = viewOf(searchParams.get('view'));

  // The old address is replaced, so Back does not land on it again.
  const legacy = searchParams.get('view') === LEGACY_VIEW;
  useEffect(() => {
    if (legacy) router.replace(viewHref(pathname, searchParams, 'contracts'), { scroll: false });
  }, [legacy, pathname, router, searchParams]);

  const show = (next: PaymentsView) => {
    if (next === view) return;
    router.push(viewHref(pathname, searchParams, next), { scroll: false });
  };

  return (
    <div className="space-y-6">
      <TabBar
        label={t('label')}
        value={view}
        onChange={show}
        tabs={[
          { key: 'payments', label: t('payments') },
          { key: 'contracts', label: t('contracts') },
        ]}
      />
      <div role="tabpanel" aria-labelledby={`tab-${view}`}>
        {view === 'contracts' ? (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-foreground">{tk('title')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{tk('subtitle')}</p>
            </div>
            <ContractsList />
          </div>
        ) : (
          <PaymentsPageContent />
        )}
      </div>
    </div>
  );
}

function PaymentsPageContent() {
  const apiError = useApiError();
  const t = useTranslations('payments');
  const tph = useTranslations('placeholders');
  const { formatMoney } = useNumberFormat();
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAllocateModal, setShowAllocateModal] = useState(false);
  const [showReverseModal, setShowReverseModal] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);
  const [viewingPayment, setViewingPayment] = useState<Payment | null>(null);
  // Days the money was received, both included, filtered by the API (I1).
  const [dates, setDates] = useState<DayRange>({ from: '', to: '' });
  const dated = Boolean(dates.from || dates.to);
  const clearFilters = () => { setSearch(''); setDates({ from: '', to: '' }); };

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, dates]);

  // ── Queries ───────────────────────────────────────────────────────
  // Every page of the range, not one: the CSV exports what the filter shows.
  const {
    items: payments,
    capped,
    isLoading,
    error: listError,
    reloading,
  } = useAllRecords(
    ['payments', dates],
    '/payments',
    { from: dates.from || undefined, to: dates.to || undefined },
    // A new range keeps the rows on screen, dimmed, until it arrives (I2).
    { keepPrevious: true },
  );
  const { items: orders } = useAllRecords(['sales'], '/sales/orders');

  const { data: paymentDetail } = useQuery({
    queryKey: ['payment', viewingPayment?.id],
    queryFn: () =>
      api.get(`/payments/${viewingPayment!.id}`).then((r) => r.data.data ?? r.data),
    enabled: !!viewingPayment,
  });

  // `?new=1` — the dashboard's "Record payment" — opens the same form the button does.
  useOpenFromQuery(() => setShowCreateModal(true));

  // ── Mutations ─────────────────────────────────────────────────────
  // Recording is `RecordPaymentDialog` — the customer page's form, applied to
  // the oldest unpaid orders first. Allocate stays for older payments recorded
  // before that, which may still hold money attached to no order.
  const allocateMutation = useMutation({
    mutationFn: (data: any) => api.post(`/payments/${selectedPayment!.id}/allocations`, data),
    onSuccess: () => {
      toast(t('allocated'), 'success');
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['payment'] });
      setShowAllocateModal(false);
      setSelectedPayment(null);
    },
    onError: (error: any) => {
      toast(apiError(error, t('allocateFailed')), 'error');
    },
  });

  const reverseMutation = useMutation({
    mutationFn: (data: any) => api.post(`/payments/${selectedPayment!.id}/reverse`, data),
    onSuccess: () => {
      toast(t('reversedToast'), 'success');
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
      setShowReverseModal(false);
      setSelectedPayment(null);
    },
    onError: (error: any) => {
      toast(apiError(error, t('reverseFailed')), 'error');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const paymentList: Payment[] = Array.isArray(payments) ? payments : [];
  const orderList: SaleOrder[] = Array.isArray(orders) ? orders : [];

  const filtered = paymentList.filter((p) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      p.customer?.displayName?.toLowerCase().includes(q) ||
      p.reference?.toLowerCase().includes(q) ||
      p.amount?.toString().includes(q)
    );
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  /**
   * The rows the search and dates show — every page of them — as a
   * spreadsheet. The amount goes out as a number so it can be summed; the
   * day is the day received, the one the filter reads.
   */
  const exportCsv = () =>
    downloadCsv(datedFilename('payments'), filtered, [
      { header: t('receivedOn'), value: (p) => p.receivedOn?.slice(0, 10) ?? '' },
      { header: t('customer'), value: (p) => p.customer?.displayName ?? '' },
      { header: t('amount'), value: (p) => Number(p.amount) },
      { header: t('currency'), value: (p) => p.currency },
      { header: t('method'), value: (p) => codeLabel('paymentMethod', p.method) },
      { header: t('reference'), value: (p) => p.reference ?? '' },
      { header: t('status'), value: (p) => codeLabel('paymentStatus', p.status) },
    ]);

  // ── Handlers ──────────────────────────────────────────────────────
  const handleAllocate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    allocateMutation.mutate({
      saleOrderId: fd.get('saleId'),
      amount: Number(fd.get('allocateAmount')),
    });
  };

  const handleReverse = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    reverseMutation.mutate({
      reason: fd.get('reason'),
    });
  };

  // ── Columns ───────────────────────────────────────────────────────
  // Customer, amount, currency, method, received, reference, status, actions
  // (components/ui/data-table.tsx). Each fixed column fits its title in
  // English and Arabic; the amount fits "-123,456.00 EGP"; the customer
  // takes what is left.
  const columns: Column<Payment>[] = [
    {
      key: 'customer', header: t('customer'), width: 'auto', kind: 'name',
      title: (p) => p.customer?.displayName, className: 'text-gray-900 font-medium',
      cell: (p) => <CustomerLink id={p.customerId} name={p.customer?.displayName} />,
    },
    {
      // The amount carries its own currency: without it a USD payment
      // rendered as "… EGP" beside a USD column. End-aligned, as money is.
      key: 'amount', header: t('amount'), width: '9rem', kind: 'value', align: 'end',
      className: 'text-gray-900 font-medium', skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (p) => <Money value={p.amount} currency={p.currency} />,
    },
    {
      key: 'currency', header: t('currency'), width: '6rem', kind: 'value', className: 'text-gray-600',
      skeleton: { kind: 'text', share: 'w-1/3' },
      cell: (p) => p.currency,
    },
    {
      key: 'method', header: t('method'), width: '8rem', kind: 'label', className: 'text-gray-600',
      title: (p) => codeLabel('paymentMethod', p.method), skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (p) => codeLabel('paymentMethod', p.method),
    },
    {
      key: 'receivedOn', header: t('receivedOn'), width: '8rem', kind: 'value', className: 'text-gray-500 text-xs',
      skeleton: { kind: 'text', size: 'xs', share: 'w-3/4' },
      cell: (p) => formatDate(p.receivedOn),
    },
    {
      key: 'reference', header: t('reference'), width: '9rem', kind: 'label', className: 'text-gray-500 font-mono text-xs',
      title: (p) => p.reference, skeleton: { kind: 'text', size: 'xs', share: 'w-1/2' },
      cell: (p) => (p.reference ? <bdi dir="ltr">{p.reference}</bdi> : '—'),
    },
    {
      key: 'status', header: t('status'), width: '7.5rem', skeleton: { kind: 'pill', share: 'w-3/4' },
      cell: (p) => (
        <CellBadge className={STATUS_COLORS[p.status] ?? 'bg-gray-100 text-gray-600'}>
          {codeLabel('paymentStatus', p.status)}
        </CellBadge>
      ),
    },
    {
      key: 'actions', header: tc('actions'), width: '8rem', skeleton: { kind: 'buttons', count: 3 },
      cell: (payment) => (
        <div className="flex items-center gap-1">
          <button
            onClick={() => setViewingPayment(payment)}
            className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
            title={tc('view')}
          >
            <Eye className="h-4 w-4" />
          </button>
          {payment.status === 'RECORDED' && (
            <>
              <button
                onClick={() => { setSelectedPayment(payment); setShowAllocateModal(true); }}
                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                title={t('allocate')}
              >
                <ArrowRightLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => { setSelectedPayment(payment); setShowReverseModal(true); }}
                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                title={t('reverse')}
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </>
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
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="payments-export"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="bg-background inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {tc('export')}
          </button>
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            {t('create')}
          </button>
        </div>
      </div>

      {/* The largest payment, and who paid it (owner 2026-10-22). */}
      <PaymentsSummary />

      {/* Search + days received */}
      <ListToolbar
        search={{ value: search, onChange: setSearch, placeholder: t('search') }}
        after={
          listError && (
            <p role="alert" data-testid="payments-range-error" className="text-sm text-destructive">
              {apiError(listError, tc('error'))}
            </p>
          )
        }
      >
        <DateRangeFilter idPrefix="payments" value={dates} onChange={setDates} busy={reloading} />
      </ListToolbar>

      <ListCapNotice capped={capped} count={payments.length} />

      {/* Loading: the table's own header over skeleton rows, skeleton cards on a phone. */}
      {isLoading && <LoadingStatus />}

      {/* Desktop Table — the shared one (components/ui/data-table.tsx). */}
      <DataTable
        testId="payments-table"
        className="hidden md:block"
        columns={columns}
        rows={paginated}
        rowKey={(p) => p.id}
        isLoading={isLoading}
        stale={reloading}
        empty={
          search || dated ? (
            <NoMatch filtered={dated} onClear={clearFilters} />
          ) : (
            <EmptyState
              title={t('empty')}
              description={t('emptyHint')}
              action={{ label: t('create'), onClick: () => setShowCreateModal(true) }}
            />
          )
        }
      />

      {/* Mobile Cards */}
      {isLoading && (
        <SkeletonGroup className="md:hidden space-y-3">
          {repeat(PAGE_SIZE, (i) => <PaymentCardSkeleton key={i} />)}
        </SkeletonGroup>
      )}
      {!isLoading && (
        <div data-testid="payments-cards" aria-busy={reloading} className={`md:hidden space-y-3 transition-opacity ${reloading ? 'opacity-60' : ''}`}>
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200">
              {search || dated ? (
                <NoMatch filtered={dated} onClear={clearFilters} />
              ) : (
                <EmptyState
                  title={t('empty')}
                  description={t('emptyHint')}
                  action={{ label: t('create'), onClick: () => setShowCreateModal(true) }}
                />
              )}
            </div>
          ) : (
            paginated.map((payment) => (
              <div
                key={payment.id}
                className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => setViewingPayment(payment)}
              >
                <div className="flex items-center justify-between mb-2">
                  <p className="font-medium text-gray-900">
                    <CustomerLink id={payment.customerId} name={payment.customer?.displayName} />
                  </p>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[payment.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {codeLabel('paymentStatus', payment.status)}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-sm mb-2">
                  <span className="font-medium text-gray-900"><Money value={payment.amount} currency={payment.currency} /></span>
                  <span className="text-gray-500">{codeLabel('paymentMethod', payment.method)}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>{formatDate(payment.receivedOn)}</span>
                  <span className="font-mono">{payment.reference ? <bdi dir="ltr">{payment.reference}</bdi> : '—'}</span>
                </div>
                {payment.status === 'RECORDED' && (
                  <div className="flex items-center gap-2 mt-3 pt-2 border-t border-gray-100">
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedPayment(payment); setShowAllocateModal(true); }}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 px-2 py-1 rounded"
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5" /> {t('allocate')}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedPayment(payment); setShowReverseModal(true); }}
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

      {/* ─── Record Payment — the one form, shared with the customer page ── */}
      <RecordPaymentDialog open={showCreateModal} onClose={() => setShowCreateModal(false)} />

      {/* ─── Allocate Modal ────────────────────────────────────────── */}
      {showAllocateModal && selectedPayment && (
        <Dialog
          title={t('allocate')}
          onClose={() => { setShowAllocateModal(false); setSelectedPayment(null); }}
          footer={
            <>
              <button type="button" onClick={() => { setShowAllocateModal(false); setSelectedPayment(null); }} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit"
                form="payments-1-form" disabled={allocateMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {allocateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('confirm')}
              </button>
            </>
          }
        >
          <ValidatedForm id="payments-1-form" onSubmit={handleAllocate} className="space-y-4">
            <p className="text-sm text-gray-600">
              {t('customer')}: <span className="font-medium text-gray-900">{selectedPayment.customer?.displayName ?? '—'}</span>
            </p>
            <p className="text-sm text-gray-600">
              {t('amount')}: <span className="font-medium text-gray-900"><Money value={selectedPayment.amount} currency={selectedPayment.currency} /></span>
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('selectOrder')}</label>
              <Select
                name="saleId"
                required
                placeholder={tph('chooseSaleOrder')}
                searchPlaceholder={tph('searchOrders')}
                options={orderList
                  // This payer's orders only, and only ones still owing. The
                  // list was every order in the system by number, which made
                  // paying off the wrong shop a slip of one click.
                  .filter(
                    (o: SaleOrder) =>
                      o.customerId === selectedPayment?.customerId &&
                      canTakePayment(o),
                  )
                  .map((o: SaleOrder) => ({
                    value: o.id,
                    label: o.orderNo,
                    hint: `${t('outstanding')}: ${formatMoney(o.outstanding, o.currency)}`,
                  }))}
                emptyText={t('noOpenOrders')}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                {t('allocateAmount')}<span className="ms-1 text-red-500">*</span>
              </label>
              <MoneyInput name="allocateAmount" required placeholder={tph('money')} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
            </div>
          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── Reverse Modal ─────────────────────────────────────────── */}
      {showReverseModal && selectedPayment && (
        <Dialog
          title={t('reverse')}
          onClose={() => { setShowReverseModal(false); setSelectedPayment(null); }}
          footer={
            <>
              <button type="button" onClick={() => { setShowReverseModal(false); setSelectedPayment(null); }} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit"
                form="payments-2-form" disabled={reverseMutation.isPending} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2">
                {reverseMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('reverse')}
              </button>
            </>
          }
        >
          <ValidatedForm id="payments-2-form" onSubmit={handleReverse} className="space-y-4">
            <p className="text-sm text-gray-600">
              {t('customer')}: <span className="font-medium text-gray-900">{selectedPayment.customer?.displayName ?? '—'}</span>
            </p>
            <p className="text-sm text-gray-600">
              {t('amount')}: <span className="font-medium text-gray-900"><Money value={selectedPayment.amount} currency={selectedPayment.currency} /></span>
            </p>
            <TextareaField label={t('reverseReason')} name="reason" required minLength={3} placeholder={tph('reverseReason')} />
          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── View Payment Detail ───────────────────────────────────── */}
      {viewingPayment && (
        <Dialog title={`${t('customer')}: ${viewingPayment.customer?.displayName ?? '—'}`} onClose={() => setViewingPayment(null)}>
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('customer')} value={viewingPayment.customer?.displayName ?? '—'} />
              <Detail label={t('amount')} value={<Money value={viewingPayment.amount} currency={viewingPayment.currency} />} />
              <Detail label={t('method')} value={codeLabel('paymentMethod', viewingPayment.method)} />
              <Detail label={t('receivedOn')} value={formatDate(viewingPayment.receivedOn)} />
              <Detail label={t('reference')} value={viewingPayment.reference ?? '—'} />
              <Detail label={t('status')} value={codeLabel('paymentStatus', viewingPayment.status)} />
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
