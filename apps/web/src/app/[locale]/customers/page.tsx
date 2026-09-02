'use client';
import { Money } from '../../../components/ui/money';
import { CustomerLink } from '../../../components/ui/entity-link';
import { Select } from '../../../components/ui/select';

import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useToast } from '../../../components/ui/toast';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import { formatDate } from '../../../lib/dates';
import {
  Users, Plus, Search, Eye, Edit, X, Loader2,
  ChevronRight, Phone, Mail, DollarSign, ShoppingCart,
  ShieldAlert, ShieldCheck,
} from 'lucide-react';

import { useApiError } from '../../../lib/api-error';
import { ENTITY_FORMS } from '../../../components/entities/entity-forms';
import { InputField } from '../../../components/ui/fields';
const CUSTOMER_TYPES = ['B2B', 'B2C'] as const;

// ─── Types ────────────────────────────────────────────────────────────
interface Customer {
  id: string;
  displayName: string;
  type: string;
  /** UNVERIFIED until someone in the office vets a self-signed-up shop. */
  verificationStatus?: 'VERIFIED' | 'UNVERIFIED';
  phone?: string;
  email?: string;
  outstandingBalance: number;
  currency?: string;
  orders?: CustomerOrder[];
}

interface CustomerOrder {
  id: string;
  orderNo: string;
  status: string;
  total: number;
  currency: string;
  createdAt: string;
}

const TYPE_COLORS: Record<string, string> = {
  B2B: 'bg-blue-100 text-blue-700',
  B2C: 'bg-emerald-100 text-emerald-700',
};

// ─── Main Page ────────────────────────────────────────────────────────
export default function CustomersPage() {
  const apiError = useApiError();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('customers');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  // Shops that signed themselves up are UNVERIFIED, and the API hides those
  // from an unfiltered list — so without this control they were unreachable
  // from the panel entirely, and nothing could ever vet them.
  const [verification, setVerification] = useState('');
  const [verifyingCustomer, setVerifyingCustomer] = useState<Customer | null>(null);
  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [viewingCustomer, setViewingCustomer] = useState<Customer | null>(null);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, verification]);

  // ── Queries ───────────────────────────────────────────────────────
  const { data: customers = [], isLoading } = useQuery({
    queryKey: ['customers', verification],
    queryFn: () =>
      api
        .get('/customers', {
          params: { limit: 200, ...(verification ? { verification } : {}) },
        })
        .then((r) => r.data.data ?? r.data),
  });

  const { data: customerDetail } = useQuery({
    queryKey: ['customer', viewingCustomer?.id],
    queryFn: () =>
      api.get(`/customers/${viewingCustomer!.id}`).then((r) => r.data.data ?? r.data),
    enabled: !!viewingCustomer,
  });

  // ── Mutations ─────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: any) => api.post('/customers', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setShowCreateModal(false);
      toast('Customer created successfully', 'success');
    },
    onError: (error: any) => {
      toast(apiError(error, 'Failed to create customer'), 'error');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: any) => api.put(`/customers/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['customer'] });
      setEditingCustomer(null);
      toast('Customer updated successfully', 'success');
    },
    onError: (error: any) => {
      toast(apiError(error, 'Failed to update customer'), 'error');
    },
  });

  const verifyMutation = useMutation({
    mutationFn: (id: string) => api.post(`/customers/${id}/verify`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      toast(t('verifySuccess'), 'success');
    },
    onError: (error: any) => {
      toast(apiError(error, 'Failed to verify customer'), 'error');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const customerList: Customer[] = Array.isArray(customers) ? customers : [];

  const filtered = customerList.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.displayName?.toLowerCase().includes(q) ||
      c.phone?.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q)
    );
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  const detail = (customerDetail as Customer) ?? viewingCustomer;

  // ── Handlers ──────────────────────────────────────────────────────
  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createMutation.mutate(ENTITY_FORMS.customer.toPayload(fd));
  };

  const handleUpdate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingCustomer) return;
    const fd = new FormData(e.currentTarget);
    updateMutation.mutate({
      id: editingCustomer.id,
      displayName: fd.get('displayName'),
      type: fd.get('type'),
      phone: fd.get('phone') || undefined,
      email: fd.get('email') || undefined,
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

      {/* Search + verification filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full max-w-md">
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
          id="verification-filter"
          className="w-full sm:w-52"
          value={verification}
          onChange={setVerification}
          clearable
          placeholder={t('verifiedOnly')}
          options={[
            { value: 'UNVERIFIED', label: t('awaitingReview'), hint: t('awaitingReviewHint') },
            { value: 'ALL', label: t('allCustomers') },
          ]}
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
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('name')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('type')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('phone')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('email')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('balance')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">{tc('noData')}</td></tr>
                  ) : (
                  paginated.map((customer) => (
                    <tr key={customer.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">
                        <span className="inline-flex items-center gap-2">
                          <CustomerLink id={customer.id} name={customer.displayName} />
                          {customer.verificationStatus === 'UNVERIFIED' && (
                            <span
                              title={t('awaitingReviewHint')}
                              className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700"
                            >
                              <ShieldAlert className="h-3 w-3" />
                              {t('awaitingReview')}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[customer.type] ?? 'bg-gray-100 text-gray-600'}`}>
                          {customer.type === 'B2B' ? t('b2b') : t('b2c')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        <span className="inline-flex items-center gap-1">
                          <Phone className="h-3.5 w-3.5 text-gray-400" />
                          {customer.phone ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        <span className="inline-flex items-center gap-1">
                          <Mail className="h-3.5 w-3.5 text-gray-400" />
                          {customer.email ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <Money
                          value={customer.outstandingBalance ?? 0}
                          currency={customer.currency ?? 'EGP'}
                          className={`font-medium ${customer.outstandingBalance > 0 ? 'text-red-600' : 'text-green-600'}`}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          {customer.verificationStatus === 'UNVERIFIED' && (
                            <button
                              onClick={() => setVerifyingCustomer(customer)}
                              disabled={verifyMutation.isPending}
                              className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors disabled:opacity-50"
                              title={t('verify')}
                            >
                              <ShieldCheck className="h-4 w-4" />
                            </button>
                          )}
                          <button
                            onClick={() => router.push(`/${locale}/customers/${customer.id}`)}
                            className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                            title={tc('view')}
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setEditingCustomer(customer)}
                            className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                            title={tc('edit')}
                          >
                            <Edit className="h-4 w-4" />
                          </button>
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
            paginated.map((customer) => (
              <div
                key={customer.id}
onClick={() => router.push(`/${locale}/customers/${customer.id}`)}
                className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-2">
                  <p className="font-medium text-gray-900">
                    <CustomerLink id={customer.id} name={customer.displayName} />
                  </p>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[customer.type] ?? 'bg-gray-100 text-gray-600'}`}>
                    {customer.type === 'B2B' ? t('b2b') : t('b2c')}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-600 mb-2">
                  <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5 text-gray-400" />{customer.phone ?? '—'}</span>
                  <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5 text-gray-400" />{customer.email ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                  <span className={`font-medium text-sm ${customer.outstandingBalance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {t('balance')}:{' '}
                    <Money value={customer.outstandingBalance ?? 0} currency={customer.currency ?? 'EGP'} />
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditingCustomer(customer); }}
                      className="text-xs text-gray-500 hover:text-amber-600 px-2 py-1 rounded"
                    >
                      <Edit className="h-3.5 w-3.5" />
                    </button>
                    <ChevronRight className="h-4 w-4 text-gray-400" />
                  </div>
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
        <Modal title={t('create')} onClose={() => setShowCreateModal(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <ENTITY_FORMS.customer.Fields />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" disabled={createMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('create')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── Verify Confirmation ───────────────────────────────────── */}
      {verifyingCustomer && (
        <Modal title={t('verify')} onClose={() => setVerifyingCustomer(null)}>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">{t('confirmVerify')}</p>
            <p className="text-sm font-medium text-gray-900">{verifyingCustomer.displayName}</p>
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              {t('verifyWarning')}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setVerifyingCustomer(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                {tc('cancel')}
              </button>
              <button
                type="button"
                disabled={verifyMutation.isPending}
                onClick={() =>
                  verifyMutation.mutate(verifyingCustomer.id, {
                    onSuccess: () => setVerifyingCustomer(null),
                  })
                }
                className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {verifyMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('verify')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ─── Edit Modal ────────────────────────────────────────────── */}
      {editingCustomer && (
        <Modal title={t('edit')} onClose={() => setEditingCustomer(null)}>
          <form onSubmit={handleUpdate} className="space-y-4">
            <InputField label={t('name')} name="displayName" defaultValue={editingCustomer.displayName} required />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('type')}<span className="text-red-500 ms-1">*</span>
              </label>
              <Select
                name="type"
                required
                defaultValue={editingCustomer.type}
                options={CUSTOMER_TYPES.map((v) => ({ value: v, label: t(v.toLowerCase()) }))}
              />
            </div>
            <InputField label={t('phone')} name="phone" type="tel" defaultValue={editingCustomer.phone} />
            <InputField label={t('email')} name="email" type="email" defaultValue={editingCustomer.email} />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setEditingCustomer(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" disabled={updateMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('save')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── View Customer Detail ──────────────────────────────────── */}
      {viewingCustomer && detail && (
        <Modal title={detail.displayName} onClose={() => setViewingCustomer(null)}>
          <div className="space-y-6">
            {/* Info */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('name')} value={detail.displayName} />
              <Detail label={t('type')} value={detail.type === 'B2B' ? t('b2b') : t('b2c')} />
              <Detail label={t('phone')} value={detail.phone ?? '—'} />
              <Detail label={t('email')} value={detail.email ?? '—'} />
              <Detail
                label={t('balance')}
                value={<Money value={detail.outstandingBalance ?? 0} currency={detail.currency ?? 'EGP'} />}
              />
            </div>

            {/* Orders */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900">{t('orders')}</h3>
                <span className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 px-2.5 py-0.5 rounded-full">
                  <ShoppingCart className="h-3 w-3" />
                  {(detail.orders ?? []).length}
                </span>
              </div>
              {(detail.orders ?? []).length === 0 ? (
                <p className="text-sm text-gray-400">{tc('noData')}</p>
              ) : (
                <div className="space-y-2">
                  {(detail.orders ?? []).map((order: CustomerOrder) => (
                    <div key={order.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3 text-sm">
                      <div>
                        <p className="font-medium text-gray-900">{order.orderNo}</p>
                        <p className="text-xs text-gray-500">{formatDate(order.createdAt)}</p>
                      </div>
                      <div className="text-end">
                        <p className="font-medium text-gray-900"><Money value={order.total} currency={order.currency} /></p>
                        <span className={`text-xs font-medium ${order.status === 'PAID' ? 'text-green-600' : 'text-orange-600'}`}>
                          {order.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
