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
  Plus, Loader2,
  ChevronRight, CheckCircle, Ban, Package,
  Undo2, ShoppingCart, Wallet, FileText, PackageOpen, PackageX, PackageCheck,
} from '@/components/ui/icons';
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
import { Download } from '@/components/ui/icons';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { ContractButton, ContractPlanDialog, type ContractSale } from '@/components/sales/contract-plan';
import { AdjustPriceButton, AdjustPriceDialog } from '@/components/sales/adjust-price';
import { OrderHistory } from '@/components/sales/order-history';
import { LineHeldNote, LineTotalNow, LineUnitPrice, OrderTotal } from '@/components/sales/value-now';
import { TabBar } from '@/components/ui/tab-bar';
import { isSamplesStatus, samplesUnits } from '@/lib/samples';
import { useCan } from '@/lib/can';
import { FilterPills, ListToolbar } from '@/components/ui/list-toolbar';
import { SalesSummary } from '@/components/summary/tab-summaries';
// ─── Types ────────────────────────────────────────────────────────────
interface SaleOrder {
  /** The branch it was sold to (§7, 2026-10-25); null on the owner. */
  branch?: { id: string; name: string } | null;
  id: string;
  orderNo: string;
  customerId: string;
  /** `isWalkIn`: the shared walk-in record (§4) — shown as "Walk-in", never as a name. */
  customer?: { displayName: string; isWalkIn?: boolean };
  channel: string;
  status: string;
  total: number;
  /** What it is worth now: sold less returns less price cuts (§4, 2026-10-22), the API's figure. */
  valueNowEgp?: string;
  outstanding: number;
  currency: string;
  version: number;
  createdAt: string;
  /** When it was ordered — what the date filter reads (BUSINESS_LOGIC §4). */
  orderedAt?: string;
  items?: SaleOrderItem[];
  paymentAllocations?: PaymentAllocation[];
  /** The sale's instalment plan, from the detail (§7, 2026-10-16). */
  contractPlan?: ContractSale['contractPlan'];
  /**
   * Samples left at a shop (§4, samples at shops), worked out by the API:
   * units out, the day left, days since, the reminder day. Null for an order
   * that never was samples.
   */
  samples?: {
    open: boolean;
    unitsOut: string;
    leftOn: string;
    daysAtShop: number;
    reminderOn: string;
    remindedAt: string | null;
    decidedAt: string | null;
  } | null;
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
  product?: { name: string; nameAr?: string | null; sku: string };
  quantity: number;
  unitPrice: number;
  discount: number;
  lineTotal?: number | string;
  /** The line now (§4, 2026-10-22), from the API: units back and held, price and worth now. */
  returnedQty?: string;
  heldQty?: string;
  soldUnitPrice?: string;
  unitPriceNow?: string;
  priceCut?: boolean;
  lineValueNow?: string;
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
  // Samples at a shop (§4): amber, "not a sale yet".
  SAMPLES: 'bg-accent-100 text-accent-800',
  SAMPLES_RETURNED: 'bg-muted text-muted-foreground',
  SAMPLES_WRITTEN_OFF: 'bg-destructive/10 text-destructive',
};

const FILTER_TABS = ['all', 'draft', 'confirmed', 'partiallyPaid', 'paid', 'cancelled', 'samplesFilter'] as const;

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
  const th = useTranslations('sales.history');
  const tb = useTranslations('branches');
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
  const [openedOrder, setOpenedOrder] = useState<SaleOrder | null>(null);
  const codeLabel = useCodeLabel();
  // Dates in the reader's language (UX #10).
  const { formatDate } = useDateFormat();
  // Cancelling is not undoable and the button sits beside Confirm, so it asks
  // first rather than acting on the click.
  const [cancellingOrder, setCancellingOrder] = useState<SaleOrder | null>(null);
  // "Record payment" on a confirmed order that still owes (U2): the money goes
  // on that order, through the one payment form.
  const [payingOrder, setPayingOrder] = useState<SaleOrder | null>(null);
  // The Contract button's plan popup (§7, 2026-10-16).
  const [contractFor, setContractFor] = useState<SaleOrder | null>(null);
  // Lowering a price after the order is confirmed (§4, 2026-10-22).
  const [adjustingOrder, setAdjustingOrder] = useState<SaleOrder | null>(null);
  // The popup's two views: the order as it stands, and how it got there (§4).
  const [orderView, setOrderView] = useState<'orderDetails' | 'orderHistory'>('orderDetails');
  // Samples at a shop (§4): what the shop decided.
  // "They're buying" opens the New Order popup on the samples (§4 round 2).
  const [completingSamples, setCompletingSamples] = useState<SaleOrder | null>(null);
  const [returningSamples, setReturningSamples] = useState<SaleOrder | null>(null);
  const [writingOffSamples, setWritingOffSamples] = useState<SaleOrder | null>(null);
  const canWriteOff = useCan('sale.samplesWriteOff');
  const tsm = useTranslations('sales.samples');

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

  // `?order=<id>` — a notification's link (the samples reminder, §4) — opens
  // that order as soon as its row is on the list. Read once, and forgotten the
  // moment any order is opened or closed, so it never reopens behind the user.
  const [linkedOrderId, setLinkedOrderId] = useState(() => searchParams.get('order'));
  const linkedOrder = linkedOrderId
    ? ((orders as SaleOrder[]).find((o) => o.id === linkedOrderId) ?? null)
    : null;
  const viewingOrder = openedOrder ?? linkedOrder;
  const setViewingOrder = (order: SaleOrder | null) => {
    if (linkedOrderId) {
      setLinkedOrderId(null);
      router.replace(`/${locale}/sales`, { scroll: false });
    }
    setOrderView('orderDetails');
    setOpenedOrder(order);
  };
  // A summary card opens its order here: from the list when the order is on
  // it, otherwise fetched into the detail's own cache entry first, so the
  // dialog opens with the whole order rather than a half-drawn one.
  const openOrderById = async (id: string) => {
    const listed = (orders as SaleOrder[]).find((o) => o.id === id);
    if (listed) return setViewingOrder(listed);
    const order = await queryClient.fetchQuery({
      queryKey: ['sale', id],
      queryFn: () => api.get(`/sales/orders/${id}`).then((r) => r.data.data ?? r.data),
    });
    setViewingOrder(order as SaleOrder);
  };
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
  const onOrderSaved = ({ confirmed, walkIn, samples }: SavedOrder) => {
    void queryClient.invalidateQueries({ queryKey: ['sales'] });
    if (samples) {
      // The units left the shelf; nothing is owed.
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      setCreateFor(null);
      addToast(tsm('leave'), 'success');
      return;
    }
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

  /** "Returned" and "Write off" (§4): the samples come back, or never will. */
  const samplesMutation = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: 'return' | 'write-off'; reason?: string }) =>
      api.post(`/sales/orders/${id}/samples/${action}`, action === 'write-off' ? { reason } : undefined),
    onSuccess: (_res, { action }) => {
      for (const key of ['sales', 'sale', 'inventory', 'analytics']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      setReturningSamples(null);
      setWritingOffSamples(null);
      setViewingOrder(null);
      addToast(action === 'return' ? tsm('returnedToast') : tsm('writtenOffToast'), 'success');
    },
    onError: (error: unknown) => {
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

  /**
   * The samples hint's link (§4, owner 2026-10-25): New Order closes and that
   * samples order's "They're buying" opens, with every line it carries — read
   * fresh, so it is the order as it stands, not as a list row last saw it.
   */
  const openBuying = async (id: string) => {
    try {
      const order = await queryClient.fetchQuery({
        queryKey: ['sale', id],
        queryFn: () => api.get(`/sales/orders/${id}`).then((r) => r.data.data ?? r.data),
        staleTime: 0,
      });
      setCreateFor(null);
      setCompletingSamples(order as SaleOrder);
    } catch (error) {
      addToast(apiError(error, tc('error')), 'error');
    }
  };

  // `?buying=<id>` — the samples hint under a sale preview in the office chat
  // — opens the same "They're buying", once the shops and products it shows
  // have loaded; dropped once used, like `?customer=`.
  // The chat floats over every page, so a second link can arrive while this
  // page stays mounted: what was opened is forgotten once the URL drops it.
  const openedBuying = useRef<string | null>(null);
  useEffect(() => {
    const wanted = searchParams.get('buying');
    if (!wanted) {
      openedBuying.current = null;
      return;
    }
    if (openedBuying.current === wanted || customerList.length === 0 || productList.length === 0) return;
    openedBuying.current = wanted;
    router.replace(`/${locale}/sales`, { scroll: false });
    void openBuying(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the lists arrive
  }, [searchParams, customerList, productList.length, locale, router]);


  const STATUS_FILTER: Record<string, string> = {
    draft: 'DRAFT',
    confirmed: 'CONFIRMED',
    partiallyPaid: 'PARTIALLY_PAID',
    paid: 'PAID',
    cancelled: 'CANCELLED',
    samplesFilter: 'SAMPLES',
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
    // Samples are not a sale and owe nothing (§4, samples at shops).
    if (isSamplesStatus(order.status)) {
      return (
        <span className="text-muted-foreground" data-testid="outstanding">
          {withLabel && `${t('outstanding')}: `}—{' '}
          <span className="text-xs">({tsm('noChargeCell')})</span>
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
      <span className="min-w-0">
        <CustomerLink id={order.customerId} name={order.customer?.displayName} />
        {/* The branch under the owner's name (§7, 2026-10-25). */}
        {order.branch && (
          <span data-testid="sale-branch-cell" className="block truncate text-xs text-muted-foreground">
            <LatinText>{order.branch.name}</LatinText>
          </span>
        )}
      </span>
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
      // Only the name itself leaves for the customer's page (its link stops the
      // click); the rest of the cell opens the order like the rest of the row.
      cell: (order) => customerCell(order),
    },
    {
      key: 'channel', header: t('channel'), width: '6rem', skeleton: { kind: 'pill', share: 'w-1/2' },
      cell: (order) => channelBadge(order.channel),
    },
    {
      // Wide enough for its longest pill, "Samples written off" (128px; "Samples · 12 units"
      // is 122px) in either language. It was 12.5rem, which squeezed Customer to its
      // minimum at 1440 and wrapped a plain shop name onto two lines (2026-10-21).
      key: 'status', header: tc('status'), width: '10.5rem', skeleton: { kind: 'pill', share: 'w-3/4' },
      cell: (order) => statusBadge(order.status, order),
    },
    {
      // Wide enough for "sold at -123,456.00 EGP" under the value now (§4,
      // 2026-10-22): 134px at text-xs; 9.5rem left 120.
      key: 'total', header: t('total'), width: '10.5rem', kind: 'value', align: 'end',
      className: 'text-gray-900 font-medium', skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (order) => totalCell(order),
    },
    {
      key: 'outstanding', header: t('outstanding'), width: '9.5rem', kind: 'value', align: 'end',
      skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (order) => outstandingCell(order),
    },
    {
      key: 'date', header: t('date'), width: '7rem', kind: 'value', className: 'text-gray-500 text-xs',
      skeleton: { kind: 'text', share: 'w-3/4' },
      // The day it was sold, which a back-dated sale has before the day it was typed in (§4).
      cell: (order) => formatDate(order.orderedAt ?? order.createdAt),
    },
    {
      // The real badges sit on the text's baseline, which makes the line 21px, not 20.
      key: 'actions', header: tc('actions'), width: '5.5rem', skeleton: { kind: 'text', share: 'w-2/3', line: 'h-5.25' },
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
          <LineHeldNote line={item} />
          <p data-testid="item-phone-figures" className="sm:hidden mt-0.5 text-xs text-muted-foreground tabular-nums">
            <LatinText dir="ltr" className="whitespace-nowrap">
              {/* Samples with no price noted: the quantity alone, not "× 0.00" (§4). */}
              {isSamplesStatus(detail?.status ?? '') && !(Number(item.unitPrice) > 0)
                ? item.quantity
                : `${item.quantity} × ${formatAmount(item.unitPrice)}`}
              {/* Lowered after the sale (§4): the price now follows, in the same
                  left-to-right run so the arrow points the same way in Arabic. */}
              {item.priceCut && item.unitPriceNow != null && ` → ${formatAmount(item.unitPriceNow)}`}
            </LatinText>
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
      className: 'text-gray-600',
      cell: (item) =>
        isSamplesStatus(detail?.status ?? '') && !(Number(item.unitPrice) > 0) ? (
          '—'
        ) : (
          <LineUnitPrice line={item} sold={<bdi dir="ltr">{formatAmount(item.unitPrice)}</bdi>} />
        ),
    },
    {
      key: 'discount', header: t('discount'), width: '7.5rem', kind: 'value', align: 'end', hiddenBelow: 'sm',
      className: 'text-gray-600',
      cell: (item) => (item.discount > 0 ? <bdi dir="ltr">- {formatAmount(item.discount)}</bdi> : '—'),
    },
    {
      // The server's figures for the line, not a re-derivation of them: what
      // it is worth now, and what it was sold at beneath when that differs (§4).
      // 9rem: "sold at 123,456.00 EGP" is 129px at text-xs; 8.5rem left 128.
      key: 'lineTotal', header: t('lineTotal'), width: '9rem', kind: 'value', align: 'end',
      className: 'font-medium text-gray-900',
      cell: (item) =>
        isSamplesStatus(detail?.status ?? '') ? (
          <span className="text-xs font-normal text-muted-foreground">{tsm('noChargeCell')}</span>
        ) : (
          <LineTotalNow line={item} currency={detail?.currency} />
        ),
    },
  ];

  // ── Render ────────────────────────────────────────────────────────
  // Samples still at the shop read "Samples · N units" (§4).
  const statusBadge = (status: string, order?: SaleOrder) => (
    <span
      data-testid={status === 'SAMPLES' ? 'samples-badge' : undefined}
      title={status === 'SAMPLES' && order ? tsm('badge', { units: samplesUnits(order) }) : undefined}
      className={`inline-flex max-w-full items-center truncate whitespace-nowrap px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-600'}`}
    >
      {status === 'SAMPLES' && order
        ? tsm('badge', { units: samplesUnits(order) })
        : codeLabel('orderStatus', status)}
    </span>
  );
  /** A sale's total, or "No charge" for samples, which are worth nothing as a sale yet. */
  const totalCell = (order: SaleOrder) =>
    isSamplesStatus(order.status) ? (
      <span className="text-xs font-normal text-muted-foreground">{tsm('noChargeCell')}</span>
    ) : (
      <OrderTotal total={order.total} valueNow={order.valueNowEgp} currency={order.currency} />
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
        // A draft owes nothing yet, a walk-in never owes, and samples are not a sale (§4).
        value: (o) =>
          o.status === 'DRAFT' || o.customer?.isWalkIn || isSamplesStatus(o.status) ? 0 : Number(o.outstanding),
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

      {/* The sale that brought in the most and the largest one (owner 2026-10-18). */}
      <SalesSummary onOpen={(id) => void openOrderById(id).catch((e) => addToast(apiError(e, tc('error')), 'error'))} />

      {/* Search + Filter Tabs */}
      <ListToolbar
        search={{ value: search, onChange: setSearch, placeholder: t('search') }}
        after={
          listError && (
            <p role="alert" data-testid="sales-range-error" className="text-sm text-destructive">
              {apiError(listError, tc('error'))}
            </p>
          )
        }
      >
        <DateRangeFilter idPrefix="sales" value={dates} onChange={setDates} busy={reloading} />
        <FilterPills
          label={t('statusFilter')}
          testId="sales-status-filter"
          value={statusFilter}
          onChange={setStatusFilter}
          options={FILTER_TABS.map((tab) => ({ value: tab, label: t(tab) }))}
        />
      </ListToolbar>

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
          // The status column grew for "Samples · N units" (§4); the
          // customer gives up the room, so the table still fits a laptop.
          autoMin="11rem"
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
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="font-mono text-sm font-bold text-primary-600">{order.orderNo}</span>
                  {statusBadge(order.status, order)}
                </div>
                <p className="text-sm text-gray-700">
                  {customerCell(order)}
                </p>
                <div className="flex items-center gap-3 mt-2 text-sm">
                  {channelBadge(order.channel)}
                  <span className="font-medium text-gray-900">{totalCell(order)}</span>
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
                  <span>{formatDate(order.orderedAt ?? order.createdAt)}</span>
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
          onOpenSamples={(order) => void openBuying(order.id)}
        />
      )}

      {/* ─── View Order Detail ──────────────────────────────────────── */}
      {viewingOrder && detail && (
        <Dialog
          title={detail.orderNo}
          onClose={() => setViewingOrder(null)}
          size="lg"
          footer={
            // Samples at the shop: what the shop decided, and nothing else (§4).
            detail.status === 'SAMPLES' ? (
              <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:justify-end">
                {canWriteOff && (
                  <button
                    type="button"
                    data-testid="samples-write-off"
                    onClick={() => setWritingOffSamples(detail)}
                    className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-destructive/40 px-4 py-2 text-sm text-destructive hover:bg-destructive/10 sm:min-h-0"
                  >
                    <PackageX className="h-4 w-4" />
                    {tsm('writeOff')}
                  </button>
                )}
                <button
                  type="button"
                  data-testid="samples-returned"
                  onClick={() => setReturningSamples(detail)}
                  className={`bg-background inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-muted sm:min-h-0 ${canWriteOff ? '' : 'col-span-2'}`}
                >
                  <Undo2 className="h-4 w-4" />
                  {tsm('returned')}
                </button>
                <button
                  type="button"
                  data-testid="samples-buying"
                  onClick={() => setCompletingSamples(detail)}
                  className="order-first col-span-2 inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:order-none sm:min-h-0"
                >
                  <PackageCheck className="h-4 w-4" />
                  {tsm('buying')}
                </button>
              </div>
            ) : isSamplesStatus(detail.status) ||
            // A cancelled order offers nothing to do; an empty bar would only say so.
            (detail.status === 'CANCELLED' && !canTakePayment(detail)) ? undefined : (
              // Two to a row on a phone, Record payment first across the row: a
              // confirmed sale has five actions, and one per row put a third of
              // the screen under the buttons.
              <div
                data-testid="order-actions"
                className="grid w-full grid-cols-2 gap-2 max-sm:[&>*]:justify-center max-sm:[&>*]:px-2 max-sm:[&>*]:whitespace-nowrap sm:flex sm:w-auto sm:flex-wrap sm:justify-end sm:gap-3"
              >
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
              {/* Only once the detail has said whether the sale has its plan:
                  the list row does not know, and would offer a second one. */}
              {orderDetail && (
                <ContractButton sale={detail} onAgree={() => setContractFor(detail)} />
              )}
              {orderDetail && (
                <AdjustPriceButton sale={detail} onOpen={() => setAdjustingOrder(detail)} />
              )}
              {canTakePayment(detail) && (
                <button
                  type="button"
                  data-testid="order-record-payment"
                  onClick={() => setPayingOrder(detail)}
                  className="max-sm:order-first max-sm:col-span-2 inline-flex cursor-pointer items-center gap-2 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
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
              </div>
            )
          }
        >
          <TabBar
            className="mb-4"
            label={th('tabsLabel')}
            value={orderView}
            onChange={setOrderView}
            tabs={[
              { key: 'orderDetails', label: th('detailsTab') },
              { key: 'orderHistory', label: th('tab') },
            ]}
          />
          {orderView === 'orderHistory' ? (
            <OrderHistory orderId={detail.id} currency={detail.currency} />
          ) : (
          <div className="space-y-6">
            {/* Samples at a shop (§4): where they are, since when, the reminder. */}
            {detail.samples && <SamplesPanel order={detail} />}

            {/* Info */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('customer')} value={detail.customer?.isWalkIn ? t('walkInCustomer') : <LatinText>{detail.customer?.displayName ?? '—'}</LatinText>} />
              {detail.branch && <Detail label={tb('column')} value={<LatinText>{detail.branch.name}</LatinText>} />}
              <Detail label={t('channel')} value={detail.channel === 'B2B' ? t('b2b') : t('b2c')} />
              <Detail label={t('total')} value={totalCell(detail)} />
              <Detail label={t('outstanding')} value={outstandingCell(detail)} />
              <Detail label={t('date')} value={formatDate(detail.orderedAt ?? detail.createdAt)} />
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

            {/* Payment History — samples are never paid on (§4). */}
            {!isSamplesStatus(detail.status) && (
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
            )}

            {/* Below cost (§4, 2026-10-11): the confirm step says it again,
                and Confirm still goes through. */}
            {detail.status === 'DRAFT' && <DraftBelowCost order={detail} />}

            {/* Actions */}
          </div>
          )}
        </Dialog>
      )}

      {contractFor && (
        <ContractPlanDialog sale={contractFor} onClose={() => setContractFor(null)} />
      )}

      {adjustingOrder && (
        <AdjustPriceDialog sale={adjustingOrder} onClose={() => setAdjustingOrder(null)} />
      )}

      {completingSamples && (() => {
        // The detail carries every line with its product; the list row is the fallback.
        const source =
          (orderDetail as SaleOrder | undefined)?.id === completingSamples.id
            ? (orderDetail as SaleOrder)
            : completingSamples;
        return (
          <SaleOrderForm
            title={tsm('completeTitle', { orderNo: source.orderNo })}
            customers={customerList}
            products={productList}
            stock={stockList}
            fromSamples={{
              id: source.id,
              orderNo: source.orderNo,
              customerId: source.customerId,
              channel: source.channel,
              currency: source.currency,
              leftOn: source.samples?.leftOn,
              items: source.items ?? [],
            }}
            onCancel={() => setCompletingSamples(null)}
            onSaved={({ order }) => {
              for (const key of ['sales', 'sale', 'inventory', 'customers', 'analytics']) {
                void queryClient.invalidateQueries({ queryKey: [key] });
              }
              setCompletingSamples(null);
              setViewingOrder(null);
              addToast(tsm('boughtToast', { orderNo: order.orderNo ?? source.orderNo }), 'success');
            }}
          />
        );
      })()}

      {returningSamples && (
        <Dialog
          title={tsm('returnTitle', { orderNo: returningSamples.orderNo })}
          onClose={() => setReturningSamples(null)}
          size="sm"
          busy={samplesMutation.isPending}
          footer={
            <>
              <button
                type="button"
                onClick={() => setReturningSamples(null)}
                className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted"
              >
                {tc('cancel')}
              </button>
              <button
                type="button"
                data-testid="samples-return-confirm"
                onClick={() => samplesMutation.mutate({ id: returningSamples.id, action: 'return' })}
                disabled={samplesMutation.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {samplesMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
                {tsm('returnConfirm')}
              </button>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">{tsm('returnBody')}</p>
        </Dialog>
      )}

      {writingOffSamples && (
        <Dialog
          title={tsm('writeOffTitle', { orderNo: writingOffSamples.orderNo })}
          onClose={() => setWritingOffSamples(null)}
          size="sm"
          busy={samplesMutation.isPending}
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get('reason') || '').trim();
            samplesMutation.mutate({ id: writingOffSamples.id, action: 'write-off', reason: reason || undefined });
          }}
          footer={
            <>
              <button
                type="button"
                onClick={() => setWritingOffSamples(null)}
                className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted"
              >
                {tc('cancel')}
              </button>
              <button
                type="submit"
                data-testid="samples-write-off-confirm"
                disabled={samplesMutation.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                {samplesMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageX className="h-4 w-4" />}
                {tsm('writeOffConfirm')}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{tsm('writeOffBody')}</p>
            <div className="flex justify-between rounded-lg bg-muted px-4 py-3 text-sm">
              <span className="text-muted-foreground">{tsm('writeOffCost')}</span>
              <span className="font-medium text-foreground" data-testid="samples-write-off-cost">
                <Money
                  value={((orderDetail as SaleOrder | undefined)?.id === writingOffSamples.id ? (orderDetail as SaleOrder) : writingOffSamples).items
                    ?.flatMap((i) => i.allocations ?? [])
                    .reduce((sum, a) => sum + Number(a.cogsEgp ?? 0), 0) ?? 0}
                />
              </span>
            </div>
            <TextareaField
              label={tsm('writeOffReason')}
              name="reason"
              maxLength={500}
              placeholder={tsm('writeOffReasonPlaceholder')}
            />
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
 * Where samples are (§4, samples at shops): the shop and the day they were
 * left, how long ago, and the day the reminder is due — or, once decided,
 * what happened. A sale that began as samples says so in one line.
 */
function SamplesPanel({ order }: { order: SaleOrder }) {
  const tsm = useTranslations('sales.samples');
  const t = useTranslations('sales');
  const { formatDate } = useDateFormat();
  const s = order.samples!;
  const shop = order.customer?.isWalkIn ? t('walkInCustomer') : order.customer?.displayName ?? '—';
  if (order.status === 'SAMPLES') {
    return (
      <div
        data-testid="samples-panel"
        className="rounded-lg border border-accent-300 bg-accent-50 px-4 py-3 text-sm"
      >
        <p className="flex items-center gap-2 font-medium text-accent-900">
          <PackageOpen className="h-4 w-4 shrink-0" />
          <span className="min-w-0">{tsm('atShopTitle', { shop, date: formatDate(s.leftOn) })}</span>
        </p>
        <p className="mt-1 text-accent-900" data-testid="samples-panel-figures">
          {tsm('badge', { units: Number(s.unitsOut) })} · {tsm('leftAgo', { days: s.daysAtShop })} ·{' '}
          {s.remindedAt ? tsm('reminderSent') : tsm('reminderOn', { date: formatDate(s.reminderOn) })}
        </p>
        <p className="mt-1 text-xs text-accent-900">{tsm('atShopHint')}</p>
      </div>
    );
  }
  const decided = s.decidedAt ? formatDate(s.decidedAt) : '—';
  const text =
    order.status === 'SAMPLES_RETURNED'
      ? tsm('returnedDone', { date: decided })
      : order.status === 'SAMPLES_WRITTEN_OFF'
      ? tsm('writtenOffDone', { date: decided })
      : tsm('boughtFrom', { date: formatDate(s.leftOn) });
  return (
    <p data-testid="samples-panel" className="rounded-lg bg-muted px-4 py-2 text-xs text-muted-foreground">
      {text}
    </p>
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
