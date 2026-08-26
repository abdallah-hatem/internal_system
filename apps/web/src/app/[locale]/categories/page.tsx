'use client';
import { Select } from '../../../components/ui/select';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useToast } from '../../../components/ui/toast';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import {
  Tag, Plus, Search, Edit, X, Loader2, Trash2, ChevronRight, ChevronDown, FolderTree,
} from 'lucide-react';

import { useApiError } from '../../../lib/api-error';
import { ENTITY_FORMS } from '../../../components/entities/entity-forms';
import { InputField } from '../../../components/ui/fields';
// ─── Types ────────────────────────────────────────────────────────────
interface Category {
  id: string;
  name: string;
  parentId: string | null;
  parent?: { id: string; name: string } | null;
  children?: Category[];
  _count?: { products: number; children: number };
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Build a tree from a flat list of categories */
function buildTree(categories: Category[]): Category[] {
  const map = new Map<string, Category>();
  const roots: Category[] = [];
  for (const cat of categories) {
    map.set(cat.id, { ...cat, children: [] });
  }
  for (const cat of categories) {
    const node = map.get(cat.id)!;
    if (cat.parentId && map.has(cat.parentId)) {
      map.get(cat.parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** Flatten tree for search filtering, preserving hierarchy info */
function flattenTree(nodes: Category[], depth = 0): (Category & { depth: number; path: string })[] {
  const result: (Category & { depth: number; path: string })[] = [];
  for (const node of nodes) {
    result.push({ ...node, depth, path: node.name });
    if (node.children && node.children.length > 0) {
      result.push(...flattenTree(node.children, depth + 1));
    }
  }
  return result;
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function CategoriesPage() {
  const apiError = useApiError();
  const t = useTranslations('categories');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => { setPage(1); }, [search]);

  // ── Queries ───────────────────────────────────────────────────────
  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data.data ?? r.data),
  });

  // ── Mutations ─────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: any) => api.post('/categories', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      setShowCreateModal(false);
      addToast(t('createSuccess'), 'success');
    },
    onError: (error: any) => {
      addToast(apiError(error, 'Failed to create category'), 'error');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: any) => api.put(`/categories/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      setEditingCategory(null);
      addToast(t('updateSuccess'), 'success');
    },
    onError: (error: any) => {
      addToast(apiError(error, 'Failed to update category'), 'error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/categories/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      setDeletingCategory(null);
      addToast(t('deleteSuccess'), 'success');
    },
    onError: (error: any) => {
      addToast(apiError(error, 'Failed to delete category'), 'error');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const categoryList: Category[] = Array.isArray(categories) ? categories : [];
  const tree = useMemo(() => buildTree(categoryList), [categoryList]);

  // For search: filter flat list, then rebuild tree from matching IDs
  const filteredTree = useMemo(() => {
    if (!search) return tree;
    const q = search.toLowerCase();
    const flat = flattenTree(tree);
    const matchingIds = new Set(
      flat.filter((c) => c.name.toLowerCase().includes(q)).map((c) => c.id),
    );
    // Also include parent IDs of matching categories
    const allIds = new Set<string>();
    for (const cat of categoryList) {
      if (matchingIds.has(cat.id)) {
        let current: Category | undefined = cat;
        while (current) {
          allIds.add(current.id);
          current = categoryList.find((c) => c.id === current!.parentId);
        }
      }
    }
    return buildTree(categoryList.filter((c) => allIds.has(c.id)));
  }, [tree, search, categoryList]);

  const flatFiltered = useMemo(() => flattenTree(filteredTree), [filteredTree]);
  const totalPages = Math.ceil(flatFiltered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(flatFiltered, page), [flatFiltered, page]);

  // ── Handlers ──────────────────────────────────────────────────────
  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createMutation.mutate(ENTITY_FORMS.category.toPayload(fd));
  };

  const handleUpdate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingCategory) return;
    const fd = new FormData(e.currentTarget);
    updateMutation.mutate({
      id: editingCategory.id,
      name: fd.get('name'),
      parentId: fd.get('parentId') || null,
    });
  };

  const toggleExpandAll = () => {
    if (expandedIds.size === flatFiltered.length) {
      setExpandedIds(new Set());
    } else {
      setExpandedIds(new Set(flatFiltered.map((c) => c.id)));
    }
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

      {/* Search + Expand All */}
      <div className="flex items-center gap-3 max-w-md">
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
        {flatFiltered.length > 0 && (
          <button
            onClick={toggleExpandAll}
            className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg border border-gray-200 transition-colors whitespace-nowrap"
          >
            {expandedIds.size === flatFiltered.length ? t('collapseAll') : t('expandAll')}
          </button>
        )}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin me-2" /> {tc('loading')}
        </div>
      )}

      {/* Category Tree */}
      {!isLoading && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {flatFiltered.length === 0 ? (
            <div className="px-4 py-12 text-center text-gray-400">
              <FolderTree className="h-10 w-10 mx-auto mb-3 text-gray-300" />
              {t('noData')}
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {paginated.map((cat) => (
                <div
                  key={cat.id}
                  className="flex items-center gap-2 px-4 py-3 hover:bg-gray-50 transition-colors"
                  style={{ paddingLeft: `${16 + cat.depth * 24}px` }}
                >
                  {/* Expand/collapse toggle */}
                  {cat._count && cat._count.children > 0 ? (
                    <button
                      onClick={() => toggleExpand(cat.id)}
                      className="p-0.5 text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      {expandedIds.has(cat.id) ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </button>
                  ) : (
                    <span className="w-5" />
                  )}

                  {/* Icon + Name */}
                  <Tag className="h-4 w-4 text-gray-400 shrink-0" />
                  <span className="text-sm font-medium text-gray-900 truncate">{cat.name}</span>

                  {/* Parent badge */}
                  {cat.parent && (
                    <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                      {cat.parent.name}
                    </span>
                  )}

                  {/* Product count */}
                  {cat._count && cat._count.products > 0 && (
                    <span className="text-xs text-primary-600 bg-primary-50 px-2 py-0.5 rounded-full">
                      {cat._count.products} {cat._count.products === 1 ? 'product' : 'products'}
                    </span>
                  )}

                  {/* Spacer + Actions */}
                  <div className="ms-auto flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setEditingCategory(cat)}
                      className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                      title={tc('edit')}
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeletingCategory(cat)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title={tc('delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pagination */}
      {!isLoading && flatFiltered.length > 0 && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} totalItems={flatFiltered.length} />
      )}

      {/* ─── Create Modal ──────────────────────────────────────────── */}
      {showCreateModal && (
        <Modal title={t('create')} onClose={() => setShowCreateModal(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <ENTITY_FORMS.category.Fields />
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
      {editingCategory && (
        <Modal title={t('edit')} onClose={() => setEditingCategory(null)}>
          <form onSubmit={handleUpdate} className="space-y-4">
            <InputField label={t('name')} name="name" defaultValue={editingCategory.name} required />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('parentCategory')} <span className="text-gray-400 ms-1 text-xs font-normal">(Optional)</span>
              </label>
              <Select
                name="parentId"
                defaultValue={editingCategory.parentId || ''}
                placeholder={t('noParent')}
                searchPlaceholder={tc('search')}
                clearable
                options={categoryList.filter((c) => !c.parentId).map((c) => ({
                  value: c.id,
                  label: c.name,
                }))}
              />
            </div>
            {editingCategory._count && (editingCategory._count.products > 0 || editingCategory._count.children > 0) && (
              <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {editingCategory._count.products > 0 && (
                  <p>{editingCategory._count.products} product(s) assigned to this category.</p>
                )}
                {editingCategory._count.children > 0 && (
                  <p>{editingCategory._count.children} subcategor{editingCategory._count.children === 1 ? 'y' : 'ies'} under this category.</p>
                )}
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setEditingCategory(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" disabled={updateMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('save')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── Delete Confirmation Modal ─────────────────────────────── */}
      {deletingCategory && (
        <Modal title={t('delete')} onClose={() => setDeletingCategory(null)}>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">{t('confirmDelete')}</p>
            <p className="text-sm font-medium text-gray-900">{deletingCategory.name}</p>
            {deletingCategory._count && (deletingCategory._count.products > 0 || deletingCategory._count.children > 0) && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {deletingCategory._count.products > 0 && (
                  <p>This category has {deletingCategory._count.products} product(s) assigned.</p>
                )}
                {deletingCategory._count.children > 0 && (
                  <p>This category has {deletingCategory._count.children} subcategor{deletingCategory._count.children === 1 ? 'y' : 'ies'}.</p>
                )}
                <p className="mt-1 font-medium">You must reassign or remove them first.</p>
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setDeletingCategory(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button
                onClick={() => deleteMutation.mutate(deletingCategory.id)}
                disabled={deleteMutation.isPending || (deletingCategory._count ? (deletingCategory._count.products > 0 || deletingCategory._count.children > 0) : false)}
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

