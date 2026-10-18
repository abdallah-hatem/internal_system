'use client';
import { NoMatch } from '@/components/ui/no-match';
import { LatinText } from '@/components/ui/latin-text';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '@/components/ui/pagination';
import { TextareaField } from '@/components/ui/textarea-field';
import {
  Truck, Plus, Edit, Loader2, Phone, Mail, User, Trash2,
} from 'lucide-react';

import { useApiError } from '@/lib/api-error';
import { ENTITY_FORMS } from '@/components/entities/entity-forms';
import { InputField } from '@/components/ui/fields';
import { ValidatedForm } from '@/components/ui/validated-form';
import { EmptyState } from '@/components/ui/empty-state';
import { useCan } from '@/lib/can';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { ListToolbar } from '@/components/ui/list-toolbar';
// ─── Types ────────────────────────────────────────────────────────────
interface Provider {
  id: string;
  name: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

// ─── Skeletons ────────────────────────────────────────────────────────
// The table's skeleton rows are drawn by DataTable from each column's
// `skeleton`; the phone card below is traced by hand, with the 28px icon
// buttons when the reader may edit. Change one, change the other.

function ProviderCardSkeleton({ actions }: { actions: number }) {
  return (
    <div data-testid="skeleton-row" className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <SkeletonText size="base" className="w-32" />
        {actions > 0 && (
          <div className="flex items-center gap-1">
            {repeat(actions, (i) => <Skeleton key={i} className="size-7 rounded-lg" />)}
          </div>
        )}
      </div>
      {/* Contact person and phone. The email line is left out: it is the
          rare one, and a card without it is the usual height. */}
      <div className="flex items-center gap-4 mb-1">
        <SkeletonText className="w-24" />
        <SkeletonText className="w-28" />
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function ProvidersPage() {
  const apiError = useApiError();
  const t = useTranslations('providers');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  // Reading shipping providers is everyone's; changing them is a partner's (R1c).
  const may = {
    create: useCan('provider.create'),
    edit: useCan('provider.edit'),
    delete: useCan('provider.delete'),
  };
  const mayRow = may.edit || may.delete;
  /** The icon buttons a row carries, for its skeleton. */
  const actionCount = (may.edit ? 1 : 0) + (may.delete ? 1 : 0);

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
      addToast(apiError(error, t('createFailed')), 'error');
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
      addToast(apiError(error, t('updateFailed')), 'error');
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
      addToast(apiError(error, t('deleteFailed')), 'error');
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

  // Nothing at all says what goes here and offers the first one; nothing for
  // this search or filter says only that (UX #12).
  const emptyList =
    providerList.length === 0 ? (
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

  // ── Columns ───────────────────────────────────────────────────────
  // Name, contact person, phone, email, and the actions when the reader may
  // act (components/ui/data-table.tsx). A long contact, phone or email is cut
  // with the whole of it on hover; the name takes what is left. The actions
  // cell exists only with its header — rows used to keep an empty fifth cell
  // under a four-column header for a reader who may not act.
  const columns: Column<Provider>[] = [
    {
      key: 'name', header: t('name'), width: 'auto', kind: 'name', className: 'font-medium text-gray-900',
      title: (p) => p.name, cell: (p) => <LatinText>{p.name}</LatinText>,
    },
    {
      key: 'contactPerson', header: t('contactPerson'), width: '12rem', className: 'text-gray-600',
      skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (p) => (
        <span className="flex items-center gap-1">
          <User className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          {p.contactPerson ? <LatinText truncate>{p.contactPerson}</LatinText> : '—'}
        </span>
      ),
    },
    {
      key: 'phone', header: t('phone'), width: '10rem', className: 'text-gray-600',
      skeleton: { kind: 'text', share: 'w-3/4' },
      cell: (p) => (
        <span className="flex items-center gap-1">
          <Phone className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          {p.phone ? <LatinText dir="ltr" truncate>{p.phone}</LatinText> : '—'}
        </span>
      ),
    },
    {
      key: 'email', header: t('email'), width: '15rem', className: 'text-gray-600',
      skeleton: { kind: 'text', share: 'w-3/4' },
      cell: (p) => (
        <span className="flex items-center gap-1">
          <Mail className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          {p.email ? <LatinText truncate>{p.email}</LatinText> : '—'}
        </span>
      ),
    },
    ...(mayRow
      ? [{
          key: 'actions', header: tc('actions'), width: '6rem', skeleton: { kind: 'buttons', count: actionCount },
          cell: (provider: Provider) => (
            <div className="flex items-center gap-1">
              {may.edit && (
              <button
                type="button"
                data-testid="edit-action"
                onClick={() => setEditingProvider(provider)}
                className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors cursor-pointer"
                title={tc('edit')}
              >
                <Edit className="h-4 w-4" />
              </button>
              )}
              {may.delete && (
              <button
                type="button"
                data-testid="delete-action"
                onClick={() => setDeletingProvider(provider)}
                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                title={tc('delete')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
              )}
            </div>
          ),
        } satisfies Column<Provider>]
      : []),
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
      <ListToolbar search={{ value: search, onChange: setSearch, placeholder: t('search') }} />

      {/* Loading: the table's own header over skeleton rows, skeleton cards on a phone. */}
      {isLoading && <LoadingStatus />}

      {/* Desktop Table — the shared one (components/ui/data-table.tsx). */}
      <DataTable
        className="hidden md:block"
        columns={columns}
        rows={paginated}
        rowKey={(p) => p.id}
        isLoading={isLoading}
        empty={emptyList}
      />

      {/* Mobile Cards */}
      {isLoading && (
        <SkeletonGroup className="md:hidden space-y-3">
          {repeat(PAGE_SIZE, (i) => <ProviderCardSkeleton key={i} actions={actionCount} />)}
        </SkeletonGroup>
      )}
      {!isLoading && (
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200">{emptyList}</div>
          ) : (
            paginated.map((provider) => (
              <div
                key={provider.id}
                className="bg-white rounded-xl border border-gray-200 p-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-2">
                  <p className="min-w-0 font-medium text-gray-900"><LatinText>{provider.name}</LatinText></p>
                  {mayRow && (
                  <div className="flex items-center gap-1">
                    {may.edit && (
                    <button
                      type="button"
                      data-testid="edit-action"
                      onClick={() => setEditingProvider(provider)}
                      className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors cursor-pointer"
                      title={tc('edit')}
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    )}
                    {may.delete && (
                    <button
                      type="button"
                      data-testid="delete-action"
                      onClick={() => setDeletingProvider(provider)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                      title={tc('delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    )}
                  </div>
                  )}
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-600 mb-1">
                  {provider.contactPerson && (
                    <span className="inline-flex items-center gap-1"><User className="h-3.5 w-3.5 text-gray-400" /><LatinText>{provider.contactPerson}</LatinText></span>
                  )}
                  {provider.phone && (
                    <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5 text-gray-400" /><span dir="ltr">{provider.phone}</span></span>
                  )}
                </div>
                {provider.email && (
                  <span className="inline-flex items-center gap-1 text-sm text-gray-600">
                    <Mail className="h-3.5 w-3.5 text-gray-400" /><LatinText>{provider.email}</LatinText>
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
        <Dialog
          title={t('create')}
          onClose={() => setShowCreateModal(false)}
          footer={
            <>
              <button type="button" onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit"
                form="providers-1-form" disabled={createMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('create')}
              </button>
            </>
          }
        >
          <ValidatedForm id="providers-1-form" onSubmit={handleCreate} className="space-y-4">
            <ENTITY_FORMS.provider.Fields />
          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── Edit Modal ────────────────────────────────────────────── */}
      {editingProvider && (
        <Dialog
          title={t('edit')}
          onClose={() => setEditingProvider(null)}
          footer={
            <>
              <button type="button" onClick={() => setEditingProvider(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit"
                form="providers-2-form" disabled={updateMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('save')}
              </button>
            </>
          }
        >
          <ValidatedForm id="providers-2-form" onSubmit={handleUpdate} className="space-y-4">
            <InputField label={t('name')} name="name" defaultValue={editingProvider.name} required placeholder={tph('providerName')} />
            <InputField label={t('contactPerson')} name="contactPerson" defaultValue={editingProvider.contactPerson} placeholder={tph('contactPerson')} />
            <div className="field-row grid grid-cols-1 sm:grid-cols-2 gap-4">
              <InputField label={t('phone')} name="phone" type="tel" defaultValue={editingProvider.phone} placeholder={tph('phone')} />
              <InputField label={t('email')} name="email" type="email" defaultValue={editingProvider.email} placeholder={tph('email')} />
            </div>
            <TextareaField label={t('notes')} name="notes" defaultValue={editingProvider.notes} placeholder={t('notesPlaceholder')} />
          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── Delete Confirmation Modal ─────────────────────────────── */}
      {deletingProvider && (
        <Dialog
          title={t('delete')}
          onClose={() => setDeletingProvider(null)}
          footer={
            <>
              <button type="button" onClick={() => setDeletingProvider(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button
                onClick={() => deleteMutation.mutate(deletingProvider.id)}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {deleteMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('delete')}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-600">{t('confirmDelete')}</p>
            <p className="text-sm font-medium text-gray-900"><LatinText>{deletingProvider.name}</LatinText></p>
          </div>
        </Dialog>
      )}
    </div>
  );
}
