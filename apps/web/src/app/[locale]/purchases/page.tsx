'use client';
import { NoMatch } from '@/components/ui/no-match';
import { LatinText } from '@/components/ui/latin-text';
import { Select } from '../../../components/ui/select';
import { ProductLink } from '../../../components/ui/entity-link';
import { Money } from '../../../components/ui/money';

import { useLocale, useTranslations } from 'next-intl';
import { localName, otherName } from '@/lib/localized-name';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import {
  ShoppingCart, Plus, Search, Eye, X, MinusCircle, ChevronRight,
  Package, DollarSign,
} from 'lucide-react';
import { useDateFormat } from '../../../lib/dates';
import { useToast } from '../../../components/ui/toast';
import { TextareaField } from '../../../components/ui/textarea-field';
import { CurrencyRateFields } from '../../../components/ui/currency-rate-fields';
import { selectOnFocus } from '../../../lib/select-on-focus';
import { MoneyInput } from '../../../components/ui/money-input';

import { useApiError } from '../../../lib/api-error';
import { FieldWithQuickCreate } from '../../../components/ui/quick-create';
import { InputField, RowAction } from '../../../components/ui/fields';
import { useCodeLabel } from '@/lib/labels';
import { ValidatedForm } from '@/components/ui/validated-form';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, CellBadge, type Column } from '@/components/ui/data-table';
import { useCan } from '@/lib/can';
import { useAllRecords } from '@/lib/list-all';
import { offeredOnly } from '@/lib/product-status';
import { ListCapNotice } from '@/components/ui/list-cap-notice';
import { PaidByFriend } from '@/components/lenders/paid-by-friend';
import { Dialog } from '@/components/ui/dialog';
// ─── Types ────────────────────────────────────────────────────────────
interface PurchaseOrder {
  id: string;
  reference: string;
  cycleId: string;
  cycle?: { code: string; status?: string };
  supplierId: string;
  supplier?: { name: string };
  currency: string;
  fxRateToEgp: number;
  orderedOn: string;
  status: string;
  items?: POItem[];
}

interface POItem {
  id: string;
  productId: string;
  product?: { name: string; sku: string };
  orderedQty: number;
  receivedQty: number;
  unitPrice: number;
  discount: number;
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-600',
  SUBMITTED: 'bg-blue-100 text-blue-700',
  CONFIRMED: 'bg-indigo-100 text-indigo-700',
  SHIPPED: 'bg-yellow-100 text-yellow-700',
  PARTIAL: 'bg-orange-100 text-orange-700',
  RECEIVED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-red-100 text-red-700',
};

// ─── Skeletons ────────────────────────────────────────────────────────
// The table's skeleton rows are drawn by DataTable from each column's
// `skeleton`; the phone card below is traced by hand. Change one, change the other.

function PurchaseCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <SkeletonText className="w-28" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <SkeletonText className="w-36" />
      <div className="flex items-center gap-3 mt-1">
        <SkeletonText size="xs" className="w-20" />
        <SkeletonText size="xs" className="w-8" />
        <SkeletonText size="xs" className="w-20" />
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function PurchasesPage() {
  const locale = useLocale();
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const apiError = useApiError();
  const t = useTranslations('purchases');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // An investor reads their cycles' orders; placing one and recording a
  // supplier refund are a partner's (R1c).
  const may = { create: useCan('purchase.create'), recordRefund: useCan('purchase.recordRefund') };

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newSupplierId, setNewSupplierId] = useState('');
  const [viewingPO, setViewingPO] = useState<PurchaseOrder | null>(null);
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [lineItems, setLineItems] = useState<Array<{ productId: string; orderedQty: number; unitPrice: number; discount: number }>>([]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search]);

  // ── Queries ───────────────────────────────────────────────────────
  const { items: purchases, capped, isLoading } = useAllRecords(['purchases'], '/purchases');
  const { items: cycles } = useAllRecords(['cycles'], '/cycles');
  const { items: suppliers } = useAllRecords(['suppliers'], '/suppliers');
  const { items: products } = useAllRecords(['products'], '/products');

  const { data: poDetail } = useQuery({
    queryKey: ['purchase', viewingPO?.id],
    queryFn: () =>
      api.get(`/purchases/${viewingPO!.id}`).then((r) => r.data.data ?? r.data),
    enabled: !!viewingPO,
  });

  // ── Mutations ─────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: any) => {
      const { cycleId, ...body } = data;
      return api.post(`/cycles/${cycleId}/purchases`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['purchases'] });
      setShowCreateModal(false);
      setLineItems([]);
      toast(t('createSuccess'), 'success');
    },
    onError: (error: any) => {
      toast(apiError(error, t('createFailed')), 'error');
    },
  });

  const refundMutation = useMutation({
    mutationFn: (data: any) => api.post(`/purchases/${viewingPO!.id}/refunds`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['purchase'] });
      setShowRefundModal(false);
      toast(t('refundRecorded'), 'success');
    },
    onError: (error: any) => {
      toast(apiError(error, t('refundFailed')), 'error');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const purchaseList: PurchaseOrder[] = Array.isArray(purchases) ? purchases : [];
  const cycleList: any[] = Array.isArray(cycles)
    ? cycles.filter((c: any) => ['PLANNING', 'FUNDING', 'PURCHASING'].includes(c.status))
    : [];
  const supplierList: any[] = Array.isArray(suppliers) ? suppliers : [];
  // A switched-off product takes no new purchase-order line (§3, 2026-10-14).
  const productList: any[] = Array.isArray(products) ? offeredOnly(products) : [];

  const filtered = purchaseList.filter((p) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      p.reference?.toLowerCase().includes(q) ||
      p.supplier?.name?.toLowerCase().includes(q) ||
      p.cycle?.code?.toLowerCase().includes(q)
    );
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  // Nothing at all says what goes here and offers the first one; nothing for
  // this search or filter says only that (UX #12).
  const emptyList =
    purchaseList.length === 0 ? (
      <EmptyState
        title={t('emptyTitle')}
        description={t('emptyHint')}
        action={may.create ? { label: t('create'), onClick: () => setShowCreateModal(true) } : undefined}
      />
    ) : (
      <NoMatch onClear={() => setSearch('')} />
    );

  // ── Handlers ──────────────────────────────────────────────────────
  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createMutation.mutate({
      cycleId: fd.get('cycleId'),
      supplierId: fd.get('supplierId'),
      currency: fd.get('currency'),
      fxRateToEgp: Number(fd.get('fxRate') || 1),
      orderedOn: fd.get('orderedDate'),
      items: lineItems,
    });
  };

  const addLineItem = () => {
    setLineItems((prev) => [...prev, { productId: '', orderedQty: 0, unitPrice: 0, discount: 0 }]);
  };

  const updateLineItem = (idx: number, field: string, value: any) => {
    setLineItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item))
    );
  };

  const removeLineItem = (idx: number) => {
    setLineItems((prev) => prev.filter((_, i) => i !== idx));
  };

  // ── Columns ───────────────────────────────────────────────────────
  // Reference, supplier, cycle, currency, rate, date, status, actions
  // (components/ui/data-table.tsx). Each fixed column fits its title in
  // English and Arabic ("سعر الصرف إلى الجنيه" sets the rate's); the
  // supplier takes what is left.
  const columns: Column<PurchaseOrder>[] = [
    {
      key: 'reference', header: t('reference'), width: '8.5rem', kind: 'label',
      className: 'font-mono text-xs font-medium text-primary-600', title: (po) => po.reference,
      skeleton: { kind: 'text', size: 'xs', share: 'w-3/4' }, cell: (po) => po.reference,
    },
    {
      key: 'supplier', header: t('supplier'), width: 'auto', kind: 'name', className: 'text-gray-900',
      title: (po) => po.supplier?.name, cell: (po) => <LatinText>{po.supplier?.name ?? '—'}</LatinText>,
    },
    {
      key: 'cycle', header: t('cycle'), width: '8.5rem', kind: 'label', className: 'text-gray-600 font-mono text-xs',
      title: (po) => po.cycle?.code, skeleton: { kind: 'text', size: 'xs', share: 'w-3/4' }, cell: (po) => po.cycle?.code ?? '—',
    },
    {
      key: 'currency', header: t('currency'), width: '6rem', kind: 'value', className: 'text-gray-600',
      skeleton: { kind: 'text', share: 'w-1/3' }, cell: (po) => po.currency,
    },
    {
      key: 'fxRate', header: t('fxRate'), width: '9rem', kind: 'value', className: 'text-gray-600',
      skeleton: { kind: 'text', share: 'w-1/4' }, cell: (po) => po.fxRateToEgp,
    },
    {
      key: 'orderedOn', header: t('orderedDate'), width: '8rem', kind: 'value', className: 'text-gray-500 text-xs',
      skeleton: { kind: 'text', size: 'xs', share: 'w-3/4' }, cell: (po) => formatDate(po.orderedOn),
    },
    {
      key: 'status', header: tc('status'), width: '8.5rem', skeleton: { kind: 'pill', share: 'w-2/3' },
      cell: (po) => (
        <CellBadge className={STATUS_COLORS[po.status] ?? 'bg-gray-100 text-gray-600'}>{codeLabel('poStatus', po.status)}</CellBadge>
      ),
    },
    {
      key: 'actions', header: tc('actions'), width: '6rem', skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (po) => (
        <button
          onClick={() => setViewingPO(po)}
          className="inline-flex items-center gap-1 whitespace-nowrap text-primary-600 hover:text-primary-700 text-sm font-medium"
        >
          {tc('view')} <ChevronRight className="h-4 w-4 rtl:rotate-180" />
        </button>
      ),
    },
  ];

  // An order's lines, in its window: product, ordered, received, unit price,
  // discount, line total. The amounts fit "123,456.00 EGP" and never cut; the
  // product takes what is left.
  const itemColumns: Column<POItem>[] = [
    {
      key: 'product', header: t('product'), width: 'auto', title: (item) => localName(item.product, locale),
      cell: (item) => (
        <>
          <p className="font-medium text-gray-900 line-clamp-2 break-words" title={localName(item.product, locale)}>
            <ProductLink id={item.productId} name={localName(item.product, locale)} />
          </p>
          <p className="text-xs text-gray-500 truncate" title={item.product?.sku}>{item.product?.sku}</p>
        </>
      ),
    },
    { key: 'orderedQty', header: t('orderedQty'), width: '6rem', kind: 'value', className: 'text-gray-600', cell: (item) => item.orderedQty },
    { key: 'receivedQty', header: t('receivedQty'), width: '6rem', kind: 'value', className: 'text-gray-600', cell: (item) => item.receivedQty },
    {
      key: 'unitPrice', header: t('unitPrice'), width: '8rem', kind: 'value', className: 'text-gray-600',
      cell: (item) => <Money value={item.unitPrice} currency={viewingPO?.currency} />,
    },
    {
      key: 'discount', header: t('discount'), width: '8rem', kind: 'value', className: 'text-gray-600',
      cell: (item) => (item.discount > 0 ? <Money value={-item.discount} currency={viewingPO?.currency} /> : '—'),
    },
    {
      key: 'lineTotal', header: t('lineTotal'), width: '8.5rem', kind: 'value', className: 'font-medium text-gray-900',
      cell: (item) => <Money value={item.orderedQty * item.unitPrice - item.discount} currency={viewingPO?.currency} />,
    },
  ];

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        {may.create && (
        <button
          type="button"
          data-testid="create-action"
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
        </button>
        )}
      </div>

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

      <ListCapNotice capped={capped} count={purchases.length} />

      {/* Loading: the table's own header over skeleton rows, skeleton cards on a phone. */}
      {isLoading && <LoadingStatus />}

      {/* Desktop Table — the shared one (components/ui/data-table.tsx). */}
      <DataTable
        className="hidden md:block"
        columns={columns}
        rows={paginated}
        rowKey={(po) => po.id}
        isLoading={isLoading}
        empty={emptyList}
      />

      {/* Mobile Cards */}
      {isLoading && (
        <SkeletonGroup className="md:hidden space-y-3">
          {repeat(PAGE_SIZE, (i) => <PurchaseCardSkeleton key={i} />)}
        </SkeletonGroup>
      )}
      {!isLoading && (
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200">{emptyList}</div>
          ) : (
            paginated.map((po) => (
              <div
                key={po.id}
                onClick={() => setViewingPO(po)}
                className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-sm font-bold text-primary-600">{po.reference}</span>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[po.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {codeLabel('poStatus', po.status)}
                  </span>
                </div>
                <p className="text-sm text-gray-700"><LatinText>{po.supplier?.name ?? '—'}</LatinText></p>
                <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
                  <span>{po.cycle?.code ?? '—'}</span>
                  <span>{po.currency}</span>
                   <span>{formatDate(po.orderedOn)}</span>
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
        <Dialog
          title={t('create')}
          onClose={() => { setShowCreateModal(false); setLineItems([]); }}
          size="lg"
          footer={
            <>
              <button type="button" onClick={() => { setShowCreateModal(false); setLineItems([]); }} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" form="purchase-create-form" disabled={createMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {createMutation.isPending ? tc('loading') : tc('create')}
              </button>
            </>
          }
        >
          <ValidatedForm id="purchase-create-form" onSubmit={handleCreate} className="space-y-4">
            <div className="field-row grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('cycle')}</label>
                <Select
                  name="cycleId"
                  required
                  placeholder={tph('chooseCycle')}
                  searchPlaceholder={tph('searchCycles')}
                  options={cycleList.map((c: any) => ({
                    value: c.id,
                    label: c.code,
                    hint: [c.originType && codeLabel('originType', c.originType), c.status && codeLabel('cycleStatus', c.status)].filter(Boolean).join(' · '),
                  }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('supplier')}</label>
                <FieldWithQuickCreate
                  entity="supplier"
                  onCreated={(sup) => setNewSupplierId(sup.id)}
                >
                <Select
                  name="supplierId"
                  required
                  value={newSupplierId}
                  onChange={setNewSupplierId}
                  placeholder={tph('chooseSupplier')}
                  searchPlaceholder={tph('searchSuppliers')}
                  options={supplierList.map((sup: any) => ({
                    value: sup.id,
                    label: sup.name,
                    hint: sup.contactPerson ?? undefined,
                  }))}
                />
                </FieldWithQuickCreate>
              </div>
            </div>

            <CurrencyRateFields
              rateName="fxRate"
              currencies={['CNY', 'AED', 'USD', 'EGP']}
              defaultCurrency="CNY"
              currencyLabel={t('currency')}
              rateLabel={t('fxRate')}
            />

            <InputField label={t('orderedDate')} name="orderedDate" type="date" required />

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
                  {t('noItemsYet')}
                </p>
              ) : (
                <div className="space-y-3">
                  {lineItems.map((item, idx) => (
                    <div key={idx} className="field-row flex flex-wrap gap-2 bg-gray-50 rounded-lg p-3 sm:flex-nowrap">
                      <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                        <label className="block text-xs text-gray-500 mb-1">{t('product')}</label>
                        <FieldWithQuickCreate
                          entity="product"
                          onCreated={(prod) => updateLineItem(idx, 'productId', prod.id)}
                        >
                          <Select
                            value={item.productId}
                            onChange={(v) => updateLineItem(idx, 'productId', v)}
                            placeholder={tph('chooseProduct')}
                            searchPlaceholder={tph('searchProducts')}
                            options={productList.map((p: any) => ({
                              value: p.id,
                              label: localName(p, locale),
                              hint: p.sku,
                              keywords: otherName(p, locale),
                            }))}
                          />
                        </FieldWithQuickCreate>
                      </div>
                      <div className="min-w-0 flex-1 sm:w-20 sm:flex-none">
                        <label className="block text-xs text-gray-500 mb-1">{t('orderedQty')}</label>
                        <input
                          type="number"
                          placeholder={tph('quantity')}
                          value={item.orderedQty || ''}
                          onChange={(e) => updateLineItem(idx, 'orderedQty', Number(e.target.value))}
                          {...selectOnFocus}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                      <div className="min-w-0 flex-1 sm:w-24 sm:flex-none">
                        <label className="block text-xs text-gray-500 mb-1">{t('unitPrice')}</label>
                        <MoneyInput
                          placeholder={tph('money')}
                          value={item.unitPrice || ''}
                          onChange={(raw) => updateLineItem(idx, 'unitPrice', Number(raw))}
                          className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                      <div className="min-w-0 flex-1 sm:w-20 sm:flex-none">
                        <label className="block text-xs text-gray-500 mb-1">{t('discount')}</label>
                        <MoneyInput
                          placeholder={tph('discount')}
                          value={item.discount || ''}
                          onChange={(raw) => updateLineItem(idx, 'discount', Number(raw))}
                          className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                      <RowAction labelClassName="block text-xs text-gray-500 mb-1">
                        <button type="button" onClick={() => removeLineItem(idx)} className="p-1.5 text-red-400 hover:text-red-600">
                          <MinusCircle className="h-4 w-4" />
                        </button>
                      </RowAction>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── View PO Detail ────────────────────────────────────────── */}
      {viewingPO && (
        <Dialog title={viewingPO.reference} onClose={() => setViewingPO(null)} size="xl">
          <div className="space-y-6">
            {/* Info */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('supplier')} value={viewingPO.supplier?.name ?? '—'} />
              <Detail label={t('cycle')} value={viewingPO.cycle?.code ?? '—'} />
              <Detail label={t('currency')} value={viewingPO.currency} />
               <Detail label={t('fxRate')} value={String(viewingPO.fxRateToEgp)} />
              <Detail label={t('orderedDate')} value={formatDate(viewingPO.orderedOn)} />
              <Detail label={tc('status')} value={codeLabel('poStatus', viewingPO.status)} />
            </div>

            {/* A friend who paid the supplier for us (§18). */}
            <PaidByFriend
              purchaseOrder={{ id: viewingPO.id, reference: viewingPO.reference, currency: viewingPO.currency }}
              closed={['SETTLEMENT', 'CLOSED', 'CANCELLED'].includes(viewingPO.cycle?.status ?? '')}
            />

            {/* Items table */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">{t('items')}</h3>
              {(poDetail?.items ?? viewingPO.items ?? []).length === 0 ? (
                <EmptyState size="compact" title={t('noItemsTitle')} description={t('noItemsHint')} />
              ) : (
                <DataTable
                  frame="none"
                  density="compact"
                  autoMin="10rem"
                  columns={itemColumns}
                  rows={poDetail?.items ?? viewingPO.items ?? []}
                  rowKey={(item) => item.id}
                />
              )}
            </div>

            {/* Refunds */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900">{t('refunds')}</h3>
                {may.recordRefund && (
                <button
                  type="button"
                  data-testid="record-refund-action"
                  onClick={() => setShowRefundModal(true)}
                  className="inline-flex items-center gap-1 text-xs bg-amber-50 text-amber-700 px-3 py-1.5 rounded-lg hover:bg-amber-100 cursor-pointer"
                >
                  <DollarSign className="h-3.5 w-3.5" />
                  {t('recordRefund')}
                </button>
                )}
              </div>
              {(poDetail?.refunds ?? []).length === 0 ? (
                <EmptyState size="compact" title={t('noRefundsTitle')} description={t('noRefundsHint')} />
              ) : (
                <div className="space-y-2">
                  {(poDetail?.refunds ?? []).map((refund: any) => (
                    <div key={refund.id} className="flex items-center justify-between bg-red-50 rounded-lg px-4 py-3 text-sm">
                      <div>
                        <p className="font-medium text-gray-900"><Money value={refund.amount} /></p>
                        <p className="text-xs text-gray-500">{refund.reason ?? '—'}</p>
                      </div>
                       <span className="text-xs text-gray-500">{refund.recordedOn ?? '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Dialog>
      )}

      {/* ─── Refund Modal ──────────────────────────────────────────── */}
      {showRefundModal && viewingPO && (
        <Dialog
          title={t('recordRefund')}
          onClose={() => setShowRefundModal(false)}
          footer={
            <>
              <button type="button" onClick={() => setShowRefundModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit"
                form="purchases-3-form" className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700">{tc('save')}</button>
            </>
          }
        >
          <ValidatedForm id="purchases-3-form"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              refundMutation.mutate({
                amount: Number(fd.get('amount')),
                currency: viewingPO.currency,
                fxRateToEgp: viewingPO.fxRateToEgp,
                reason: fd.get('reason'),
                recordedOn: fd.get('recordedOn'),
              });
            }}
            className="space-y-4"
          >
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                {t('amount')}<span className="ms-1 text-red-500">*</span>
              </label>
              <MoneyInput name="amount" required placeholder={tph('money')} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
            </div>
            <TextareaField label={t('reason')} name="reason" placeholder={tph('purchaseRefundReason')} />
            <InputField label={tc('date')} name="recordedOn" type="date" required />
          </ValidatedForm>
        </Dialog>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────
/** `wide`: the order's window, whose six-column item table needs the room — its amounts never truncate. */


function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-500 text-xs">{label}</span>
      <p className="font-medium text-gray-900"><LatinText>{value}</LatinText></p>
    </div>
  );
}
