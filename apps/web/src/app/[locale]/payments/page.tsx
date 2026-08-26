'use client';
import { Select } from '../../../components/ui/select';
import { CustomerLink } from '../../../components/ui/entity-link';
import { Money } from '../../../components/ui/money';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useToast } from '../../../components/ui/toast';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import { formatDate } from '../../../lib/dates';
import { TextareaField } from '../../../components/ui/textarea-field';
import { MoneyInput } from '../../../components/ui/money-input';
import {
  CreditCard, Plus, Search, Eye, X, Loader2,
  ChevronRight, ArrowRightLeft, Ban, RotateCcw,
} from 'lucide-react';

import { useApiError } from '../../../lib/api-error';
import { FieldWithQuickCreate } from '../../../components/ui/quick-create';
import { InputField } from '../../../components/ui/fields';
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

interface Customer {
  id: string;
  displayName: string;
}

interface SaleOrder {
  id: string;
  orderNo: string;
  customerId: string;
  outstanding: number;
  currency: string;
}

const STATUS_COLORS: Record<string, string> = {
  RECORDED: 'bg-green-100 text-green-700',
  REVERSED: 'bg-red-100 text-red-700',
};

const STATUS_KEYS: Record<string, string> = {
  RECORDED: 'recorded',
  REVERSED: 'reversed',
};

const METHOD_KEYS: Record<string, string> = {
  CASH: 'cash',
  BANK_TRANSFER: 'bankTransfer',
  MOBILE_WALLET: 'mobileWallet',
  cash: 'cash',
  bank: 'bankTransfer',
  bank_transfer: 'bankTransfer',
  mobile_wallet: 'mobileWallet',
};

// ─── Main Page ────────────────────────────────────────────────────────
export default function PaymentsPage() {
  const apiError = useApiError();
  const t = useTranslations('payments');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCustomerId, setNewCustomerId] = useState('');
  const [showAllocateModal, setShowAllocateModal] = useState(false);
  const [showReverseModal, setShowReverseModal] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null);
  const [viewingPayment, setViewingPayment] = useState<Payment | null>(null);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search]);

  // ── Queries ───────────────────────────────────────────────────────
  const { data: payments = [], isLoading } = useQuery({
    queryKey: ['payments'],
    queryFn: () => api.get('/payments').then((r) => r.data.data ?? r.data),
  });

  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get('/customers').then((r) => r.data.data ?? r.data),
  });

  const { data: orders = [] } = useQuery({
    queryKey: ['sales'],
    queryFn: () => api.get('/sales/orders').then((r) => r.data.data ?? r.data),
  });

  const { data: paymentDetail } = useQuery({
    queryKey: ['payment', viewingPayment?.id],
    queryFn: () =>
      api.get(`/payments/${viewingPayment!.id}`).then((r) => r.data.data ?? r.data),
    enabled: !!viewingPayment,
  });

  // ── Mutations ─────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: any) => api.post('/payments', data),
    onSuccess: () => {
      toast('Payment recorded successfully', 'success');
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      setShowCreateModal(false);
    },
    onError: (error: any) => {
      toast(apiError(error, 'Failed to create payment'), 'error');
    },
  });

  const allocateMutation = useMutation({
    mutationFn: (data: any) => api.post(`/payments/${selectedPayment!.id}/allocations`, data),
    onSuccess: () => {
      toast('Payment allocated successfully', 'success');
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['payment'] });
      setShowAllocateModal(false);
      setSelectedPayment(null);
    },
    onError: (error: any) => {
      toast(apiError(error, 'Failed to allocate payment'), 'error');
    },
  });

  const reverseMutation = useMutation({
    mutationFn: (data: any) => api.post(`/payments/${selectedPayment!.id}/reverse`, data),
    onSuccess: () => {
      toast('Payment reversed successfully', 'success');
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      setShowReverseModal(false);
      setSelectedPayment(null);
    },
    onError: (error: any) => {
      toast(apiError(error, 'Failed to reverse payment'), 'error');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const paymentList: Payment[] = Array.isArray(payments) ? payments : [];
  const customerList: Customer[] = Array.isArray(customers) ? customers : [];
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

  // ── Handlers ──────────────────────────────────────────────────────
  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createMutation.mutate({
      customerId: fd.get('customerId'),
      amount: Number(fd.get('amount')),
      currency: fd.get('currency'),
      method: fd.get('method'),
      reference: fd.get('reference'),
      receivedOn: fd.get('receivedOn'),
    });
  };

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
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('customer')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('amount')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('currency')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('method')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('receivedOn')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('reference')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('status')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400">{tc('noData')}</td></tr>
                  ) : (
                    paginated.map((payment) => (
                      <tr key={payment.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-gray-900 font-medium">
                        <CustomerLink id={payment.customerId} name={payment.customer?.displayName} />
                      </td>
                      <td className="px-4 py-3 text-gray-900 font-medium"><Money value={payment.amount} /></td>
                      <td className="px-4 py-3 text-gray-600">{payment.currency}</td>
                      <td className="px-4 py-3 text-gray-600">{t(METHOD_KEYS[payment.method] ?? payment.method)}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(payment.receivedOn)}</td>
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">{payment.reference ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[payment.status] ?? 'bg-gray-100 text-gray-600'}`}>
                          {t(STATUS_KEYS[payment.status] ?? payment.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
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
                    {t(STATUS_KEYS[payment.status] ?? payment.status)}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-sm mb-2">
                  <span className="font-medium text-gray-900"><Money value={payment.amount} currency={payment.currency} /></span>
                  <span className="text-gray-500">{t(METHOD_KEYS[payment.method] ?? payment.method)}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>{formatDate(payment.receivedOn)}</span>
                  <span className="font-mono">{payment.reference ?? '—'}</span>
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

      {/* ─── Record Payment Modal ──────────────────────────────────── */}
      {showCreateModal && (
        <Modal title={t('create')} onClose={() => setShowCreateModal(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('customer')}</label>
              <FieldWithQuickCreate
                entity="customer"
                onCreated={(c) => setNewCustomerId(c.id)}
              >
                <Select
                  name="customerId"
                  required
                  value={newCustomerId}
                  onChange={setNewCustomerId}
                  placeholder={t('customer')}
                  searchPlaceholder={tc('search')}
                  options={customerList.map((c) => ({
                    value: c.id,
                    label: c.displayName,
                  }))}
                />
              </FieldWithQuickCreate>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                {t('amount')}<span className="ms-1 text-red-500">*</span>
              </label>
              <MoneyInput name="amount" required placeholder="0.00" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-end text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('method')}</label>
                <Select
                  name="method"
                  required
                  defaultValue="CASH"
                  options={[
                    { value: 'CASH', label: t('cash') },
                    { value: 'BANK_TRANSFER', label: t('bankTransfer') },
                    { value: 'MOBILE_WALLET', label: t('mobileWallet') },
                  ]}
                />
              </div>
              <InputField label={t('receivedOn')} name="receivedOn" type="date" required />
            </div>
            <InputField label={t('reference')} name="reference" />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" disabled={createMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('save')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── Allocate Modal ────────────────────────────────────────── */}
      {showAllocateModal && selectedPayment && (
        <Modal title={t('allocate')} onClose={() => { setShowAllocateModal(false); setSelectedPayment(null); }}>
          <form onSubmit={handleAllocate} className="space-y-4">
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
                placeholder={t('saleOrder')}
                searchPlaceholder={tc('search')}
                options={orderList
                  // This payer's orders only, and only ones still owing. The
                  // list was every order in the system by number, which made
                  // paying off the wrong shop a slip of one click.
                  .filter(
                    (o: SaleOrder) =>
                      o.customerId === selectedPayment?.customerId &&
                      Number(o.outstanding) > 0,
                  )
                  .map((o: SaleOrder) => ({
                    value: o.id,
                    label: o.orderNo,
                    hint: `${t('outstanding')}: ${Number(o.outstanding).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })} ${o.currency}`,
                  }))}
                emptyText={t('noOpenOrders')}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                {t('allocateAmount')}<span className="ms-1 text-red-500">*</span>
              </label>
              <MoneyInput name="allocateAmount" required placeholder="0.00" className="w-full rounded-lg border border-gray-200 px-3 py-2 text-end text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => { setShowAllocateModal(false); setSelectedPayment(null); }} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" disabled={allocateMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {allocateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('confirm')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── Reverse Modal ─────────────────────────────────────────── */}
      {showReverseModal && selectedPayment && (
        <Modal title={t('reverse')} onClose={() => { setShowReverseModal(false); setSelectedPayment(null); }}>
          <form onSubmit={handleReverse} className="space-y-4">
            <p className="text-sm text-gray-600">
              {t('customer')}: <span className="font-medium text-gray-900">{selectedPayment.customer?.displayName ?? '—'}</span>
            </p>
            <p className="text-sm text-gray-600">
              {t('amount')}: <span className="font-medium text-gray-900"><Money value={selectedPayment.amount} currency={selectedPayment.currency} /></span>
            </p>
            <TextareaField label={t('reverseReason')} name="reason" required minLength={3} />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => { setShowReverseModal(false); setSelectedPayment(null); }} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" disabled={reverseMutation.isPending} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2">
                {reverseMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('reverse')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── View Payment Detail ───────────────────────────────────── */}
      {viewingPayment && (
        <Modal title={`${t('customer')}: ${viewingPayment.customer?.displayName ?? '—'}`} onClose={() => setViewingPayment(null)}>
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('customer')} value={viewingPayment.customer?.displayName ?? '—'} />
              <Detail label={t('amount')} value={<Money value={viewingPayment.amount} currency={viewingPayment.currency} />} />
              <Detail label={t('method')} value={t(METHOD_KEYS[viewingPayment.method] ?? viewingPayment.method)} />
              <Detail label={t('receivedOn')} value={formatDate(viewingPayment.receivedOn)} />
              <Detail label={t('reference')} value={viewingPayment.reference ?? '—'} />
              <Detail label={t('status')} value={t(STATUS_KEYS[viewingPayment.status] ?? viewingPayment.status)} />
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
