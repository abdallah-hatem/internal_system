'use client';
import { NoMatch } from '@/components/ui/no-match';
import { Select } from '@/components/ui/select';
import { ProductLink } from '@/components/ui/entity-link';
import { Money } from '@/components/ui/money';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { useState, useMemo, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Pagination, paginate, PAGE_SIZE } from '@/components/ui/pagination';
import {
  Plus, Edit, Eye, Tag,
} from 'lucide-react';

import { useApiError } from '@/lib/api-error';
import { ENTITY_FORMS } from '@/components/entities/entity-forms';
import { ValidatedForm } from '@/components/ui/validated-form';
import { Dialog } from '@/components/ui/dialog';
import { FormActions } from '@/components/ui/fields';
import { EmptyState } from '@/components/ui/empty-state';
import { useCan } from '@/lib/can';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';
import { ProductStatusAction } from '@/components/products/product-status-action';
import { localName, matchesName } from '@/lib/localized-name';
import { namedOption } from '@/components/entities/entity-forms';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/ui/data-table';
import { useNumberFormat } from '@/lib/numbers';
import { FilterPills, ListToolbar } from '@/components/ui/list-toolbar';
import { listPriceOf, type ListPrice, type ListPrices } from '@/lib/list-price';
import { DefaultPriceHint } from '@/components/products/default-price-hint';

/** The status filter: Active by default (§3, 2026-10-14). */
const STATUS_FILTERS = ['ACTIVE', 'INACTIVE', 'ALL'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
// ─── Types ────────────────────────────────────────────────────────────
interface ProductRaw {
  id: string;
  sku: string;
  name: string;
  nameAr?: string | null;
  descriptionAr?: string | null;
  category?: any;
  categoryId?: string;
  description?: string;
  barcode?: string;
  minStock?: number | string;
  /** Units in stock across its batches (office only; absent for an investor). */
  onHand?: number;
  status?: string;
  prices?: any[];
  /** Each channel's price, set or the default (§3, 2026-10-18). */
  listPrices?: ListPrices | null;
}

interface Product {
  id: string;
  sku: string;
  /** The English name, as stored — what the edit form must be seeded with. */
  name: string;
  nameAr?: string | null;
  /** What this reader is shown (§3, 2026-10-14). */
  displayName: string;
  descriptionAr?: string | null;
  categoryName: string;
  /** The category's name for this reader. */
  categoryLabel: string;
  categoryId?: string;
  description?: string;
  barcode?: string;
  minStock: number;
  /** Null when the list was not sent stock (an investor's view). */
  onHand: number | null;
  status?: string;
  isActive: boolean;
  /** Set, or the default landed + markup; null when there is neither. */
  b2bPrice: ListPrice | null;
  b2cPrice: ListPrice | null;
}

// ─── Price cell ───────────────────────────────────────────────────────

/** A channel's price, with "Default (landed + 20%)" under one nobody set. */
function PriceCell({ price }: { price: ListPrice | null }) {
  if (!price) return <>—</>;
  return (
    <span>
      <Money value={Number(price.amount)} currency={price.currency} />
      {/* Wraps rather than runs past the column: a price column is sized for
          "123,456.00 EGP", and "Default (landed + 20%)" is wider in both
          languages (TC-COL-03). */}
      <DefaultPriceHint price={price} className="block whitespace-normal text-[11px] font-normal leading-tight text-muted-foreground" />
    </span>
  );
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

// ─── Skeletons ────────────────────────────────────────────────────────
// The table's skeleton rows are drawn by DataTable from each column's
// `skeleton`; the phone card below is traced by hand. Change one, change the other.

function ProductCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <SkeletonText size="base" className="w-2/3" />
          <SkeletonText size="xs" className="w-20" />
        </div>
        <Skeleton className="h-5 w-14 rounded-full" />
      </div>
      <Skeleton className="h-5 w-24 rounded-full" />
      <div className="grid grid-cols-2 gap-3">
        {repeat(2, (i) => (
          <div key={i}>
            <SkeletonText size="xs" className="w-16" />
            <SkeletonText className="w-20" />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 pt-1 border-t border-muted">
        {repeat(3, (i) => <Skeleton key={i} className="h-6 w-14 rounded" />)}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function ProductsPage() {
  const apiError = useApiError();
  const t = useTranslations('products');
  const { formatNumber } = useNumberFormat();
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Reading products is everyone's; adding and changing them is a partner's (R1c).
  const may = { create: useCan('product.create'), edit: useCan('product.edit') };
  const router = useRouter();
  const { locale } = useParams();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ACTIVE');
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
  useEffect(() => { setPage(1); }, [search, categoryFilter, statusFilter]);

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
    nameAr: raw.nameAr ?? null,
    displayName: localName(raw, String(locale)),
    descriptionAr: raw.descriptionAr ?? null,
    categoryName: typeof raw.category === 'object' ? raw.category?.name ?? '' : raw.category ?? '',
    categoryLabel:
      typeof raw.category === 'object' ? localName(raw.category, String(locale)) : raw.category ?? '',
    categoryId: raw.categoryId,
    description: raw.description,
    barcode: raw.barcode,
    minStock: Number(raw.minStock ?? 0),
    onHand: raw.onHand == null ? null : Number(raw.onHand),
    status: raw.status,
    isActive: raw.status === 'ACTIVE',
    b2bPrice: listPriceOf(raw, 'B2B'),
    b2cPrice: listPriceOf(raw, 'B2C'),
  });

  // ── Derived data ──────────────────────────────────────────────────
  const productList: Product[] = Array.isArray(products) ? products.map(mapProduct) : [];
  const categoryList: { id: string; name: string; nameAr?: string | null }[] = Array.isArray(categories)
    ? categories.map((c: any) => ({ id: c.id, name: c.name ?? c.label ?? '', nameAr: c.nameAr ?? null }))
    : [];

  const filtered = productList.filter((p) => {
    // Either language, and the SKU (§3, 2026-10-14).
    const matchSearch = matchesName(p, search);
    const matchCat = !categoryFilter || p.categoryName === categoryFilter;
    // Anything not ACTIVE counts as inactive, as on the server.
    const matchStatus =
      statusFilter === 'ALL' || (statusFilter === 'ACTIVE' ? p.isActive : !p.isActive);
    return matchSearch && matchCat && matchStatus;
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
      <NoMatch
        filtered={!!categoryFilter || statusFilter !== 'ACTIVE'}
        onClear={() => { setSearch(''); setCategoryFilter(''); setStatusFilter('ACTIVE'); }}
      />
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
      // The Arabic fields come from the shared form's own mapping, so the edit
      // sends exactly what the form shows — an untouched Arabic name goes back
      // as it was, an emptied one goes back empty and is cleared.
      ...(ENTITY_FORMS.product.toPayload(fd) as Partial<Product>),
      id: editingProduct.id,
      name: fd.get('name') as string,
      categoryId: fd.get('category') as string || undefined,
      description: fd.get('description') as string,
      barcode: fd.get('barcode') as string,
      minStock: Number(fd.get('minStock') || 0),
    });
  };

  // ── Columns ───────────────────────────────────────────────────────
  // SKU, name, category, B2B, B2C, in stock, status, actions. Each fixed
  // column fits its title in English and Arabic; the prices fit
  // "123,456.00 EGP"; the name takes what is left.
  const columns: Column<Product>[] = [
    {
      key: 'sku', header: t('sku'), width: '7rem', kind: 'label', title: (p) => p.sku,
      className: 'font-mono text-xs text-gray-500', skeleton: { kind: 'text', size: 'xs', share: 'w-3/4' },
      cell: (p) => p.sku,
    },
    {
      key: 'name', header: t('name'), width: 'auto', kind: 'name', title: (p) => p.displayName,
      className: 'font-medium text-gray-900',
      cell: (p) => <ProductLink id={p.id} name={p.displayName} />,
    },
    {
      key: 'category', header: t('category'), width: '9rem', className: 'text-gray-600',
      skeleton: { kind: 'pill', share: 'w-3/4' },
      cell: (p) => (
        <span
          className="inline-flex max-w-full items-center gap-1 whitespace-nowrap bg-gray-100 rounded-full px-2.5 py-0.5 text-xs"
          title={p.categoryLabel || undefined}
        >
          <Tag className="h-3 w-3 shrink-0" />
          <span className="truncate">{p.categoryLabel || '—'}</span>
        </span>
      ),
    },
    {
      key: 'b2b', header: t('b2bPrice'), width: '9rem', kind: 'value', className: 'text-gray-700',
      skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (p) => <PriceCell price={p.b2bPrice} />,
    },
    {
      key: 'b2c', header: t('b2cPrice'), width: '9rem', kind: 'value', className: 'text-gray-700',
      skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (p) => <PriceCell price={p.b2cPrice} />,
    },
    {
      // In place of Min stock (owner, 2026-10-17): how many are on the shelf,
      // red at or under the product's minimum — the low-stock rule's own test.
      key: 'onHand', header: t('inStock'), width: '7rem', kind: 'value', skeleton: { kind: 'text', share: 'w-1/4' },
      cell: (p) =>
        p.onHand == null ? (
          '—'
        ) : (
          <span
            data-testid="product-on-hand"
            className={p.minStock > 0 && p.onHand <= p.minStock ? 'font-medium text-destructive' : 'text-foreground'}
          >
            {formatNumber(p.onHand, { maximumFractionDigits: 3 })}
          </span>
        ),
    },
    {
      key: 'status', header: t('status'), width: '6.5rem', skeleton: { kind: 'pill', share: 'w-3/4' },
      cell: (p) => <StatusBadge active={p.isActive} />,
    },
    {
      key: 'actions', header: tc('actions'), width: '8rem', skeleton: { kind: 'buttons', count: 3 },
      cell: (product) => (
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
          <ProductStatusAction product={product} look="icon" />
        </div>
      ),
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
          onClick={() => openCreate()}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
        </button>
        )}
      </div>

      {/* Search + Filters — the shared toolbar every list uses. */}
      <ListToolbar search={{ value: search, onChange: setSearch, placeholder: t('search') }}>
        <Select
          id="category-filter"
          className="w-full sm:w-56"
          value={categoryFilter}
          onChange={setCategoryFilter}
          clearable
          placeholder={tph('allCategories')}
          searchPlaceholder={tph('searchCategories')}
          // Filtered by the English name, which is unique; shown in the reader's.
          options={categoryList.map((cat) => ({ ...namedOption(cat, String(locale)), value: cat.name }))}
        />
        <FilterPills
          label={t('statusFilter')}
          testId="status-filter"
          value={statusFilter}
          onChange={setStatusFilter}
          options={STATUS_FILTERS.map((key) => ({
            value: key,
            label: key === 'ACTIVE' ? t('active') : key === 'INACTIVE' ? t('inactive') : t('filterAll'),
          }))}
        />
      </ListToolbar>

      <ListCapNotice capped={capped} count={products.length} />

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
          {repeat(PAGE_SIZE, (i) => <ProductCardSkeleton key={i} />)}
        </SkeletonGroup>
      )}
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
                      <ProductLink id={product.id} name={product.displayName} />
                    </p>
                    <p className="text-xs text-gray-500 font-mono">{product.sku}</p>
                  </div>
                  <StatusBadge active={product.isActive} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 bg-gray-100 rounded-full px-2 py-0.5 text-xs text-gray-600">
                    <Tag className="h-3 w-3" />
                    {product.categoryLabel || '—'}
                  </span>
                </div>
                {/* Label above value, one column each, so the two prices never run together (UI #36). */}
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div className="min-w-0">
                    <dt className="text-xs text-gray-500">{t('b2bPrice')}</dt>
                    <dd className="font-medium tabular-nums"><PriceCell price={product.b2bPrice} /></dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-gray-500">{t('b2cPrice')}</dt>
                    <dd className="font-medium tabular-nums"><PriceCell price={product.b2cPrice} /></dd>
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
                  <ProductStatusAction product={product} look="text" />
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
          onClose={() => closeCreate()}
          busy={createMutation.isPending}
          footer={
            <FormActions
              form="product-create-form"
              onCancel={() => closeCreate()}
              cancelLabel={tc('cancel')}
              submitLabel={tc('create')}
              busy={createMutation.isPending}
            />
          }
        >
          <ValidatedForm id="product-create-form" onSubmit={handleCreate} className="space-y-4">
            <ENTITY_FORMS.product.Fields />
          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── Edit Modal ────────────────────────────────────────────── */}
      {editingProduct && (
        <Dialog
          title={t('edit')}
          onClose={() => closeEditProduct()}
          busy={updateMutation.isPending}
          footer={
            <FormActions
              form="product-edit-form"
              onCancel={() => closeEditProduct()}
              cancelLabel={tc('cancel')}
              submitLabel={tc('save')}
              busy={updateMutation.isPending}
            />
          }
        >
          <ValidatedForm id="product-edit-form" onSubmit={handleUpdate} className="space-y-4">
            <ENTITY_FORMS.product.Fields record={editingProduct} />
          </ValidatedForm>
        </Dialog>
      )}

    </div>
  );
}
