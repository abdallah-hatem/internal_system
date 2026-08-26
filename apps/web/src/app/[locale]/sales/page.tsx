'use client';
import { Select } from '../../../components/ui/select';
import { CustomerLink, ProductLink } from '../../../components/ui/entity-link';
import { BatchRef } from '../../../components/ui/batch-ref';
import { Money } from '../../../components/ui/money';

import { useTranslations, useLocale } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { formatDate } from '../../../lib/dates';
import { Suspense, useState, useMemo, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import { useToast } from '../../../components/ui/toast';
import { TextareaField } from '../../../components/ui/textarea-field';
import { selectOnFocus } from '../../../lib/select-on-focus';
import { MoneyInput } from '../../../components/ui/money-input';
import {
  BadgePercent, Plus, Search, Eye, X, MinusCircle, Loader2,
  ChevronRight, DollarSign, CheckCircle, Ban, Package,
  Undo2,
} from 'lucide-react';

import { useApiError } from '../../../lib/api-error';
import { FieldWithQuickCreate } from '../../../components/ui/quick-create';
// ─── Types ────────────────────────────────────────────────────────────
interface SaleOrder {
  id: string;
  orderNo: string;
  customerId: string;
  customer?: { displayName: string };
  channel: string;
  status: string;
  total: number;
  outstanding: number;
  currency: string;
  version: number;
  createdAt: string;
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

interface Customer {
  id: string;
  displayName: string;
  type: string;
}

interface Product {
  id: string;
  name: string;
  sku: string;
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  CONFIRMED: 'bg-blue-100 text-blue-700',
  PARTIALLY_PAID: 'bg-orange-100 text-orange-700',
  PAID: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-red-100 text-red-700',
  RETURNED: 'bg-purple-100 text-purple-700',
};

const STATUS_KEYS: Record<string, string> = {
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
  PARTIALLY_PAID: 'partiallyPaid',
  PAID: 'paid',
  CANCELLED: 'cancelled',
  RETURNED: 'returned',
};

const FILTER_TABS = ['all', 'draft', 'confirmed', 'partiallyPaid', 'paid', 'cancelled'] as const;

// ─── Main Page ────────────────────────────────────────────────────────
function SalesPageContent() {
  const apiError = useApiError();
  const t = useTranslations('sales');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [viewingOrder, setViewingOrder] = useState<SaleOrder | null>(null);
  const [lineItems, setLineItems] = useState<Array<{ productId: string; quantity: number; unitPrice: number; discount: number }>>([]);
  // Controlled so the customer can set the channel and the channel can price
  // the lines. Both still carry their `name`, so the form submits unchanged.
  // Cancelling is not undoable and the button sits beside Confirm, so it asks
  // first rather than acting on the click.
  const [cancellingOrder, setCancellingOrder] = useState<SaleOrder | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [channel, setChannel] = useState('B2B');

  // Arriving from a shop's page with ?customer=<id> opens the order form on
  // that shop, so "New Order" there means what it says instead of dropping you
  // on a list to find them again.
  const searchParams = useSearchParams();
  const router = useRouter();
  const locale = useLocale();
  const openedFromCustomer = useRef(false);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search]);

  // ── Queries ───────────────────────────────────────────────────────
  const { data: orders = [], isLoading } = useQuery({
    queryKey: ['sales'],
    queryFn: () => api.get('/sales/orders').then((r) => r.data.data ?? r.data),
  });

  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get('/customers').then((r) => r.data.data ?? r.data),
  });

  const { data: products = [] } = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get('/products').then((r) => r.data.data ?? r.data),
  });

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
  const createMutation = useMutation({
    mutationFn: (data: any) => api.post('/sales/orders', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sales'] });
      setShowCreateModal(false);
      setLineItems([]);
      setCustomerId('');
      setChannel('B2B');
      addToast('Order created successfully', 'success');
    },
    onError: (error: any) => {
      addToast(apiError(error, 'Operation failed'), 'error');
    },
  });

  const confirmMutation = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      api.post(`/sales/orders/${id}/confirm`, { version }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sales'] });
      queryClient.invalidateQueries({ queryKey: ['sale'] });
      setViewingOrder(null);
      addToast('Order confirmed successfully', 'success');
    },
    onError: (error: any) => {
      addToast(apiError(error, 'Operation failed'), 'error');
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
      queryClient.invalidateQueries({ queryKey: ['sales'] });
      queryClient.invalidateQueries({ queryKey: ['sale'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      setReturningOrder(null);
      setReturnQty({});
      setReturnRestock({});
    },
    onError: (error: any) => {
      addToast(
        apiError(error, 'Failed to record the return'),
        'error',
      );
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.post(`/sales/orders/${id}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sales'] });
      queryClient.invalidateQueries({ queryKey: ['sale'] });
      setViewingOrder(null);
      addToast('Order cancelled successfully', 'success');
    },
    onError: (error: any) => {
      addToast(apiError(error, 'Operation failed'), 'error');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const orderList: SaleOrder[] = Array.isArray(orders) ? orders : [];
  const customerList: Customer[] = Array.isArray(customers) ? customers : [];

  /** Units of a product available to sell right now. */
  const stockFor = (productId: string): number => {
    const row: any = (Array.isArray(stockLevels) ? stockLevels : []).find(
      (r: any) => r.productId === productId,
    );
    return row ? Number(row.availableStock ?? 0) : 0;
  };

  /** The product's current price for a channel, or null if none is set. */
  const priceFor = (productId: string, ch: string): number | null => {
    const product: any = productList.find((p: any) => p.id === productId);
    const active = product?.prices?.find(
      (pr: any) => pr.channel === ch && !pr.effectiveTo,
    );
    return active ? Number(active.amount) : null;
  };

  /**
   * Choosing a customer sets the channel to the kind of customer they are.
   *
   * A shop is B2B and a walk-in is B2C; asking for both was asking the same
   * question twice and letting the answers disagree. It stays changeable —
   * a shop occasionally buys at retail.
   */
  const onCustomerChange = (id: string) => {
    setCustomerId(id);
    const customer = customerList.find((c) => c.id === id);
    if (customer?.type === 'B2B' || customer?.type === 'B2C') {
      applyChannel(customer.type);
    }
  };

  // Wait for the customers to load before opening: the channel is taken from
  // the customer's own type, and acting on an empty list would pick nothing
  // and leave the form on its B2B default regardless of who they are.
  useEffect(() => {
    const wanted = searchParams.get('customer');
    if (!wanted || openedFromCustomer.current || customerList.length === 0) return;
    if (!customerList.some((c) => c.id === wanted)) return;

    openedFromCustomer.current = true;
    setLineItems([{ productId: '', quantity: 1, unitPrice: 0, discount: 0 }]);
    setShowCreateModal(true);
    onCustomerChange(wanted);

    // Drop the parameter once it has been used, so a refresh does not reopen
    // the form and a stale link cannot resurrect it later.
    router.replace(`/${locale}/sales`, { scroll: false });
  }, [searchParams, customerList, locale, router]);

  /**
   * Switch channel and re-price the lines that are still at list price.
   *
   * A price the seller typed is theirs and is left alone; one that is still
   * whatever the old channel quoted is stale under the new one. Same rule as
   * the FX rate: fill what nobody has touched, never overwrite a decision.
   */
  const applyChannel = (next: string) => {
    setLineItems((prev) =>
      prev.map((item) => {
        if (!item.productId) return item;
        const previousList = priceFor(item.productId, channel);
        const untouched = !item.unitPrice || item.unitPrice === previousList;
        if (!untouched) return item;
        return { ...item, unitPrice: priceFor(item.productId, next) ?? item.unitPrice };
      }),
    );
    setChannel(next);
  };
  const productList: Product[] = Array.isArray(products) ? products : [];

  const filtered = orderList.filter((o) => {
    const matchSearch =
      !search ||
      o.orderNo?.toLowerCase().includes(search.toLowerCase()) ||
      o.customer?.displayName?.toLowerCase().includes(search.toLowerCase());
    const matchStatus =
      statusFilter === 'all' || o.status === statusFilter.toUpperCase().replace(/([A-Z])/g, '_$1').toUpperCase();
    // Simple match for status filter
    const statusMap: Record<string, string> = {
      draft: 'DRAFT',
      confirmed: 'CONFIRMED',
      partiallyPaid: 'PARTIALLY_PAID',
      paid: 'PAID',
      cancelled: 'CANCELLED',
    };
    const matchStatusFinal = statusFilter === 'all' || o.status === statusMap[statusFilter];
    return matchSearch && matchStatusFinal;
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  // ── Handlers ──────────────────────────────────────────────────────
  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createMutation.mutate({
      customerId: fd.get('customerId'),
      channel: fd.get('channel'),
      currency: fd.get('currency'),
      items: lineItems,
    });
  };

  const addLineItem = () => {
    setLineItems((prev) => [...prev, { productId: '', quantity: 1, unitPrice: 0, discount: 0 }]);
  };

  const updateLineItem = (idx: number, field: string, value: any) => {
    setLineItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item))
    );
  };

  const removeLineItem = (idx: number) => {
    setLineItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const detail = (orderDetail as SaleOrder) ?? viewingOrder;

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <button
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
        </button>
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
        <div className="flex flex-wrap gap-2">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === tab
                  ? 'bg-primary-600 text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {tab === 'all' ? tc('filter') : t(tab)}
            </button>
          ))}
        </div>
      </div>

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
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('orderNo')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('customer')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('channel')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('status')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('total')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('outstanding')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('date')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400">{tc('noData')}</td></tr>
                ) : (
                  paginated.map((order) => (
                    <tr key={order.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs font-medium text-primary-600">{order.orderNo}</td>
                      <td className="px-4 py-3 text-gray-900">
                        <CustomerLink id={order.customerId} name={order.customer?.displayName} />
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          order.channel === 'B2B' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'
                        }`}>
                          {order.channel === 'B2B' ? t('b2b') : t('b2c')}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[order.status] ?? 'bg-gray-100 text-gray-600'}`}>
                          {t(STATUS_KEYS[order.status] ?? order.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-900 font-medium"><Money value={order.total} currency={order.currency} /></td>
                      <td className="px-4 py-3">
                        <span className={`font-medium ${order.outstanding > 0 ? 'text-red-600' : 'text-green-600'}`}>
                          <Money value={order.outstanding} currency={order.currency} />
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(order.createdAt)}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setViewingOrder(order)}
                          className="inline-flex items-center gap-1 text-primary-600 hover:text-primary-700 text-sm font-medium"
                        >
                          {tc('view')} <ChevronRight className="h-4 w-4" />
                        </button>
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
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">{tc('noData')}</div>
          ) : (
            paginated.map((order) => (
              <div
                key={order.id}
                onClick={() => setViewingOrder(order)}
                className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-sm font-bold text-primary-600">{order.orderNo}</span>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[order.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {t(STATUS_KEYS[order.status] ?? order.status)}
                  </span>
                </div>
                <p className="text-sm text-gray-700">
                  <CustomerLink id={order.customerId} name={order.customer?.displayName} />
                </p>
                <div className="flex items-center gap-3 mt-2 text-sm">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    order.channel === 'B2B' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'
                  }`}>
                    {order.channel === 'B2B' ? t('b2b') : t('b2c')}
                  </span>
                  <span className="font-medium text-gray-900"><Money value={order.total} currency={order.currency} /></span>
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
                  <span>{formatDate(order.createdAt)}</span>
                  <span className={`font-medium ${order.outstanding > 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {t('outstanding')}: <Money value={order.outstanding} currency={order.currency} />
                  </span>
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
      {showCreateModal && (
        <Modal title={t('create')} onClose={() => { setShowCreateModal(false); setLineItems([]); setCustomerId(''); setChannel('B2B'); }}>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('customer')}</label>
                <FieldWithQuickCreate
                  entity="customer"
                  onCreated={(c) => onCustomerChange(c.id)}
                >
                  <Select
                    name="customerId"
                    required
                    value={customerId}
                    onChange={onCustomerChange}
                    placeholder={t('customer')}
                    searchPlaceholder={tc('search')}
                    options={customerList.map((c) => ({
                      value: c.id,
                      label: c.displayName,
                      hint: c.type,
                    }))}
                  />
                </FieldWithQuickCreate>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('channel')}</label>
                <Select
                  name="channel"
                  required
                  value={channel}
                  onChange={applyChannel}
                  options={[
                    { value: 'B2B', label: t('b2b') },
                    { value: 'B2C', label: t('b2c') },
                  ]}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('currency')}</label>
                <Select
                  name="currency"
                  defaultValue="EGP"
                  options={['EGP', 'USD', 'AED'].map((c) => ({ value: c, label: c }))}
                />
              </div>
            </div>

            {/* Line Items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-900">{t('items')}</h3>
                <button type="button" onClick={addLineItem} className="inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium">
                  <Plus className="h-3.5 w-3.5" /> {t('addItem')}
                </button>
              </div>

              {lineItems.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4 border border-dashed border-gray-200 rounded-lg">
                  No items added. Click &quot;{t('addItem')}&quot; to begin.
                </p>
              ) : (
                <div className="space-y-3">
                  {lineItems.map((item, idx) => (
                    <div key={idx} className="flex items-end gap-2 bg-gray-50 rounded-lg p-3">
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500 mb-1">{t('product')}</label>
                        <Select
                          value={item.productId}
                          onChange={(v) => {
                            // Price the line from the chosen channel. Left
                            // editable — a negotiated price is still a price.
                            const listPrice = priceFor(v, channel);
                            setLineItems((prev) =>
                              prev.map((it, i) =>
                                i === idx
                                  ? { ...it, productId: v, unitPrice: listPrice ?? it.unitPrice }
                                  : it,
                              ),
                            );
                          }}
                          placeholder={t('product')}
                          searchPlaceholder={tc('search')}
                          options={productList.map((p) => {
                            const inStock = stockFor(p.id);
                            return {
                              value: p.id,
                              label: p.name,
                              // The count belongs where the product is chosen,
                              // not in an error after the order is built.
                              hint: `${p.sku} · ${inStock.toLocaleString()} ${t('inStock')}`,
                              disabled: inStock <= 0,
                            };
                          })}
                        />
                      </div>
                      <div className="w-20">
                        <label className="block text-xs text-gray-500 mb-1">{t('quantity')}</label>
                        <input
                          type="number"
                          placeholder="0"
                          value={item.quantity}
                          onChange={(e) => updateLineItem(idx, 'quantity', Number(e.target.value))}
                          {...selectOnFocus}
                          className={`w-full rounded-lg border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 ${
                            item.productId && item.quantity > stockFor(item.productId)
                              ? 'border-red-300 focus:ring-red-400'
                              : 'border-gray-200 focus:ring-primary-500'
                          }`}
                        />
                        {item.productId && item.quantity > stockFor(item.productId) && (
                          <p className="mt-1 text-[10px] text-red-600">
                            {stockFor(item.productId).toLocaleString()} {t('inStock')}
                          </p>
                        )}
                      </div>
                      <div className="w-24">
                        <label className="block text-xs text-gray-500 mb-1">{t('unitPrice')}</label>
                        <MoneyInput
                          placeholder="0.00"
                          value={item.unitPrice}
                          onChange={(raw) => updateLineItem(idx, 'unitPrice', Number(raw))}
                          className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-end text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                        {item.productId &&
                          (() => {
                            const list = priceFor(item.productId, channel);
                            if (list == null) {
                              return (
                                <p className="mt-1 text-[10px] text-amber-600">
                                  No {channel} price set
                                </p>
                              );
                            }
                            // Only worth saying when it differs; repeating the
                            // number under itself is noise.
                            if (Number(item.unitPrice) === list) return null;
                            return (
                              <p className="mt-1 text-[10px] text-gray-400">
                                {channel} {list.toLocaleString()}
                              </p>
                            );
                          })()}
                      </div>
                      <div className="w-20">
                        <label className="block text-xs text-gray-500 mb-1">{t('discount')}</label>
                        <MoneyInput
                          placeholder="0.00"
                          value={item.discount}
                          onChange={(raw) => updateLineItem(idx, 'discount', Number(raw))}
                          className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-end text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                      <button type="button" onClick={() => removeLineItem(idx)} className="p-1.5 text-red-400 hover:text-red-600">
                        <MinusCircle className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
              <button type="button" onClick={() => { setShowCreateModal(false); setLineItems([]); }} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" disabled={createMutation.isPending} className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('create')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── View Order Detail ──────────────────────────────────────── */}
      {viewingOrder && detail && (
        <Modal title={detail.orderNo} onClose={() => setViewingOrder(null)}>
          <div className="space-y-6">
            {/* Info */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('customer')} value={detail.customer?.displayName ?? '—'} />
              <Detail label={t('channel')} value={detail.channel === 'B2B' ? t('b2b') : t('b2c')} />
              <Detail label={t('total')} value={<Money value={detail.total} currency={detail.currency} />} />
              <Detail label={t('outstanding')} value={<Money value={detail.outstanding} currency={detail.currency} />} />
              <Detail label={t('date')} value={formatDate(detail.createdAt)} />
              <Detail label={tc('status')} value={t(STATUS_KEYS[detail.status] ?? detail.status)} />
            </div>

            {/* Items */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">{t('items')}</h3>
              {(detail.items ?? []).length === 0 ? (
                <p className="text-sm text-gray-400">{tc('noData')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('product')}</th>
                        <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('quantity')}</th>
                        <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('unitPrice')}</th>
                        <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('discount')}</th>
                        <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('lineTotal')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {(detail.items ?? []).map((item: SaleOrderItem) => (
                        <tr key={item.id}>
                          <td className="py-2">
                            <p className="font-medium text-gray-900">
                              <ProductLink id={item.productId} name={item.product?.name} />
                            </p>
                            <p className="text-xs text-gray-500">{item.product?.sku}</p>
                          </td>
                          <td className="py-2 text-gray-600">{item.quantity}</td>
                          <td className="py-2 text-gray-600">{item.unitPrice?.toLocaleString()}</td>
                          <td className="py-2 text-gray-600">{item.discount > 0 ? `- ${item.discount.toLocaleString()}` : '—'}</td>
                          <td className="py-2 font-medium text-gray-900">
                            {((item.quantity * item.unitPrice) - item.discount).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Allocations */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">{t('allocations')}</h3>
              {(detail.items ?? []).flatMap((item: SaleOrderItem) => item.allocations ?? []).length === 0 ? (
                <p className="text-sm text-gray-400">{tc('noData')}</p>
              ) : (
                <div className="space-y-2">
                  {(detail.items ?? []).flatMap((item: SaleOrderItem) =>
                    (item.allocations ?? []).map((alloc) => (
                      <div key={alloc.id} className="flex items-center justify-between bg-blue-50 rounded-lg px-4 py-3 text-sm gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <Package className="h-4 w-4 text-blue-500 shrink-0" />
                          <div className="min-w-0">
                            <p className="font-medium text-gray-900 truncate">
                              <ProductLink id={item.productId} name={item.product?.name} />
                            </p>
                            <p className="text-xs text-gray-500">
                              {t('batch')} <BatchRef id={alloc.inventoryBatchId} />
                              {alloc.unitCostEgp != null && (
                                <>
                                  {' · '}
                                  <Money value={alloc.unitCostEgp} />
                                  {' '}
                                  {t('perUnitCost')}
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
                <p className="text-sm text-gray-400">{tc('noData')}</p>
              ) : (
                <div className="space-y-2">
                  {(detail.paymentAllocations ?? []).map((alloc: any) => {
                    const payment = alloc?.payment ?? alloc;
                    if (!payment) return null;
                    return (
                      <div key={alloc.id ?? payment.id} className="flex items-center justify-between bg-green-50 rounded-lg px-4 py-3 text-sm">
                        <div>
                          <p className="font-medium text-gray-900"><Money value={alloc.amount ?? payment.amount} currency={detail.currency} /></p>
                          <p className="text-xs text-gray-500">{payment.method} · {payment.reference ?? '—'}</p>
                        </div>
                        <span className="text-xs text-gray-500">{formatDate(payment.receivedOn)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
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
          </div>
        </Modal>
      )}

      {/* ─── Return Modal ──────────────────────────────────────────── */}
      {cancellingOrder && (
        <Modal
          title={`${t('cancel')} — ${cancellingOrder.orderNo}`}
          onClose={() => setCancellingOrder(null)}
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {t('cancelWarning')}
            </p>
            <div className="rounded-lg bg-gray-50 px-4 py-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">{t('customer')}</span>
                <span className="font-medium text-gray-900">
                  {cancellingOrder.customer?.displayName ?? '—'}
                </span>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-gray-500">{t('total')}</span>
                <span className="font-medium text-gray-900">
                  <Money value={Number(cancellingOrder.total)} currency={cancellingOrder.currency} />
                </span>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
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
            </div>
          </div>
        </Modal>
      )}

      {returningOrder && (
        <Modal
          title={`${t('recordReturn')} — ${returningOrder.orderNo}`}
          onClose={() => setReturningOrder(null)}
        >
          <form
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
                        <ProductLink id={it.productId} name={it.product?.name} />
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
                      placeholder="0"
                      value={returnQty[it.id] ?? ''}
                      onChange={(e) => setReturnQty((q) => ({ ...q, [it.id]: e.target.value }))}
                      className="w-24 shrink-0 rounded-lg border border-gray-200 px-3 py-2 text-sm text-end focus:outline-none focus:ring-2 focus:ring-primary-500"
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
              <Select
                name="refundMethod"
                defaultValue="CREDIT_NOTE"
                options={[
                  { value: 'CREDIT_NOTE', label: t('creditNote') },
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

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setReturningOrder(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                {tc('cancel')}
              </button>
              <button
                type="submit"
                disabled={returnMutation.isPending}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                {returnMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('recordReturn')}
              </button>
            </div>
          </form>
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
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl flex flex-col max-h-[90vh]">
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
