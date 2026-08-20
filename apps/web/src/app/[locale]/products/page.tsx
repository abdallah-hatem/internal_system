'use client';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useToast } from '../../../components/ui/toast';
import { useState, useMemo, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import {
  Plus, Search, Edit, Eye, Tag,
  X, Filter, ChevronDown, Loader2,
} from 'lucide-react';

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
function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
        active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
      }`}
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function ProductsPage() {
  const t = useTranslations('products');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const router = useRouter();
  const { locale } = useParams();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, categoryFilter]);

  // ── Queries ───────────────────────────────────────────────────────
  const { data: products = [], isLoading } = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get('/products').then((r) => r.data.data ?? r.data),
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data.data ?? r.data),
  });

  // ── Mutations ─────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: Partial<Product>) => api.post('/products', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      setShowCreateModal(false);
      toast('Product created successfully', 'success');
    },
    onError: (error: any) => {
      toast(error?.response?.data?.message || error.message || 'Failed to create product', 'error');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<Product> & { id: string }) =>
      api.put(`/products/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      setEditingProduct(null);
      toast('Product updated successfully', 'success');
    },
    onError: (error: any) => {
      toast(error?.response?.data?.message || error.message || 'Failed to update product', 'error');
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

  // ── Handlers ──────────────────────────────────────────────────────
  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createMutation.mutate({
      name: fd.get('name') as string,
      categoryId: fd.get('category') as string || undefined,
      description: fd.get('description') as string,
      barcode: fd.get('barcode') as string,
      minStock: Number(fd.get('minStock') || 0),
    });
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
        <button
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
        </button>
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
          <div className="relative">
            <Filter className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="ps-10 pe-8 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 appearance-none"
            >
              <option value="">{t('category')} ({tc('filter')})</option>
              {categoryList.map((cat) => (
                <option key={cat.id} value={cat.name}>{cat.name}</option>
              ))}
            </select>
            <ChevronDown className="absolute end-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
          </div>
        </div>
      </div>

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
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                      {tc('noData')}
                    </td>
                  </tr>
                ) : (
                  paginated.map((product) => (
                    <tr key={product.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{product.sku}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">{product.name}</td>
                       <td className="px-4 py-3 text-gray-600">
                        <span className="inline-flex items-center gap-1 bg-gray-100 rounded-full px-2.5 py-0.5 text-xs">
                          <Tag className="h-3 w-3" />
                          {product.categoryName || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {product.b2bPrice != null ? `£ ${product.b2bPrice.toLocaleString()}` : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {product.b2cPrice != null ? `£ ${product.b2cPrice.toLocaleString()}` : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-700">
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
                          <button
                            onClick={() => setEditingProduct(product)}
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
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
              {tc('noData')}
            </div>
          ) : (
            paginated.map((product) => (
              <div
                key={product.id}
                className="bg-white rounded-xl border border-gray-200 p-4 space-y-3"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium text-gray-900">{product.name}</p>
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
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-gray-500">{t('b2bPrice')}:</span>{' '}
                    <span className="font-medium">{product.b2bPrice != null ? `£ ${product.b2bPrice.toLocaleString()}` : '—'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">{t('b2cPrice')}:</span>{' '}
                    <span className="font-medium">{product.b2cPrice != null ? `£ ${product.b2cPrice.toLocaleString()}` : '—'}</span>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 pt-1 border-t border-gray-100">
                  <button
                    onClick={() => router.push(`/${locale}/products/${product.id}`)}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-primary-600 px-2 py-1 rounded"
                  >
                    <Eye className="h-3.5 w-3.5" /> {tc('view')}
                  </button>
                  <button
                    onClick={() => setEditingProduct(product)}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-amber-600 px-2 py-1 rounded"
                  >
                    <Edit className="h-3.5 w-3.5" /> {tc('edit')}
                  </button>
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
            <InputField label={t('name')} name="name" required />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('category')}</label>
              <select name="category" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                <option value="">—</option>
                {categoryList.map((cat) => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            </div>
            <InputField label={t('description')} name="description" />
            <InputField label={t('barcode')} name="barcode" />
            <InputField label={t('minStock')} name="minStock" type="number" placeholder="0" />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
                {tc('cancel')}
              </button>
              <button type="submit" disabled={createMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('create')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── Edit Modal ────────────────────────────────────────────── */}
      {editingProduct && (
        <Modal title={t('edit')} onClose={() => setEditingProduct(null)}>
          <form onSubmit={handleUpdate} className="space-y-4">
            <InputField label={t('name')} name="name" defaultValue={editingProduct.name} required />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('category')}</label>
              <select name="category" defaultValue={editingProduct.categoryId} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                <option value="">—</option>
                {categoryList.map((cat) => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            </div>
            <InputField label={t('description')} name="description" defaultValue={editingProduct.description} />
            <InputField label={t('barcode')} name="barcode" defaultValue={editingProduct.barcode} />
            <InputField label={t('minStock')} name="minStock" type="number" defaultValue={String(editingProduct.minStock)} placeholder="0" />
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setEditingProduct(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
                {tc('cancel')}
              </button>
              <button type="submit" disabled={updateMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('save')}
              </button>
            </div>
          </form>
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

function InputField({
  label,
  name,
  type = 'text',
  defaultValue,
  required,
  placeholder,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {required ? <span className="text-red-500 ms-1">*</span> : <span className="text-gray-400 ms-1 text-xs font-normal">(Optional)</span>}
      </label>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
      />
    </div>
  );
}
