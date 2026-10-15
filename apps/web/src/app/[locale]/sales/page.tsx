'use client';
import { NoMatch } from '@/components/ui/no-match';
import { LatinText } from '@/components/ui/latin-text';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';
import { Select } from '../../../components/ui/select';
import { CustomerLink, ProductLink } from '../../../components/ui/entity-link';
import { BatchRef } from '../../../components/ui/batch-ref';
import { Money } from '../../../components/ui/money';
import { useNumberFormat } from '@/lib/numbers';

import { useTranslations, useLocale } from 'next-intl';
import { localName } from '@/lib/localized-name';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useDateFormat } from '../../../lib/dates';
import { Suspense, useState, useMemo, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import { useToast } from '../../../components/ui/toast';
import { TextareaField } from '../../../components/ui/textarea-field';
import { EmptyState } from '../../../components/ui/empty-state';
import { useCodeLabel } from '../../../lib/labels';
import { usePriceCheck } from '@/lib/price-check';
import { BelowCostSummary } from '@/components/sales/below-cost';
import {
  SaleOrderForm,
  type SavedOrder,
  type SaleFormCustomer,
  type SaleFormProduct,
  type SaleFormStockRow,
} from '../../../components/sales/SaleOrderForm';
import {
  Plus, Search, Loader2,
  ChevronRight, CheckCircle, Ban, Package,
  Undo2, ShoppingCart, Wallet, FileText,
} from 'lucide-react';
import Link from 'next/link';
import {
  RecordPaymentDialog,
  canTakePayment,
} from '../../../components/payments/RecordPaymentDialog';

import { useApiError } from '../../../lib/api-error';
import { useOpenFromQuery } from '../../../lib/open-from-query';
import { ValidatedForm } from '@/components/ui/validated-form';
import { DateRangeFilter, type DayRange } from '@/components/ui/date-range-filter';
import { downloadCsv, datedFilename } from '@/lib/export-csv';
import { businessToday } from '@/lib/dates';
import { Download } from 'lucide-react';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
// ─── Types ────────────────────────────────────────────────────────────
interface SaleOrder {
  id: string;
  orderNo: string;
  customerId: string;
  /** `isWalkIn`: the shared walk-in record (§4) — shown as "Walk-in", never as a name. */
  customer?: { displayName: string; isWalkIn?: boolean };
  channel: string;
  status: string;
  total: number;
  outstanding: number;
  currency: string;
  version: number;
  createdAt: string;
  /** When it was ordered — what the date filter reads (BUSINESS_LOGIC §4). */
  orderedAt?: string;
  items?: SaleOrderItem[];
  paymentAllocations?: PaymentAllocation[];
}

interface PaymentAllocation {
  id: string;
  paymentId: string;
  amount: number;
  payment?: PaymentRecord;
}

interface SaleOrderItem {
  id: string;
  productId: string;
  product?: { name: string; sku: string };
  quantity: number;
  unitPrice: number;
  discount: number;
  lineTotal?: number | string;
  allocatedQty: number;
  allocations?: {
    id: string;
    inventoryBatchId?: string;
    qty: number;
    unitCostEgp?: number | string;
    cogsEgp?: number | string;
    batch?: { batchNo: string };
  }[];
}

interface PaymentRecord {
  id: string;
  amount: number;
  method: string;
  reference: string;
  receivedOn: string;
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  CONFIRMED: 'bg-blue-100 text-blue-700',
  PARTIALLY_PAID: 'bg-orange-100 text-orange-700',
  PAID: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-red-100 text-red-700',
  RETURNED: 'bg-purple-100 text-purple-700',
};

const FILTER_TABS = ['all', 'draft', 'confirmed', 'partiallyPaid', 'paid', 'cancelled'] as const;

// ─── Skeletons ────────────────────────────────────────────────────────
// The table's skeleton rows are drawn by DataTable from each column's
// `skeleton`; the phone card below is traced by hand: order number,
// customer, two badges, the amount, the date. Change one, change the other.

function SaleCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <SkeletonText className="w-28" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <SkeletonText className="w-40" />
      <div className="flex items-center gap-3 mt-2">
        <Skeleton className="h-5 w-10 rounded-full" />
        <SkeletonText className="w-20" />
      </div>
      <div className="flex items-center justify-between mt-2">
        <SkeletonText size="xs" className="w-20" />
        <SkeletonText size="xs" className="w-28" />
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
function SalesPageContent() {
  const apiError = useApiError();
  const t = useTranslations('sales');
  const tc = useTranslations('common');
  const tp = useTranslations('payments');
  const tph = useTranslations('placeholders');
  const { formatAmount } = useNumberFormat();
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  // Days the order was placed, both included, filtered by the API (I1).
  const [dates, setDates] = useState<DayRange>({ from: '', to: '' });
  // The new-order form, open or not, and the customer it opened on. The form
  // owns its own lines; unmounting it on close is what resets them.
  const [createFor, setCreateFor] = useState<{ customerId?: string } | null>(null);
  // `?new=1` — the dashboard's "New sale" — opens the same form the button does.
  useOpenFromQuery(() => setCreateFor({}));
  const [viewingOrder, setViewingOrder] = useState<SaleOrder | null>(null);
  const codeLabel = useCodeLabel();
  // Dates in the reader's language (UX #10).
  const { formatDate } = useDateFormat();
  // Cancelling is not undoable and the button sits beside Confirm, so it asks
  // first rather than acting on the click.
  const [cancellingOrder, setCancellingOrder] = useState<SaleOrder | null>(null);
  // "Record payment" on a confirmed order that still owes (U2): the money goes
  // on that order, through the one payment form.
  const [payingOrder, setPayingOrder] = useState<SaleOrder | null>(null);

  // Arriving from a shop's page with ?customer=<id> opens the order form on
  // that shop, so "New Order" there means what it says instead of dropping you
  // on a list to find them again.
  const searchParams = useSearchParams();
  const router = useRouter();
  const locale = useLocale();
  const openedFromCustomer = useRef(false);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, dates]);

  // ── Queries ───────────────────────────────────────────────────────
  // Every page of the range, not one: the CSV exports what the filter shows.
  const {
    items: orders,
    capped,
    isLoading,
    error: listError,
    reloading,
  } = useAllRecords(
    ['sales', dates],
    '/sales/orders',
    { from: dates.from || undefined, to: dates.to || undefined },
    // A new range keeps the rows on screen, dimmed, until it arrives (I2).
    { keepPrevious: true },
  );
  const dated = Boolean(dates.from || dates.to);
  const clearFilters = () => { setSearch(''); setStatusFilter('all'); setDates({ from: '', to: '' }); };
  const { items: customers } = useAllRecords(['customers'], '/customers');
  const { items: products } = useAllRecords(['products'], '/products');

  // What is actually on the shelf, so the form can say so before a quantity is
  // typed rather than refusing after one has been priced and built.
  const { data: stockLevels = [] } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => api.get('/inventory').then((r) => r.data.data ?? r.data),
  });

  const { data: orderDetail } = useQuery({
    queryKey: ['sale', viewingOrder?.id],
    queryFn: () =>
      api.get(`/sales/orders/${viewingOrder!.id}`).then((r) => r.data.data ?? r.data),
    enabled: !!viewingOrder,
  });

  // ── Mutations ─────────────────────────────────────────────────────
  const onOrderSaved = ({ confirmed, walkIn }: SavedOrder) => {
    void queryClient.invalidateQueries({ queryKey: ['sales'] });
    if (confirmed) {
      // Confirming took stock off the shelf and added to what the shop owes.
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    }
    if (walkIn) {
      // A walk-in sale also recorded the money that came in with it.
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    }
    setCreateFor(null);
    addToast(walkIn ? t('walkInSold') : confirmed ? t('orderCreatedConfirmed') : t('draftSaved'), 'success');
  };

  const confirmMutation = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      api.post(`/sales/orders/${id}/confirm`, { version }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['sale'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setViewingOrder(null);
      addToast(t('orderConfirmed'), 'success');
    },
    onError: (error: any) => {
      addToast(apiError(error, tc('error')), 'error');
    },
  });

  // Returns are recorded against a confirmed sale, per line.
  const [returningOrder, setReturningOrder] = useState<any | null>(null);
  const [returnQty, setReturnQty] = useState<Record<string, string>>({});
  const [returnRestock, setReturnRestock] = useState<Record<string, boolean>>({});

  const returnMutation = useMutation({
    mutationFn: (data: any) => api.post('/returns', data),
    onSuccess: () => {
      addToast(t('returnRecorded'), 'success');
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['sale'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
      setReturningOrder(null);
      setReturnQty({});
      setReturnRestock({});
    },
    onError: (error: any) => {
      addToast(
        apiError(error, t('returnFailed')),
        'error',
      );
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.post(`/sales/orders/${id}/cancel`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['sale'] });
      setViewingOrder(null);
      addToast(t('orderCancelled'), 'success');
    },
    onError: (error: any) => {
      addToast(apiError(error, tc('error')), 'error');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const orderList: SaleOrder[] = Array.isArray(orders) ? orders : [];
  const customerList: SaleFormCustomer[] = useMemo(
    () => (Array.isArray(customers) ? customers : []),
    [customers],
  );
  const productList: SaleFormProduct[] = Array.isArray(products) ? products : [];
  const stockList: SaleFormStockRow[] = Array.isArray(stockLevels) ? stockLevels : [];

  // Wait for the customers to load before opening: the channel is taken from
  // the customer's own type, and acting on an empty list would pick nothing
  // and leave the form on its B2B default regardless of who they are.
  useEffect(() => {
    const wanted = searchParams.get('customer');
    if (!wanted || openedFromCustomer.current || customerList.length === 0) return;
    if (!customerList.some((c) => c.id === wanted)) return;

    openedFromCustomer.current = true;
    setCreateFor({ customerId: wanted });

    // Drop the parameter once it has been used, so a refresh does not reopen
    // the form and a stale link cannot resurrect it later.
    router.replace(`/${locale}/sales`, { scroll: false });
  }, [searchParams, customerList, locale, router]);

  const STATUS_FILTER: Record<string, string> = {
    draft: 'DRAFT',
    confirmed: 'CONFIRMED',
    partiallyPaid: 'PARTIALLY_PAID',
    paid: 'PAID',
    cancelled: 'CANCELLED',
  };
  /** Who bought, as the reader sees it: a walk-in reads "Walk-in" in their language. */
  const buyerName = (o: SaleOrder) => (o.customer?.isWalkIn ? t('walkInCustomer') : o.customer?.displayName);
  const filtered = orderList.filter((o) => {
    const matchSearch =
      !search ||
      o.orderNo?.toLowerCase().includes(search.toLowerCase()) ||
      buyerName(o)?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || o.status === STATUS_FILTER[statusFilter];
    return matchSearch && matchStatus;
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  const openCreate = () => setCreateFor({});
  const closeCreate = () => setCreateFor(null);

  /** Enter or Space on a focused row opens it, as a click does. */
  const openOnKey = (order: SaleOrder) => (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setViewingOrder(order);
    }
  };

  /**
   * What a row says is owed. A draft owes nothing (BUSINESS_LOGIC §4) — its
   * stored `outstanding` is only the figure it would owe once confirmed — so
   * it shows a dash and says why, rather than a red number nobody owes.
   */
  const outstandingCell = (order: SaleOrder, withLabel = false) => {
    // A walk-in was paid as it was sold and has no account to owe on (§4).
    if (order.customer?.isWalkIn) {
      return (
        <span className="text-muted-foreground" data-testid="outstanding">
          {withLabel && `${t('outstanding')}: `}—{' '}
          <span className="text-xs">({t('walkInNoBalance')})</span>
        </span>
      );
    }
    if (order.status === 'DRAFT') {
      return (
        <span className="text-gray-400" data-testid="outstanding">
          {withLabel && `${t('outstanding')}: `}—{' '}
          <span className="text-xs">({t('notConfirmed')})</span>
        </span>
      );
    }
    return (
      <span
        data-testid="outstanding"
        className={`font-medium ${Number(order.outstanding) > 0 ? 'text-red-600' : 'text-green-600'}`}
      >
        {withLabel && `${t('outstanding')}: `}
        <Money value={order.outstanding} currency={order.currency} />
      </span>
    );
  };

  const detail = (orderDetail as SaleOrder) ?? viewingOrder;

  /** The buyer cell: a link to the customer, or "Walk-in", which has no page of its own. */
  const customerCell = (order: SaleOrder) =>
    order.customer?.isWalkIn ? (
      <span data-testid="walk-in-customer">{t('walkInCustomer')}</span>
    ) : (
      <CustomerLink id={order.customerId} name={order.customer?.displayName} />
    );


  // ── Columns ───────────────────────────────────────────────────────
  // Order #, customer, channel, status, total, outstanding, date, actions
  // (components/ui/data-table.tsx). Each fixed column fits its title in
  // English and Arabic; the amounts fit "-123,456.00 EGP" and are
  // end-aligned so the digits line up; the customer takes what is left.
  const columns: Column<SaleOrder>[] = [
    {
      key: 'orderNo', header: t('orderNo'), width: '8.5rem', skeleton: { kind: 'text', share: 'w-3/4' },
      cell: (order) => (
        // The whole row opens the order. The order number is a real button,
        // so a keyboard reaches the same place.
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setViewingOrder(order);
          }}
          aria-label={t('openOrder', { orderNo: order.orderNo })}
          title={order.orderNo}
          className="block max-w-full truncate font-mono text-xs font-medium text-primary-600 hover:underline"
        >
          {order.orderNo}
        </button>
      ),
    },
    {
      key: 'customer', header: t('customer'), width: 'auto', kind: 'name', className: 'text-gray-900',
      title: (order) => (order.customer?.isWalkIn ? t('walkInCustomer') : order.customer?.displayName),
      cellProps: () => ({ onClick: (e) => e.stopPropagation() }),
      cell: (order) => customerCell(order),
    },
    {
      key: 'channel', header: t('channel'), width: '6rem', skeleton: { kind: 'pill', share: 'w-1/2' },
      cell: (order) => channelBadge(order.channel),
    },
    {
      key: 'status', header: tc('status'), width: '8rem', skeleton: { kind: 'pill', share: 'w-3/4' },
      cell: (order) => statusBadge(order.status),
    },
    {
      key: 'total', header: t('total'), width: '9.5rem', kind: 'value', align: 'end',
      className: 'text-gray-900 font-medium', skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (order) => <Money value={order.total} currency={order.currency} />,
    },
    {
      key: 'outstanding', header: t('outstanding'), width: '9.5rem', kind: 'value', align: 'end',
      skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (order) => outstandingCell(order),
    },
    {
      key: 'date', header: t('date'), width: '7.5rem', kind: 'value', className: 'text-gray-500 text-xs',
      skeleton: { kind: 'text', share: 'w-3/4' },
      cell: (order) => formatDate(order.createdAt),
    },
    {
      // The real badges sit on the text's baseline, which makes the line 21px, not 20.
      key: 'actions', header: tc('actions'), width: '6rem', skeleton: { kind: 'text', share: 'w-2/3', line: 'h-5.25' },
      cell: (order) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setViewingOrder(order);
          }}
          className="inline-flex items-center gap-1 whitespace-nowrap text-primary-600 hover:text-primary-700 text-sm font-medium"
        >
          {tc('view')} <ChevronRight className="h-4 w-4 rtl:rotate-180" />
        </button>
      ),
    },
  ];

  // An order's lines: product, quantity, unit price, discount, line total.
  // On a phone the product takes the room: quantity, price and discount move
  // under its name and only the line total keeps a column (re-audit N5).
  const itemColumns: Column<SaleOrderItem>[] = [
    {
      key: 'product', header: t('product'), width: 'auto', title: (item) => localName(item.product, locale),
      cell: (item) => (
        <>
          <p className="font-medium text-gray-900 line-clamp-2 break-words" title={localName(item.product, locale)}>
            <ProductLink id={item.productId} name={localName(item.product, locale)} />
          </p>
          <p className="text-xs text-muted-foreground"><LatinText dir="ltr" truncate>{item.product?.sku}</LatinText></p>
          <p data-testid="item-phone-figures" className="sm:hidden mt-0.5 text-xs text-muted-foreground tabular-nums">
            <LatinText dir="ltr" className="whitespace-nowrap">{item.quantity} × {formatAmount(item.unitPrice)}</LatinText>
            {item.discount > 0 && (
              <>
                {' · '}
                <span className="whitespace-nowrap">
                  {t('discount')} <LatinText dir="ltr">- {formatAmount(item.discount)}</LatinText>
                </span>
              </>
            )}
          </p>
        </>
      ),
    },
    {
      key: 'quantity', header: t('quantity'), width: '5rem', kind: 'value', align: 'end', hiddenBelow: 'sm',
      className: 'text-gray-600', cell: (item) => item.quantity,
    },
    {
      key: 'unitPrice', header: t('unitPrice'), width: '7.5rem', kind: 'value', align: 'end', hiddenBelow: 'sm',
      className: 'text-gray-600', cell: (item) => <bdi dir="ltr">{formatAmount(item.unitPrice)}</bdi>,
    },
    {
      key: 'discount', header: t('discount'), width: '7.5rem', kind: 'value', align: 'end', hiddenBelow: 'sm',
      className: 'text-gray-600',
      cell: (item) => (item.discount > 0 ? <bdi dir="ltr">- {formatAmount(item.discount)}</bdi> : '—'),
    },
    {
      // What the server stored for the line, not a re-derivation of it.
      key: 'lineTotal', header: t('lineTotal'), width: '8.5rem', kind: 'value', align: 'end',
      className: 'font-medium text-gray-900',
      cell: (item) => <Money value={item.lineTotal} currency={detail?.currency} />,
    },
  ];

  // ── Render ────────────────────────────────────────────────────────
  const statusBadge = (status: string) => (
    <span
      className={`inline-flex items-center whitespace-nowrap px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-600'}`}
    >
      {codeLabel('orderStatus', status)}
    </span>
  );
  const channelBadge = (channel: string) => (
    <span
      className={`inline-flex items-center whitespace-nowrap px-2.5 py-0.5 rounded-full text-xs font-medium ${
        channel === 'B2B' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'
      }`}
    >
      {channel === 'B2B' ? t('b2b') : t('b2c')}
    </span>
  );
  // Nothing at all yet, as opposed to nothing matching the search or chip.
  const noOrdersYet = !isLoading && orderList.length === 0 && !dated && !listError;

  /**
   * The rows the filters show — every page of them, not the visible one —
   * as a spreadsheet. Money goes out as numbers so it can be summed; the day
   * is the day in Cairo the order was placed, the one the filter reads.
   */
  const exportCsv = () =>
    downloadCsv(datedFilename('sales'), filtered, [
      { header: t('orderNo'), value: (o) => o.orderNo },
      { header: t('date'), value: (o) => businessToday(new Date(o.orderedAt ?? o.createdAt)) },
      { header: t('customer'), value: (o) => buyerName(o) ?? '' },
      { header: t('channel'), value: (o) => o.channel },
      { header: tc('status'), value: (o) => codeLabel('orderStatus', o.status) },
      { header: t('currency'), value: (o) => o.currency },
      { header: t('total'), value: (o) => Number(o.total) },
      {
        header: t('outstanding'),
        // A draft owes nothing yet and a walk-in never owes (§4).
        value: (o) => (o.status === 'DRAFT' || o.customer?.isWalkIn ? 0 : Number(o.outstanding)),
      },
    ]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="sales-export"
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="bg-background inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50 sm:min-h-0"
        >
          <Download className="h-4 w-4" />
          {tc('export')}
        </button>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex min-h-11 items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors sm:min-h-0"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
        </button>
        </div>
      </div>

      {/* Search + Filter Tabs */}
      <div className="space-y-3">
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
        <DateRangeFilter idPrefix="sales" value={dates} onChange={setDates} busy={reloading} />
        {listError && (
          <p role="alert" data-testid="sales-range-error" className="text-sm text-destructive">
            {apiError(listError, tc('error'))}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={statusFilter === tab}
              onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === tab
                  ? 'bg-primary-600 text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {t(tab)}
            </button>
          ))}
        </div>
      </div>

      <ListCapNotice capped={capped} count={orders.length} />

      {/* Loading: the table's own header over skeleton rows, skeleton cards on a phone. */}
      {isLoading && <LoadingStatus />}

      {/* Nothing sold yet: say what goes here, and offer the way to start. */}
      {noOrdersYet && (
        <div className="bg-white rounded-xl border border-gray-200">
          <EmptyState
            icon={ShoppingCart}
            title={t('noSales')}
            description={t('noSalesHint')}
            action={{ label: t('create'), onClick: openCreate }}
          />
        </div>
      )}

      {/* Desktop Table — the shared one (components/ui/data-table.tsx). */}
      {!noOrdersYet && (
        <DataTable
          testId="sales-table"
          className="hidden md:block"
          columns={columns}
          rows={paginated}
          rowKey={(o) => o.id}
          isLoading={isLoading}
          stale={reloading}
          onRowClick={(order) => setViewingOrder(order)}
          rowProps={() => ({ 'data-testid': 'sale-row' })}
          empty={<NoMatch filtered={statusFilter !== 'all' || dated} onClear={clearFilters} />}
        />
      )}

      {/* Mobile Cards */}
      {isLoading && (
        <SkeletonGroup className="md:hidden space-y-3">
          {repeat(PAGE_SIZE, (i) => <SaleCardSkeleton key={i} />)}
        </SkeletonGroup>
      )}
      {!isLoading && !noOrdersYet && (
        <div data-testid="sales-cards" aria-busy={reloading} className={`md:hidden space-y-3 transition-opacity ${reloading ? 'opacity-60' : ''}`}>
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200"><NoMatch filtered={statusFilter !== 'all' || dated} onClear={clearFilters} /></div>
          ) : (
            paginated.map((order) => (
              <div
                key={order.id}
                role="button"
                tabIndex={0}
                data-testid="sale-card"
                aria-label={t('openOrder', { orderNo: order.orderNo })}
                onClick={() => setViewingOrder(order)}
                onKeyDown={openOnKey(order)}
                className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer select-none hover:shadow-md active:bg-gray-50 transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-sm font-bold text-primary-600">{order.orderNo}</span>
                  {statusBadge(order.status)}
                </div>
                <p className="text-sm text-gray-700" onClick={(e) => e.stopPropagation()}>
                  {customerCell(order)}
                </p>
                <div className="flex items-center gap-3 mt-2 text-sm">
                  {channelBadge(order.channel)}
                  <span className="font-medium text-gray-900"><Money value={order.total} currency={order.currency} /></span>
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
                  <span>{formatDate(order.createdAt)}</span>
                  {outstandingCell(order, true)}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Pagination */}
      {!isLoading && filtered.length > 0 && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} totalItems={filtered.length} />
      )}

      {/* ─── Create Modal ──────────────────────────────────────────── */}
      {createFor && (
        <SaleOrderForm
          title={t('create')}
          customers={customerList}
          products={productList}
          stock={stockList}
          initialCustomerId={createFor.customerId}
          onCancel={closeCreate}
          onSaved={onOrderSaved}
        />
      )}

      {/* ─── View Order Detail ──────────────────────────────────────── */}
      {viewingOrder && detail && (
        <Dialog
          title={detail.orderNo}
          onClose={() => setViewingOrder(null)}
          size="lg"
          footer={
            // A cancelled order offers nothing to do; an empty bar would only say so.
            detail.status === 'CANCELLED' && !canTakePayment(detail) ? undefined : (
              <>
              {/* A confirmed sale has an invoice / delivery note; a draft is
                  not a sale yet and a cancelled order never happened (§4). */}
              {detail.status !== 'DRAFT' && detail.status !== 'CANCELLED' && (
                <Link
                  href={`/${locale}/sales/${detail.id}/invoice`}
                  data-testid="order-invoice"
                  className="bg-background inline-flex cursor-pointer items-center gap-2 px-4 py-2 text-sm border border-border text-foreground rounded-lg hover:bg-muted"
                >
                  <FileText className="h-4 w-4" />
                  {t('invoice.open')}
                </Link>
              )}
              {canTakePayment(detail) && (
                <button
                  type="button"
                  data-testid="order-record-payment"
                  onClick={() => setPayingOrder(detail)}
                  className="inline-flex cursor-pointer items-center gap-2 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
                >
                  <Wallet className="h-4 w-4" />
                  {tp('recordPayment')}
                </button>
              )}
              {detail.status === 'DRAFT' && (
                <>
                  <button
                    onClick={() => setCancellingOrder(detail)}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
                  >
                    <Ban className="h-4 w-4" />
                    {t('cancel')}
                  </button>
                  <button
                    onClick={() => confirmMutation.mutate({ id: detail.id, version: detail.version ?? 1 })}
                    disabled={confirmMutation.isPending}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                  >
                    <CheckCircle className="h-4 w-4" />
                    {t('confirm')}
                  </button>
                </>
              )}
              {['CONFIRMED', 'PARTIALLY_PAID', 'PAID'].includes(detail.status) && (
                <button
                  onClick={() => setReturningOrder(detail)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  <Undo2 className="h-4 w-4" />
                  {t('recordReturn')}
                </button>
              )}
              {/* No cancel for a partially paid order. Money has come in
                  against it, and cancelling would leave that payment attached
                  to a dead order — collected, clearing nothing, unusable
                  anywhere else. Record a return, which moves the goods, the
                  cost and the cash together. */}
              {detail.status === 'CONFIRMED' && (
                <button
                  onClick={() => setCancellingOrder(detail)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
                >
                  <Ban className="h-4 w-4" />
                  {t('cancel')}
                </button>
              )}
              </>
            )
          }
        >
          <div className="space-y-6">
            {/* Info */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('customer')} value={detail.customer?.isWalkIn ? t('walkInCustomer') : <LatinText>{detail.customer?.displayName ?? '—'}</LatinText>} />
              <Detail label={t('channel')} value={detail.channel === 'B2B' ? t('b2b') : t('b2c')} />
              <Detail label={t('total')} value={<Money value={detail.total} currency={detail.currency} />} />
              <Detail label={t('outstanding')} value={outstandingCell(detail)} />
              <Detail label={t('date')} value={formatDate(detail.createdAt)} />
              <Detail label={tc('status')} value={codeLabel('orderStatus', detail.status)} />
            </div>

            {/* Items */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">{t('items')}</h3>
              {(detail.items ?? []).length === 0 ? (
                <EmptyState size="compact" icon={Package} title={t('noItemsTitle')} description={t('noItemsHint')} />
              ) : (
                <DataTable
                  frame="none"
                  density="compact"
                  autoMin="9rem"
                  columns={itemColumns}
                  rows={detail.items ?? []}
                  rowKey={(item) => item.id}
                />
              )}
            </div>

            {/* Allocations */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">{t('allocations')}</h3>
              {(detail.items ?? []).flatMap((item: SaleOrderItem) => item.allocations ?? []).length === 0 ? (
                <EmptyState
                  size="compact"
                  icon={Package}
                  title={t('noAllocationsTitle')}
                  description={detail.status === 'DRAFT' ? t('noAllocationsDraftHint') : undefined}
                />
              ) : (
                <div className="space-y-2">
                  {(detail.items ?? []).flatMap((item: SaleOrderItem) =>
                    (item.allocations ?? []).map((alloc) => (
                      <div key={alloc.id} className="flex items-center justify-between bg-blue-50 rounded-lg px-4 py-3 text-sm gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <Package className="h-4 w-4 text-blue-500 shrink-0" />
                          <div className="min-w-0">
                            <p className="font-medium text-gray-900">
                              <ProductLink truncate id={item.productId} name={localName(item.product, locale)} />
                            </p>
                            {/* Each piece stays whole, so a narrow card breaks
                                between the batch and its cost, never inside
                                "117.30 EGP /unit" (re-audit N5). */}
                            <p className="text-xs text-gray-500">
                              <span className="whitespace-nowrap">{t('batch')} <BatchRef id={alloc.inventoryBatchId} /></span>
                              {alloc.unitCostEgp != null && (
                                <>
                                  {' '}
                                  <span data-testid="allocation-unit-cost" className="whitespace-nowrap">
                                    {'· '}
                                    <Money value={alloc.unitCostEgp} />
                                    {' '}
                                    {t('perUnitCost')}
                                  </span>
                                </>
                              )}
                            </p>
                          </div>
                        </div>
                        {/* The batch cost is the whole point of tracking batches:
                            it is the COGS this sale is charged and can never be
                            recomputed from today's prices. */}
                        <div className="text-end shrink-0">
                          <p className="font-medium text-gray-900">× {alloc.qty}</p>
                          {alloc.cogsEgp != null && (
                            <p className="text-xs text-gray-500">
                              <Money value={alloc.cogsEgp} /> {t('cogs')}
                            </p>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Payment History */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">{t('paymentHistory')}</h3>
              {(detail.paymentAllocations ?? []).length === 0 ? (
                <EmptyState
                  size="compact"
                  icon={Wallet}
                  title={t('noPaymentsTitle')}
                  description={detail.status === 'DRAFT' ? t('noPaymentsDraftHint') : t('noPaymentsHint')}
                />
              ) : (
                <div className="space-y-2">
                  {(detail.paymentAllocations ?? []).map((alloc: any) => {
                    const payment = alloc?.payment ?? alloc;
                    if (!payment) return null;
                    return (
                      <div key={alloc.id ?? payment.id} className="flex items-center justify-between bg-green-50 rounded-lg px-4 py-3 text-sm">
                        <div>
                          <p className="font-medium text-gray-900"><Money value={alloc.amount ?? payment.amount} currency={detail.currency} /></p>
                          <p className="text-xs text-gray-500">{codeLabel('paymentMethod', payment.method)} · {payment.reference ?? '—'}</p>
                        </div>
                        <span className="text-xs text-gray-500">{formatDate(payment.receivedOn)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Below cost (§4, 2026-10-11): the confirm step says it again,
                and Confirm still goes through. */}
            {detail.status === 'DRAFT' && <DraftBelowCost order={detail} />}

            {/* Actions */}
          </div>
        </Dialog>
      )}

      <RecordPaymentDialog
        open={!!payingOrder}
        order={payingOrder}
        onClose={() => setPayingOrder(null)}
      />

      {/* ─── Return Modal ──────────────────────────────────────────── */}
      {cancellingOrder && (
        <Dialog
          title={`${t('cancel')} — ${cancellingOrder.orderNo}`}
          onClose={() => setCancellingOrder(null)}
          size="md"
          footer={
            <>
              <button
                type="button"
                onClick={() => setCancellingOrder(null)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
              >
                {t('keepOrder')}
              </button>
              <button
                type="button"
                onClick={() => {
                  cancelMutation.mutate(cancellingOrder.id);
                  setCancellingOrder(null);
                }}
                disabled={cancelMutation.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {cancelMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                <Ban className="h-4 w-4" />
                {t('cancel')}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {t('cancelWarning')}
            </p>
            <div className="rounded-lg bg-gray-50 px-4 py-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">{t('customer')}</span>
                <span className="font-medium text-gray-900">
                  {buyerName(cancellingOrder) ?? '—'}
                </span>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-gray-500">{t('total')}</span>
                <span className="font-medium text-gray-900">
                  <Money value={Number(cancellingOrder.total)} currency={cancellingOrder.currency} />
                </span>
              </div>
            </div>
          </div>
        </Dialog>
      )}

      {returningOrder && (
        <Dialog
          title={`${t('recordReturn')} — ${returningOrder.orderNo}`}
          onClose={() => setReturningOrder(null)}
          size="lg"
          footer={
            <>
              <button
                type="button"
                onClick={() => setReturningOrder(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                {tc('cancel')}
              </button>
              <button
                type="submit"
                form="sales-4-form"
                disabled={returnMutation.isPending}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                {returnMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('recordReturn')}
              </button>
            </>
          }
        >
          <ValidatedForm id="sales-4-form"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const items = (returningOrder.items ?? [])
                .map((it: any) => ({
                  saleItemId: it.id,
                  qty: Number(returnQty[it.id] ?? 0),
                  restock: returnRestock[it.id] !== false,
                }))
                .filter((i: any) => i.qty > 0);

              if (items.length === 0) {
                addToast(t('returnNeedsQuantity'), 'error');
                return;
              }

              returnMutation.mutate({
                saleOrderId: returningOrder.id,
                reason: String(fd.get('reason') || ''),
                refundMethod: String(fd.get('refundMethod') || 'CREDIT_NOTE'),
                items,
              });
            }}
            className="space-y-4"
          >
            <p className="text-sm text-gray-600">{t('returnHelp')}</p>

            <div className="space-y-2">
              {(returningOrder.items ?? []).map((it: any) => (
                <div key={it.id} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">
                        <ProductLink id={it.productId} name={localName(it.product, locale)} />
                      </p>
                      <p className="text-xs text-gray-500">
                        {t('quantity')}: {it.quantity} · <Money value={it.unitPrice} currency={returningOrder.currency} />
                      </p>
                    </div>
                    <input
                      type="number"
                      min="0"
                      max={Number(it.quantity)}
                      step="0.001"
                      placeholder={tph('quantitySmall')}
                      value={returnQty[it.id] ?? ''}
                      onChange={(e) => setReturnQty((q) => ({ ...q, [it.id]: e.target.value }))}
                      className="w-24 shrink-0 rounded-lg border border-gray-200 px-3 py-2 text-sm text-start focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </div>
                  {Number(returnQty[it.id] ?? 0) > 0 && (
                    <label className="mt-2 flex items-center gap-2 text-xs text-gray-600">
                      <input
                        type="checkbox"
                        checked={returnRestock[it.id] !== false}
                        onChange={(e) =>
                          setReturnRestock((r) => ({ ...r, [it.id]: e.target.checked }))
                        }
                      />
                      {/* Unchecked means damaged: refunded, but written off
                          rather than put back on the shelf. */}
                      {t('putBackInStock')}
                    </label>
                  )}
                </div>
              ))}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('refundMethod')}
              </label>
              {/* A walk-in has no account to hold a credit, so its refund is
                  money (§4); the server refuses a credit note on one. */}
              <Select
                name="refundMethod"
                placeholder={tph('chooseRefundMethod')}
                defaultValue={returningOrder.customer?.isWalkIn ? 'CASH' : 'CREDIT_NOTE'}
                options={[
                  ...(returningOrder.customer?.isWalkIn
                    ? []
                    : [{ value: 'CREDIT_NOTE', label: t('creditNote') }]),
                  { value: 'CASH', label: t('cashRefund') },
                ]}
              />
            </div>

            <TextareaField
              label={t('reason')}
              name="reason"
              required
              minLength={3}
              placeholder={t('reasonPlaceholder')}
            />
          </ValidatedForm>
        </Dialog>
      )}
    </div>
  );
}

/**
 * A draft about to be confirmed, checked against what its goods cost now —
 * the stock may have moved since it was written. A warning above Confirm,
 * never in its way.
 */
function DraftBelowCost({ order }: { order: { currency: string; items?: SaleOrderItem[] } }) {
  const items = order.items ?? [];
  const result = usePriceCheck(items, order.currency);
  const locale = useLocale();
  return (
    <BelowCostSummary
      result={result}
      names={items.map((i) => localName(i.product, locale))}
    />
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

/**
 * The page reads `?customer=<id>` to open the order form on a particular shop.
 * `useSearchParams` cannot be prerendered — the query string is only known in
 * the browser — so Next requires a Suspense boundary saying where the static
 * part stops. Without it `next build` fails on this page; `next dev` never
 * mentions it.
 */
export default function SalesPage() {
  return (
    <Suspense fallback={null}>
      <SalesPageContent />
    </Suspense>
  );
}
