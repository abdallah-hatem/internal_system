'use client';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useToast } from '../../../components/ui/toast';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import { TextareaField } from '../../../components/ui/textarea-field';
import {
  Truck, Plus, Search, Edit, X, Loader2, Phone, Mail, User, Trash2,
} from 'lucide-react';

import { useApiError } from '../../../lib/api-error';
import { ENTITY_FORMS } from '../../../components/entities/entity-forms';
import { InputField } from '../../../components/ui/fields';
// ─── Types ────────────────────────────────────────────────────────────
interface Provider {
  id: string;
  name: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function ProvidersPage() {
  const apiError = useApiError();
  const t = useTranslations('providers');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<Provider | null>(null);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search]);

  // ── Queries ───────────────────────────────────────────────────────
  const { data: providers = [], isLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get('/providers').then((r) => r.data.data ?? r.data),
  });

  // ── Mutations ─────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: any) => api.post('/providers', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      setShowCreateModal(false);
      addToast(t('createSuccess'), 'success');
    },
    onError: (error: any) => {
      addToast(apiError(error, 'Failed to create provider'), 'error');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: any) => api.put(`/providers/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      setEditingProvider(null);
      addToast(t('updateSuccess'), 'success');
    },
    onError: (error: any) => {
      addToast(apiError(error, 'Failed to update provider'), 'error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/providers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['providers'] });
      setDeletingProvider(null);
      addToast(t('deleteSuccess'), 'success');
    },
    onError: (error: any) => {
      addToast(apiError(error, 'Failed to delete provider'), 'error');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const providerList: Provider[] = Array.isArray(providers) ? providers : [];

  const filtered = providerList.filter((p) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      p.name?.toLowerCase().includes(q) ||
      p.contactPerson?.toLowerCase().includes(q) ||
      p.phone?.toLowerCase().includes(q) ||
      p.email?.toLowerCase().includes(q)
    );
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  // ── Handlers ──────────────────────────────────────────────────────
  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createMutation.mutate(ENTITY_FORMS.provider.toPayload(fd));
  };

  const handleUpdate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingProvider) return;
    const fd = new FormData(e.currentTarget);
    updateMutation.mutate({
      id: editingProvider.id,
      name: fd.get('name'),
      contactPerson: fd.get('contactPerson') || undefined,
      phone: fd.get('phone') || undefined,
      email: fd.get('email') || undefined,
      notes: fd.get('notes') || undefined,
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
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('name')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('contactPerson')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('phone')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('email')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">{t('noData')}</td></tr>
                ) : (
                  paginated.map((provider) => (
                    <tr key={provider.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{provider.name}</td>
                      <td className="px-4 py-3 text-gray-600">
                        <span className="inline-flex items-center gap-1">
                          <User className="h-3.5 w-3.5 text-gray-400" />
                          {provider.contactPerson ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        <span className="inline-flex items-center gap-1">
                          <Phone className="h-3.5 w-3.5 text-gray-400" />
                          {provider.phone ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        <span className="inline-flex items-center gap-1">
                          <Mail className="h-3.5 w-3.5 text-gray-400" />
                          {provider.email ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setEditingProvider(provider)}
                            className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                            title={tc('edit')}
                          >
                            <Edit className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setDeletingProvider(provider)}
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

      {/* Mobile Cards */}
      {!isLoading && (
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">{t('noData')}</div>
          ) : (
            paginated.map((provider) => (
              <div
                key={provider.id}
                className="bg-white rounded-xl border border-gray-200 p-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-2">
                  <p className="font-medium text-gray-900">{provider.name}</p>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setEditingProvider(provider)}
                      className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeletingProvider(provider)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-600 mb-1">
                  {provider.contactPerson && (
                    <span className="inline-flex items-center gap-1"><User className="h-3.5 w-3.5 text-gray-400" />{provider.contactPerson}</span>
                  )}
                  {provider.phone && (
                    <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5 text-gray-400" />{provider.phone}</span>
                  )}
                </div>
                {provider.email && (
                  <span className="inline-flex items-center gap-1 text-sm text-gray-600">
                    <Mail className="h-3.5 w-3.5 text-gray-400" />{provider.email}
                  </span>
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

      {/* ─── Create Modal ──────────────────────────────────────────── */}
      {showCreateModal && (
        <Modal title={t('create')} onClose={() => setShowCreateModal(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <ENTITY_FORMS.provider.Fields />
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

      {/* ─── Edit Modal ────────────────────────────────────────────── */}
      {editingProvider && (
        <Modal title={t('edit')} onClose={() => setEditingProvider(null)}>
          <form onSubmit={handleUpdate} className="space-y-4">
            <InputField label={t('name')} name="name" defaultValue={editingProvider.name} required />
            <InputField label={t('contactPerson')} name="contactPerson" defaultValue={editingProvider.contactPerson} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <InputField label={t('phone')} name="phone" type="tel" defaultValue={editingProvider.phone} />
              <InputField label={t('email')} name="email" type="email" defaultValue={editingProvider.email} />
            </div>
            <TextareaField label={t('notes')} name="notes" defaultValue={editingProvider.notes} placeholder="Additional notes..." />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setEditingProvider(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" disabled={updateMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('save')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── Delete Confirmation Modal ─────────────────────────────── */}
      {deletingProvider && (
        <Modal title={t('delete')} onClose={() => setDeletingProvider(null)}>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">{t('confirmDelete')}</p>
            <p className="text-sm font-medium text-gray-900">{deletingProvider.name}</p>
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setDeletingProvider(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button
                onClick={() => deleteMutation.mutate(deletingProvider.id)}
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

