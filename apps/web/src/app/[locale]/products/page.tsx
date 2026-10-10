'use client';
import { NoMatch } from '@/components/ui/no-match';
import { Select } from '../../../components/ui/select';
import { ProductLink } from '../../../components/ui/entity-link';
import { Money } from '../../../components/ui/money';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useToast } from '../../../components/ui/toast';
import { useState, useMemo, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import {
  Plus, Search, Edit, Eye, Tag,
  X, Loader2,
} from 'lucide-react';

import { useApiError } from '../../../lib/api-error';
import { ENTITY_FORMS } from '../../../components/entities/entity-forms';
import { ValidatedForm } from '@/components/ui/validated-form';
import { EmptyState } from '@/components/ui/empty-state';
import { useCan } from '@/lib/can';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';
// ─── Types ────────────────────────────────────────────────────────────
interface ProductRaw {
  id: string;
  sku: string;
  name: string;
  category?: any;
  categoryId?: string;
  description?: string;
  barcode?: string;
  minStock?: number | string;
  status?: string;
  prices?: any[];
}

interface Product {
  id: string;
  sku: string;
  name: string;
  categoryName: string;
  categoryId?: string;
  description?: string;
  barcode?: string;
  minStock: number;
  isActive: boolean;
  b2bPrice?: number;
  b2cPrice?: number;
}

// ─── Status badge ─────────────────────────────────────────────────────
// Product.status has no `codes` family, so the words come from `products`.
function StatusBadge({ active }: { active: boolean }) {
  const t = useTranslations('products');
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap px-2.5 py-0.5 rounded-full text-xs font-medium ${
        active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
      }`}
    >
      {active ? t('active') : t('inactive')}
    </span>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function ProductsPage() {
  const apiError = useApiError();
  const t = useTranslations('products');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Reading products is everyone's; adding and changing them is a partner's (R1c).
  const may = { create: useCan('product.create'), edit: useCan('product.edit') };
  const router = useRouter();
  const { locale } = useParams();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  // The chosen category used to be held here, once per modal, and cleared on
  // every open and close path so the next product did not inherit the last
  // one's. The shared form owns it now: each modal mounts a fresh copy seeded
  // from the record being edited, so there is no state left to leak.
  const openCreate = () => setShowCreateModal(true);
  const closeCreate = () => setShowCreateModal(false);
  const openEditProduct = (product: Product) => setEditingProduct(product);
  const closeEditProduct = () => setEditingProduct(null);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, categoryFilter]);

  // ── Queries ───────────────────────────────────────────────────────
  const { items: products, capped, isLoading } = useAllRecords(['products'], '/products');

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data.data ?? r.data),
  });

  // ── Mutations ─────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: Partial<Product>) => api.post('/products', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      closeCreate();
      toast(t('createSuccess'), 'success');
    },
    onError: (error: any) => {
      toast(apiError(error, t('createFailed')), 'error');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<Product> & { id: string }) =>
      api.put(`/products/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      closeEditProduct();
      toast(t('updateSuccess'), 'success');
    },
    onError: (error: any) => {
      toast(apiError(error, t('updateFailed')), 'error');
    },
  });

  // ── Transform raw API data ─────────────────────────────────────────
  const mapProduct = (raw: ProductRaw): Product => ({
    id: raw.id,
    sku: raw.sku,
    name: raw.name,
    categoryName: typeof raw.category === 'object' ? raw.category?.name ?? '' : raw.category ?? '',
    categoryId: raw.categoryId,
    description: raw.description,
    barcode: raw.barcode,
    minStock: Number(raw.minStock ?? 0),
    isActive: raw.status === 'ACTIVE',
    b2bPrice: raw.prices?.find((p: any) => p.channel === 'B2B' && !p.effectiveTo)?.amount
      ? Number(raw.prices.find((p: any) => p.channel === 'B2B' && !p.effectiveTo).amount)
      : undefined,
    b2cPrice: raw.prices?.find((p: any) => p.channel === 'B2C' && !p.effectiveTo)?.amount
      ? Number(raw.prices.find((p: any) => p.channel === 'B2C' && !p.effectiveTo).amount)
      : undefined,
  });

  // ── Derived data ──────────────────────────────────────────────────
  const productList: Product[] = Array.isArray(products) ? products.map(mapProduct) : [];
  const categoryList: { id: string; name: string }[] = Array.isArray(categories)
    ? categories.map((c: any) => ({ id: c.id, name: c.name ?? c.label ?? '' }))
    : [];

  const filtered = productList.filter((p) => {
    const matchSearch =
      !search ||
      p.name?.toLowerCase().includes(search.toLowerCase()) ||
      p.sku?.toLowerCase().includes(search.toLowerCase());
    const matchCat = !categoryFilter || p.categoryName === categoryFilter;
    return matchSearch && matchCat;
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  // Nothing at all says what goes here and offers the first one; nothing for
  // this search or filter says only that (UX #12).
  const emptyList =
    productList.length === 0 ? (
      <EmptyState
        title={t('emptyTitle')}
        description={t('emptyHint')}
        action={may.create ? { label: t('create'), onClick: openCreate } : undefined}
      />
    ) : (
      <NoMatch filtered={!!categoryFilter} onClear={() => { setSearch(''); setCategoryFilter(''); }} />
    );

  // ── Handlers ──────────────────────────────────────────────────────
  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createMutation.mutate(ENTITY_FORMS.product.toPayload(fd) as any);
  };

  const handleUpdate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingProduct) return;
    const fd = new FormData(e.currentTarget);
    updateMutation.mutate({
      id: editingProduct.id,
      name: fd.get('name') as string,
      categoryId: fd.get('category') as string || undefined,
      description: fd.get('description') as string,
      barcode: fd.get('barcode') as string,
      minStock: Number(fd.get('minStock') || 0),
    });
  };

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
          onClick={() => openCreate()}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
        </button>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
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
            id="category-filter"
            className="w-full sm:w-56"
            value={categoryFilter}
            onChange={setCategoryFilter}
            clearable
            placeholder={`${t('category')} (${tc('filter')})`}
            searchPlaceholder={t('category')}
            options={categoryList.map((cat) => ({ value: cat.name, label: cat.name }))}
          />
        </div>
      </div>

      <ListCapNotice capped={capped} count={products.length} />

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          {tc('loading')}
        </div>
      )}

      {/* Desktop Table */}
      {!isLoading && (
        <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('sku')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('name')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('category')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('b2bPrice')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('b2cPrice')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('minStock')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('status')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={8}>{emptyList}</td></tr>
                ) : (
                  paginated.map((product) => (
                    <tr key={product.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-500 whitespace-nowrap">{product.sku}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        <ProductLink id={product.id} name={product.name} />
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        <span className="inline-flex items-center gap-1 whitespace-nowrap bg-gray-100 rounded-full px-2.5 py-0.5 text-xs">
                          <Tag className="h-3 w-3" />
                          {product.categoryName || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap tabular-nums">
                        {product.b2bPrice != null ? <Money value={product.b2bPrice} /> : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap tabular-nums">
                        {product.b2cPrice != null ? <Money value={product.b2cPrice} /> : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700 whitespace-nowrap tabular-nums">
                        {product.minStock}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge active={product.isActive} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => router.push(`/${locale}/products/${product.id}`)}
                            className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                            title={tc('view')}
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          {may.edit && (
                          <button
                            type="button"
                            data-testid="edit-action"
                            onClick={() => openEditProduct(product)}
                            className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors cursor-pointer"
                            title={tc('edit')}
                          >
                            <Edit className="h-4 w-4" />
                          </button>
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
            <div className="bg-white rounded-xl border border-gray-200">{emptyList}</div>
          ) : (
            paginated.map((product) => (
              <div
                key={product.id}
                className="bg-white rounded-xl border border-gray-200 p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">
                      <ProductLink id={product.id} name={product.name} />
                    </p>
                    <p className="text-xs text-gray-500 font-mono">{product.sku}</p>
                  </div>
                  <StatusBadge active={product.isActive} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 bg-gray-100 rounded-full px-2 py-0.5 text-xs text-gray-600">
                    <Tag className="h-3 w-3" />
                    {product.categoryName || '—'}
                  </span>
                </div>
                {/* Label above value, one column each, so the two prices never run together (UI #36). */}
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div className="min-w-0">
                    <dt className="text-xs text-gray-500">{t('b2bPrice')}</dt>
                    <dd className="font-medium tabular-nums">{product.b2bPrice != null ? <Money value={product.b2bPrice} /> : '—'}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-gray-500">{t('b2cPrice')}</dt>
                    <dd className="font-medium tabular-nums">{product.b2cPrice != null ? <Money value={product.b2cPrice} /> : '—'}</dd>
                  </div>
                </dl>
                <div className="flex items-center justify-end gap-2 pt-1 border-t border-gray-100">
                  <button
                    onClick={() => router.push(`/${locale}/products/${product.id}`)}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-primary-600 px-2 py-1 rounded"
                  >
                    <Eye className="h-3.5 w-3.5" /> {tc('view')}
                  </button>
                  {may.edit && (
                  <button
                    type="button"
                    data-testid="edit-action"
                    onClick={() => openEditProduct(product)}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-amber-600 px-2 py-1 rounded cursor-pointer"
                  >
                    <Edit className="h-3.5 w-3.5" /> {tc('edit')}
                  </button>
                  )}
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
        <Modal title={t('create')} onClose={() => closeCreate()}>
          <ValidatedForm onSubmit={handleCreate} className="space-y-4">
            <ENTITY_FORMS.product.Fields />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => closeCreate()} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
                {tc('cancel')}
              </button>
              <button type="submit" disabled={createMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('create')}
              </button>
            </div>
          </ValidatedForm>
        </Modal>
      )}

      {/* ─── Edit Modal ────────────────────────────────────────────── */}
      {editingProduct && (
        <Modal title={t('edit')} onClose={() => closeEditProduct()}>
          <ValidatedForm onSubmit={handleUpdate} className="space-y-4">
            <ENTITY_FORMS.product.Fields record={editingProduct} />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => closeEditProduct()} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
                {tc('cancel')}
              </button>
              <button type="submit" disabled={updateMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('save')}
              </button>
            </div>
          </ValidatedForm>
        </Modal>
      )}

    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────
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


