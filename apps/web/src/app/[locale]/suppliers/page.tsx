'use client';
import { NoMatch } from '@/components/ui/no-match';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useToast } from '../../../components/ui/toast';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import { FormActions } from '../../../components/ui/fields';
import { ENTITY_FORMS } from '../../../components/entities/entity-forms';
import {
  Plus, Search, Edit, Loader2, Phone, Mail, MessageCircle, Trash2, ShoppingCart,
} from 'lucide-react';

import { useApiError } from '../../../lib/api-error';
import { ValidatedForm } from '@/components/ui/validated-form';
import { EmptyState } from '@/components/ui/empty-state';
import { useCan } from '@/lib/can';
import { useCountryLabel } from './country';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/ui/data-table';
import { LatinText } from '@/components/ui/latin-text';
import { Dialog } from '@/components/ui/dialog';
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

// ─── Skeletons ────────────────────────────────────────────────────────
// The table's skeleton rows are drawn by DataTable from each column's
// `skeleton`; the phone card below is traced by hand, with the 28px icon
// buttons when the reader may edit. Change one, change the other.

function SupplierCardSkeleton({ actions }: { actions: number }) {
  return (
    <div data-testid="skeleton-row" className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <SkeletonText size="base" className="w-36" />
          <SkeletonText size="xs" className="w-16" />
        </div>
        {actions > 0 && (
          <div className="flex items-center gap-1">
            {repeat(actions, (i) => <Skeleton key={i} className="size-7 rounded-lg" />)}
          </div>
        )}
      </div>
      {/* A phone and an email: on a phone's width they wrap to two lines. */}
      <div className="flex flex-col gap-y-1">
        <SkeletonText className="w-28" />
        <SkeletonText className="w-44" />
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function SuppliersPage() {
  const apiError = useApiError();
  const t = useTranslations('suppliers');
  const tc = useTranslations('common');
  const countryLabel = useCountryLabel();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  // Reading suppliers is everyone's; changing them is a partner's (R1c).
  const may = {
    create: useCan('supplier.create'),
    edit: useCan('supplier.edit'),
    delete: useCan('supplier.delete'),
  };
  const mayRow = may.edit || may.delete;
  /** The icon buttons a row carries, for its skeleton. */
  const actionCount = (may.edit ? 1 : 0) + (may.delete ? 1 : 0);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [deletingSupplier, setDeletingSupplier] = useState<Supplier | null>(null);

  useEffect(() => { setPage(1); }, [search]);

  // ── Queries ───────────────────────────────────────────────────────
  // The list endpoint pages at 20 by default, and asking for 200 only moved
  // the wall; walk every page and page locally (L1).
  const { items: suppliers, capped, isLoading } = useAllRecords(['suppliers'], '/suppliers');

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
    onError: (e: any) => onError(e, t('createFailed')),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: any) => api.put(`/suppliers/${id}`, data),
    onSuccess: () => {
      invalidate();
      setEditingSupplier(null);
      addToast(t('updateSuccess'), 'success');
    },
    onError: (e: any) => onError(e, t('updateFailed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/suppliers/${id}`),
    onSuccess: () => {
      invalidate();
      setDeletingSupplier(null);
      addToast(t('deleteSuccess'), 'success');
    },
    onError: (e: any) => onError(e, t('deleteFailed')),
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

  // Nothing at all says what goes here and offers the first one; nothing for
  // this search or filter says only that (UX #12).
  const emptyList =
    supplierList.length === 0 ? (
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

  // ── Columns ───────────────────────────────────────────────────────
  // Name, country, contact, orders, and the actions when the reader may act
  // (components/ui/data-table.tsx). A long country or contact is cut with the
  // whole of it on hover; the name takes what is left.
  const columns: Column<Supplier>[] = [
    {
      key: 'name', header: t('name'), width: 'auto', kind: 'name', className: 'font-medium text-gray-900',
      title: (s) => s.name, cell: (s) => <LatinText>{s.name}</LatinText>,
    },
    {
      key: 'country', header: t('country'), width: '9rem', kind: 'label', className: 'text-gray-600',
      title: (s) => countryLabel(s.country), skeleton: { kind: 'text', share: 'w-2/3' }, cell: (s) => countryLabel(s.country),
    },
    {
      key: 'contact', header: t('contact'), width: '18rem', className: 'text-gray-600',
      skeleton: { kind: 'text', share: 'w-3/4' }, cell: (s) => <ContactLine contact={contactOf(s)} />,
    },
    {
      key: 'orders', header: t('orders'), width: '7rem', kind: 'value', className: 'text-gray-600',
      skeleton: { kind: 'text', share: 'w-1/4' },
      cell: (s) => (
        <span className="inline-flex items-center gap-1">
          <ShoppingCart className="h-3.5 w-3.5 text-gray-400" />
          {orderCount(s)}
        </span>
      ),
    },
    ...(mayRow
      ? [{
          key: 'actions', header: tc('actions'), width: '6rem', skeleton: { kind: 'buttons', count: actionCount },
          cell: (supplier: Supplier) => (
            <div className="flex items-center gap-1">
              {may.edit && (
              <button
                type="button"
                data-testid="edit-action"
                onClick={() => setEditingSupplier(supplier)}
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
                onClick={() => setDeletingSupplier(supplier)}
                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                title={tc('delete')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
              )}
            </div>
          ),
        } satisfies Column<Supplier>]
      : []),
  ];

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
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

      <ListCapNotice capped={capped} count={suppliers.length} />

      {/* Loading: the table's own header over skeleton rows, skeleton cards on a phone. */}
      {isLoading && <LoadingStatus />}

      {/* Desktop table — the shared one (components/ui/data-table.tsx). */}
      <DataTable
        className="hidden md:block"
        columns={columns}
        rows={paginated}
        rowKey={(s) => s.id}
        isLoading={isLoading}
        empty={emptyList}
      />

      {/* Mobile cards */}
      {isLoading && (
        <SkeletonGroup className="md:hidden space-y-3">
          {repeat(PAGE_SIZE, (i) => <SupplierCardSkeleton key={i} actions={actionCount} />)}
        </SkeletonGroup>
      )}
      {!isLoading && (
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200">{emptyList}</div>
          ) : (
            paginated.map((supplier) => (
              <div key={supplier.id} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="font-medium text-gray-900">{supplier.name}</p>
                    {supplier.country && <p className="text-xs text-gray-500">{countryLabel(supplier.country)}</p>}
                  </div>
                  {mayRow && (
                  <div className="flex items-center gap-1">
                    {may.edit && (
                    <button
                      type="button"
                      data-testid="edit-action"
                      onClick={() => setEditingSupplier(supplier)}
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
                      onClick={() => setDeletingSupplier(supplier)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                      title={tc('delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    )}
                  </div>
                  )}
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
        <Dialog
          title={t('create')}
          onClose={() => setShowCreateModal(false)}
          footer={
            <FormActions
              form="supplier-create-form"
              onCancel={() => setShowCreateModal(false)}
              cancelLabel={tc('cancel')}
              submitLabel={tc('create')}
              busy={createMutation.isPending}
            />
          }
        >
          <ValidatedForm id="supplier-create-form" onSubmit={handleCreate} className="space-y-4">
            <ENTITY_FORMS.supplier.Fields />
          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── Edit ──────────────────────────────────────────────────── */}
      {editingSupplier && (
        <Dialog
          title={t('edit')}
          onClose={() => setEditingSupplier(null)}
          footer={
            <FormActions
              form="supplier-edit-form"
              onCancel={() => setEditingSupplier(null)}
              cancelLabel={tc('cancel')}
              submitLabel={tc('save')}
              busy={updateMutation.isPending}
            />
          }
        >
          <ValidatedForm id="supplier-edit-form" onSubmit={handleUpdate} className="space-y-4">
            <ENTITY_FORMS.supplier.Fields record={editingSupplier} />
          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── Delete ────────────────────────────────────────────────── */}
      {deletingSupplier && (
        <Dialog
          title={t('delete')}
          onClose={() => setDeletingSupplier(null)}
          footer={
            <>
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
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-600">{t('confirmDelete')}</p>
            <p className="text-sm font-medium text-gray-900">{deletingSupplier.name}</p>
            {orderCount(deletingSupplier) > 0 && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {t('deleteBlocked')}
              </p>
            )}
          </div>
        </Dialog>
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
        <span key={value} className="inline-flex min-w-0 max-w-full items-center gap-1" title={value}>
          <Icon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          {/* Phone numbers and handles read left to right in Arabic too (UI #15);
              one too long for the column is cut, whole on hover. */}
          <span dir="ltr" className="truncate">{value}</span>
        </span>
      ))}
    </span>
  );
}
