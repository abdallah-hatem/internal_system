'use client';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useToast } from '../../../components/ui/toast';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import { FormActions } from '../../../components/ui/fields';
import { ENTITY_FORMS } from '../../../components/entities/entity-forms';
import {
  Plus, Search, Edit, X, Loader2, Phone, Mail, MessageCircle, Trash2, ShoppingCart,
} from 'lucide-react';

import { useApiError } from '../../../lib/api-error';
// ─── Types ────────────────────────────────────────────────────────────
/** Free-form on the server; these are the keys the app actually writes. */
interface SupplierContact {
  phone?: string;
  email?: string;
  wechat?: string;
  whatsapp?: string;
}

interface Supplier {
  id: string;
  name: string;
  country: string;
  contactJson?: SupplierContact | null;
  notes?: string;
  _count?: { purchaseOrders?: number };
  purchaseOrders?: unknown[];
}

const contactOf = (s: Supplier): SupplierContact => s.contactJson ?? {};

// ─── Main Page ────────────────────────────────────────────────────────
export default function SuppliersPage() {
  const apiError = useApiError();
  const t = useTranslations('suppliers');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [deletingSupplier, setDeletingSupplier] = useState<Supplier | null>(null);

  useEffect(() => { setPage(1); }, [search]);

  // ── Queries ───────────────────────────────────────────────────────
  // The list endpoint pages at 20 by default, which hides suppliers behind a
  // cursor the page does not follow; ask for the full list and page locally,
  // the way every other directory page here works.
  const { data: suppliers = [], isLoading } = useQuery({
    queryKey: ['suppliers'],
    queryFn: () =>
      api.get('/suppliers', { params: { limit: 200 } }).then((r) => r.data.data ?? r.data),
  });

  const onError = (error: any, fallback: string) =>
    addToast(
      apiError(error, fallback),
      'error',
    );

  // ── Mutations ─────────────────────────────────────────────────────
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['suppliers'] });

  const createMutation = useMutation({
    mutationFn: (data: any) => api.post('/suppliers', data),
    onSuccess: () => {
      invalidate();
      setShowCreateModal(false);
      addToast(t('createSuccess'), 'success');
    },
    onError: (e: any) => onError(e, 'Failed to create supplier'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: any) => api.put(`/suppliers/${id}`, data),
    onSuccess: () => {
      invalidate();
      setEditingSupplier(null);
      addToast(t('updateSuccess'), 'success');
    },
    onError: (e: any) => onError(e, 'Failed to update supplier'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/suppliers/${id}`),
    onSuccess: () => {
      invalidate();
      setDeletingSupplier(null);
      addToast(t('deleteSuccess'), 'success');
    },
    onError: (e: any) => onError(e, 'Failed to delete supplier'),
  });

  // ── Derived ───────────────────────────────────────────────────────
  const supplierList: Supplier[] = Array.isArray(suppliers) ? suppliers : [];

  const filtered = supplierList.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    const c = contactOf(s);
    return (
      s.name?.toLowerCase().includes(q) ||
      s.country?.toLowerCase().includes(q) ||
      c.phone?.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q)
    );
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  // ── Handlers ──────────────────────────────────────────────────────
  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createMutation.mutate(ENTITY_FORMS.supplier.toPayload(fd));
  };

  const handleUpdate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingSupplier) return;
    const fd = new FormData(e.currentTarget);
    // The shared payload always carries `contactJson`, blank keys included.
    // Omitting it would leave the stored contact in place, so clearing a phone
    // number in the form would never stick.
    updateMutation.mutate({ id: editingSupplier.id, ...ENTITY_FORMS.supplier.toPayload(fd) });
  };

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
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

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin me-2" /> {tc('loading')}
        </div>
      )}

      {/* Desktop table */}
      {!isLoading && (
        <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('name')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('country')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('contact')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('orders')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">{t('noData')}</td></tr>
                ) : (
                  paginated.map((supplier) => (
                    <tr key={supplier.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{supplier.name}</td>
                      <td className="px-4 py-3 text-gray-600">{supplier.country || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">
                        <ContactLine contact={contactOf(supplier)} />
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        <span className="inline-flex items-center gap-1">
                          <ShoppingCart className="h-3.5 w-3.5 text-gray-400" />
                          {orderCount(supplier)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setEditingSupplier(supplier)}
                            className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                            title={tc('edit')}
                          >
                            <Edit className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setDeletingSupplier(supplier)}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title={tc('delete')}
                          >
                            <Trash2 className="h-4 w-4" />
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

      {/* Mobile cards */}
      {!isLoading && (
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">{t('noData')}</div>
          ) : (
            paginated.map((supplier) => (
              <div key={supplier.id} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="font-medium text-gray-900">{supplier.name}</p>
                    <p className="text-xs text-gray-500">{supplier.country}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setEditingSupplier(supplier)}
                      className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeletingSupplier(supplier)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="text-sm text-gray-600">
                  <ContactLine contact={contactOf(supplier)} />
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {!isLoading && filtered.length > 0 && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} totalItems={filtered.length} />
      )}

      {/* ─── Create ────────────────────────────────────────────────── */}
      {showCreateModal && (
        <Modal title={t('create')} onClose={() => setShowCreateModal(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <ENTITY_FORMS.supplier.Fields />
            <FormActions
              onCancel={() => setShowCreateModal(false)}
              cancelLabel={tc('cancel')}
              submitLabel={tc('create')}
              busy={createMutation.isPending}
            />
          </form>
        </Modal>
      )}

      {/* ─── Edit ──────────────────────────────────────────────────── */}
      {editingSupplier && (
        <Modal title={t('edit')} onClose={() => setEditingSupplier(null)}>
          <form onSubmit={handleUpdate} className="space-y-4">
            <ENTITY_FORMS.supplier.Fields record={editingSupplier} />
            <FormActions
              onCancel={() => setEditingSupplier(null)}
              cancelLabel={tc('cancel')}
              submitLabel={tc('save')}
              busy={updateMutation.isPending}
            />
          </form>
        </Modal>
      )}

      {/* ─── Delete ────────────────────────────────────────────────── */}
      {deletingSupplier && (
        <Modal title={t('delete')} onClose={() => setDeletingSupplier(null)}>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">{t('confirmDelete')}</p>
            <p className="text-sm font-medium text-gray-900">{deletingSupplier.name}</p>
            {orderCount(deletingSupplier) > 0 && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {t('deleteBlocked')}
              </p>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setDeletingSupplier(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                {tc('cancel')}
              </button>
              <button
                onClick={() => deleteMutation.mutate(deletingSupplier.id)}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {deleteMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('delete')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Purchase orders are counted by the API when it can, listed when it does not. */
function orderCount(s: Supplier): number {
  return s._count?.purchaseOrders ?? s.purchaseOrders?.length ?? 0;
}

function ContactLine({ contact }: { contact: SupplierContact }) {
  const parts = [
    { icon: Phone, value: contact.phone },
    { icon: Mail, value: contact.email },
    { icon: MessageCircle, value: contact.wechat ?? contact.whatsapp },
  ].filter((p) => p.value);

  if (parts.length === 0) return <span className="text-gray-400">—</span>;

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {parts.map(({ icon: Icon, value }) => (
        <span key={value} className="inline-flex items-center gap-1">
          <Icon className="h-3.5 w-3.5 text-gray-400" />
          {value}
        </span>
      ))}
    </span>
  );
}

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

