'use client';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import {
  ShoppingCart, Plus, Search, Eye, X, MinusCircle, Loader2, ChevronRight,
  Package, DollarSign,
} from 'lucide-react';
import { formatDate } from '../../../lib/dates';
import { useToast } from '../../../components/ui/toast';

// ─── Types ────────────────────────────────────────────────────────────
interface PurchaseOrder {
  id: string;
  reference: string;
  cycleId: string;
  cycle?: { code: string };
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

// ─── Main Page ────────────────────────────────────────────────────────
export default function PurchasesPage() {
  const t = useTranslations('purchases');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [viewingPO, setViewingPO] = useState<PurchaseOrder | null>(null);
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [lineItems, setLineItems] = useState<Array<{ productId: string; orderedQty: number; unitPrice: number; discount: number }>>([]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search]);

  // ── Queries ───────────────────────────────────────────────────────
  const { data: purchases = [], isLoading } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api.get('/purchases').then((r) => r.data.data ?? r.data),
  });

  const { data: cycles = [] } = useQuery({
    queryKey: ['cycles'],
    queryFn: () => api.get('/cycles').then((r) => r.data.data ?? r.data),
  });

  const { data: suppliers = [] } = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api.get('/suppliers').then((r) => r.data.data ?? r.data),
  });

  const { data: products = [] } = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get('/products').then((r) => r.data.data ?? r.data),
  });

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
      toast('Purchase order created successfully', 'success');
    },
    onError: (error: any) => {
      toast(error?.response?.data?.message || error?.message || 'Failed to create purchase order', 'error');
    },
  });

  const refundMutation = useMutation({
    mutationFn: (data: any) => api.post(`/purchases/${viewingPO!.id}/refunds`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['purchase'] });
      setShowRefundModal(false);
      toast('Refund recorded successfully', 'success');
    },
    onError: (error: any) => {
      toast(error?.response?.data?.message || error?.message || 'Failed to record refund', 'error');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const purchaseList: PurchaseOrder[] = Array.isArray(purchases) ? purchases : [];
  const cycleList: any[] = Array.isArray(cycles)
    ? cycles.filter((c: any) => ['PLANNING', 'FUNDING', 'PURCHASING'].includes(c.status))
    : [];
  const supplierList: any[] = Array.isArray(suppliers) ? suppliers : [];
  const productList: any[] = Array.isArray(products) ? products : [];

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
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('reference')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('supplier')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('cycle')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('currency')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('fxRate')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('orderedDate')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('status')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400">{tc('noData')}</td></tr>
                ) : (
                  paginated.map((po) => (
                    <tr key={po.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs font-medium text-primary-600">{po.reference}</td>
                      <td className="px-4 py-3 text-gray-900">{po.supplier?.name ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600 font-mono text-xs">{po.cycle?.code ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{po.currency}</td>
                       <td className="px-4 py-3 text-gray-600">{po.fxRateToEgp}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(po.orderedOn)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[po.status] ?? 'bg-gray-100 text-gray-600'}`}>
                          {po.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setViewingPO(po)}
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
            paginated.map((po) => (
              <div
                key={po.id}
                onClick={() => setViewingPO(po)}
                className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-sm font-bold text-primary-600">{po.reference}</span>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[po.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {po.status}
                  </span>
                </div>
                <p className="text-sm text-gray-700">{po.supplier?.name ?? '—'}</p>
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
        <Modal title={t('create')} onClose={() => { setShowCreateModal(false); setLineItems([]); }}>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('cycle')}</label>
                <select name="cycleId" required className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                  <option value="">—</option>
                  {cycleList.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.code}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('supplier')}</label>
                <select name="supplierId" required className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                  <option value="">—</option>
                  {supplierList.map((s: any) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('currency')}</label>
              <select name="currency" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                <option value="CNY">CNY</option>
                <option value="AED">AED</option>
                <option value="USD">USD</option>
                <option value="EGP">EGP</option>
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <InputField label={t('fxRate')} name="fxRate" type="number" placeholder="0" />
              <InputField label={t('orderedDate')} name="orderedDate" type="date" required />
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
                        <select
                          value={item.productId}
                          onChange={(e) => updateLineItem(idx, 'productId', e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        >
                          <option value="">—</option>
                          {productList.map((p: any) => (
                            <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>
                          ))}
                        </select>
                      </div>
                      <div className="w-20">
                        <label className="block text-xs text-gray-500 mb-1">{t('orderedQty')}</label>
                        <input
                          type="number"
                          placeholder="0"
                          value={item.orderedQty}
                          onChange={(e) => updateLineItem(idx, 'orderedQty', Number(e.target.value))}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                      <div className="w-24">
                        <label className="block text-xs text-gray-500 mb-1">{t('unitPrice')}</label>
                        <input
                          type="number"
                          placeholder="0"
                          step="0.01"
                          value={item.unitPrice}
                          onChange={(e) => updateLineItem(idx, 'unitPrice', Number(e.target.value))}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                      <div className="w-20">
                        <label className="block text-xs text-gray-500 mb-1">{t('discount')}</label>
                        <input
                          type="number"
                          placeholder="0"
                          step="0.01"
                          value={item.discount}
                          onChange={(e) => updateLineItem(idx, 'discount', Number(e.target.value))}
                          className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
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
              <button type="submit" disabled={createMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {createMutation.isPending ? tc('loading') : tc('create')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── View PO Detail ────────────────────────────────────────── */}
      {viewingPO && (
        <Modal title={viewingPO.reference} onClose={() => setViewingPO(null)}>
          <div className="space-y-6">
            {/* Info */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('supplier')} value={viewingPO.supplier?.name ?? '—'} />
              <Detail label={t('cycle')} value={viewingPO.cycle?.code ?? '—'} />
              <Detail label={t('currency')} value={viewingPO.currency} />
               <Detail label={t('fxRate')} value={String(viewingPO.fxRateToEgp)} />
              <Detail label={t('orderedDate')} value={formatDate(viewingPO.orderedOn)} />
              <Detail label={tc('status')} value={viewingPO.status} />
            </div>

            {/* Items table */}
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-3">{t('items')}</h3>
              {(poDetail?.items ?? viewingPO.items ?? []).length === 0 ? (
                <p className="text-sm text-gray-400">{tc('noData')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('product')}</th>
                        <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('orderedQty')}</th>
                        <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('receivedQty')}</th>
                        <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('unitPrice')}</th>
                        <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('discount')}</th>
                        <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('lineTotal')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {(poDetail?.items ?? viewingPO.items ?? []).map((item: POItem) => (
                        <tr key={item.id}>
                          <td className="py-2">
                            <p className="font-medium text-gray-900">{item.product?.name ?? '—'}</p>
                            <p className="text-xs text-gray-500">{item.product?.sku}</p>
                          </td>
                          <td className="py-2 text-gray-600">{item.orderedQty}</td>
                          <td className="py-2 text-gray-600">{item.receivedQty}</td>
                          <td className="py-2 text-gray-600">{item.unitPrice.toLocaleString()}</td>
                          <td className="py-2 text-gray-600">{item.discount > 0 ? `- ${item.discount.toLocaleString()}` : '—'}</td>
                          <td className="py-2 font-medium text-gray-900">
                            {((item.orderedQty * item.unitPrice) - item.discount).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Refunds */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900">{t('refunds')}</h3>
                <button
                  onClick={() => setShowRefundModal(true)}
                  className="inline-flex items-center gap-1 text-xs bg-amber-50 text-amber-700 px-3 py-1.5 rounded-lg hover:bg-amber-100"
                >
                  <DollarSign className="h-3.5 w-3.5" />
                  {t('recordRefund')}
                </button>
              </div>
              {(poDetail?.refunds ?? []).length === 0 ? (
                <p className="text-sm text-gray-400">{tc('noData')}</p>
              ) : (
                <div className="space-y-2">
                  {(poDetail?.refunds ?? []).map((refund: any) => (
                    <div key={refund.id} className="flex items-center justify-between bg-red-50 rounded-lg px-4 py-3 text-sm">
                      <div>
                        <p className="font-medium text-gray-900">£ {refund.amount?.toLocaleString()}</p>
                        <p className="text-xs text-gray-500">{refund.reason ?? '—'}</p>
                      </div>
                       <span className="text-xs text-gray-500">{refund.recordedOn ?? '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* ─── Refund Modal ──────────────────────────────────────────── */}
      {showRefundModal && viewingPO && (
        <Modal title={t('recordRefund')} onClose={() => setShowRefundModal(false)}>
          <form
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
            <InputField label={t('amount')} name="amount" type="number" required placeholder="0" />
            <InputField label={t('reason')} name="reason" />
            <InputField label={tc('date')} name="recordedOn" type="date" required />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setShowRefundModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700">{tc('save')}</button>
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

function InputField({ label, name, type = 'text', defaultValue, required, placeholder }: { label: string; name: string; type?: string; defaultValue?: string; required?: boolean; placeholder?: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {required ? <span className="text-red-500 ms-1">*</span> : <span className="text-gray-400 ms-1 text-xs font-normal">(Optional)</span>}
      </label>
      <input type={type} name={name} defaultValue={defaultValue} required={required} placeholder={placeholder}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-500 text-xs">{label}</span>
      <p className="font-medium text-gray-900">{value}</p>
    </div>
  );
}
