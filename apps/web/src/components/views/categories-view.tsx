'use client';
import { NoMatch } from '@/components/ui/no-match';
import { LatinText } from '@/components/ui/latin-text';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '@/components/ui/pagination';
import {
  Tag, Plus, Edit, Loader2, Trash2, ChevronRight, ChevronDown,
} from '@/components/ui/icons';

import { useApiError } from '@/lib/api-error';
import { ENTITY_FORMS } from '@/components/entities/entity-forms';
import { ValidatedForm } from '@/components/ui/validated-form';
import { EmptyState } from '@/components/ui/empty-state';
import { useCan } from '@/lib/can';
import { categoryIndent } from './indent';
import { localName, matchesName, otherName } from '@/lib/localized-name';
import { useLocale } from 'next-intl';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { Dialog } from '@/components/ui/dialog';
import { ListToolbar } from '@/components/ui/list-toolbar';
// ─── Types ────────────────────────────────────────────────────────────
interface Category {
  id: string;
  name: string;
  nameAr?: string | null;
  parentId: string | null;
  parent?: { id: string; name: string; nameAr?: string | null } | null;
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

// ─── Skeletons ────────────────────────────────────────────────────────
// The category row below, traced: the same indent for its depth, the 20px
// toggle slot, the tag icon, the name, a badge, and the 28px icon buttons that
// set the row's height when the reader may edit. Change one, change the other.
/** A tree's shape while it loads: top-level rows with a child or two under some. */
const SKELETON_DEPTHS = [0, 1, 1, 0, 1, 0, 0, 1, 2, 0];

function CategoryRowSkeleton({ depth, actions }: { depth: number; actions: number }) {
  return (
    <div
      data-testid="skeleton-row"
      className="flex items-center gap-2 px-4 py-3"
      style={categoryIndent(depth)}
    >
      <Skeleton className="size-5 shrink-0 rounded" />
      <Skeleton className="size-4 shrink-0 rounded" />
      <SkeletonText className={depth === 0 ? 'w-32' : 'w-24'} />
      {depth > 0 && <Skeleton className="h-5 w-16 shrink-0 rounded-full" />}
      {actions > 0 && (
        <div className="ms-auto flex items-center gap-1 shrink-0">
          {repeat(actions, (i) => <Skeleton key={i} className="size-7 rounded-lg" />)}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function CategoriesPage() {
  const apiError = useApiError();
  const t = useTranslations('categories');
  const tc = useTranslations('common');
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  // Reading categories is everyone's; changing them is a partner's (R1c).
  const may = {
    create: useCan('category.create'),
    edit: useCan('category.edit'),
    delete: useCan('category.delete'),
  };
  const mayRow = may.edit || may.delete;

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);
  // Parents whose subcategories are hidden. Empty means everything shows,
  // which is how the page opens. The arrows once only turned while every row
  // stayed on screen (owner, 2026-10-15).
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

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
      addToast(apiError(error, t('createFailed')), 'error');
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
      addToast(apiError(error, t('updateFailed')), 'error');
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
      addToast(apiError(error, t('deleteFailed')), 'error');
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
      // Either language (§3, 2026-10-14).
      flat.filter((c) => matchesName(c, q)).map((c) => c.id),
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
  const parentIds = useMemo(
    () => flatFiltered.filter((c) => (c.children?.length ?? 0) > 0).map((c) => c.id),
    [flatFiltered],
  );
  // A row shows when no ancestor is collapsed. A search shows every match and
  // the path to it, whatever was collapsed before.
  const visible = useMemo(() => {
    if (search || collapsedIds.size === 0) return flatFiltered;
    const parentOf = new Map(flatFiltered.map((c) => [c.id, c.parentId]));
    return flatFiltered.filter((c) => {
      for (let up = c.parentId; up; up = parentOf.get(up) ?? null) {
        if (collapsedIds.has(up)) return false;
      }
      return true;
    });
  }, [flatFiltered, collapsedIds, search]);
  const totalPages = Math.ceil(visible.length / PAGE_SIZE);
  // Collapsing can leave the page past the end of a shorter list.
  const shownPage = Math.min(page, Math.max(1, totalPages));
  const paginated = useMemo(() => paginate(visible, shownPage), [visible, shownPage]);
  const isOpen = (id: string) => !!search || !collapsedIds.has(id);
  const allOpen = !!search || parentIds.every((id) => !collapsedIds.has(id));

  // Nothing at all says what goes here and offers the first one; nothing for
  // this search or filter says only that (UX #12).
  const emptyList =
    categoryList.length === 0 ? (
      <EmptyState
        title={t('emptyTitle')}
        description={t('emptyHint')}
        action={may.create ? { label: t('create'), onClick: () => setShowCreateModal(true) } : undefined}
      />
    ) : (
      <NoMatch onClear={() => setSearch('')} />
    );

  // ── Handlers ──────────────────────────────────────────────────────
  const toggleExpand = (id: string) => {
    setCollapsedIds((prev) => {
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
      ...ENTITY_FORMS.category.toPayload(fd),
      id: editingCategory.id,
      // Cleared means "no parent" on an edit, not "leave it".
      parentId: fd.get('parentId') || null,
    });
  };

  const toggleExpandAll = () => {
    setCollapsedIds(allOpen ? new Set(parentIds) : new Set());
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
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
        </button>
        )}
      </div>

      {/* Search + Expand All */}
      <ListToolbar search={{ value: search, onChange: setSearch, placeholder: t('search') }}>
        {parentIds.length > 0 && !search && (
          <button
            type="button"
            data-testid="toggle-all"
            onClick={toggleExpandAll}
            className="self-start whitespace-nowrap rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted sm:self-auto"
          >
            {allOpen ? t('collapseAll') : t('expandAll')}
          </button>
        )}
      </ListToolbar>

      {/* Loading: the tree's own card over skeleton rows. */}
      {isLoading && (
        <>
          <LoadingStatus />
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <SkeletonGroup className="divide-y divide-muted">
              {SKELETON_DEPTHS.slice(0, PAGE_SIZE).map((depth, i) => (
                <CategoryRowSkeleton key={i} depth={depth} actions={(may.edit ? 1 : 0) + (may.delete ? 1 : 0)} />
              ))}
            </SkeletonGroup>
          </div>
        </>
      )}

      {/* Category Tree */}
      {!isLoading && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {flatFiltered.length === 0 ? (
            emptyList
          ) : (
            <div className="divide-y divide-gray-100">
              {paginated.map((cat) => (
                <div
                  key={cat.id}
                  data-testid="category-row"
                  className="flex items-center gap-2 px-4 py-3 hover:bg-gray-50 transition-colors"
                  style={categoryIndent(cat.depth)}
                >
                  {/* Expand/collapse toggle, from the tree so it follows the rows shown. */}
                  {(cat.children?.length ?? 0) > 0 ? (
                    <button
                      type="button"
                      data-testid="toggle-children"
                      aria-expanded={isOpen(cat.id)}
                      aria-label={isOpen(cat.id) ? t('collapse') : t('expand')}
                      onClick={() => toggleExpand(cat.id)}
                      className="p-0.5 text-gray-400 hover:text-gray-600 transition-colors cursor-pointer shrink-0"
                    >
                      {isOpen(cat.id) ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4 rtl:rotate-180" />
                      )}
                    </button>
                  ) : (
                    <span className="w-5 shrink-0" />
                  )}

                  {/* Icon + Name */}
                  <Tag className="h-4 w-4 text-gray-400 shrink-0" />
                  <LatinText truncate className="flex-initial text-sm font-medium text-gray-900">{localName(cat, locale)}</LatinText>
                  {/* The name in the other language, so a partner on /en
                      can see the Arabic was entered, and the reverse. */}
                  {otherName(cat, locale) && (
                    <bdi className="min-w-0 truncate text-xs text-gray-400" data-testid="category-other-name">
                      {otherName(cat, locale)}
                    </bdi>
                  )}

                  {/* Parent badge */}
                  {cat.parent && (
                    <span className="shrink-0 whitespace-nowrap text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                      <bdi>{localName(cat.parent, locale)}</bdi>
                    </span>
                  )}

                  {/* Product count */}
                  {cat._count && cat._count.products > 0 && (
                    <span className="shrink-0 whitespace-nowrap text-xs text-primary-600 bg-primary-50 px-2 py-0.5 rounded-full">
                      {t('productCount', { count: cat._count.products })}
                    </span>
                  )}

                  {/* Spacer + Actions */}
                  {mayRow && (
                  <div className="ms-auto flex items-center gap-1 shrink-0">
                    {may.edit && (
                    <button
                      type="button"
                      data-testid="edit-action"
                      onClick={() => setEditingCategory(cat)}
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
                      onClick={() => setDeletingCategory(cat)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                      title={tc('delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    )}
                  </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pagination */}
      {!isLoading && flatFiltered.length > 0 && (
        <Pagination page={shownPage} totalPages={totalPages} onPageChange={setPage} totalItems={visible.length} />
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
                form="categories-1-form" disabled={createMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('create')}
              </button>
            </>
          }
        >
          <ValidatedForm id="categories-1-form" onSubmit={handleCreate} className="space-y-4">
            <ENTITY_FORMS.category.Fields />
          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── Edit Modal ────────────────────────────────────────────── */}
      {editingCategory && (
        <Dialog
          title={t('edit')}
          onClose={() => setEditingCategory(null)}
          footer={
            <>
              <button type="button" onClick={() => setEditingCategory(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit"
                form="categories-2-form" disabled={updateMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('save')}
              </button>
            </>
          }
        >
          <ValidatedForm id="categories-2-form" onSubmit={handleUpdate} className="space-y-4">
            {/* The same form the create modal and the `+` render (CLAUDE.md §13).
                This modal had its own copy with name and parent only, so the
                Arabic name would have been dropped on every edit. */}
            <ENTITY_FORMS.category.Fields record={editingCategory} />
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
          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── Delete Confirmation Modal ─────────────────────────────── */}
      {deletingCategory && (
        <Dialog
          title={t('delete')}
          onClose={() => setDeletingCategory(null)}
          footer={
            <>
              <button type="button" onClick={() => setDeletingCategory(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button
                onClick={() => deleteMutation.mutate(deletingCategory.id)}
                disabled={deleteMutation.isPending || (deletingCategory._count ? (deletingCategory._count.products > 0 || deletingCategory._count.children > 0) : false)}
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
            <p className="text-sm font-medium text-gray-900">{localName(deletingCategory, locale)}</p>
            {deletingCategory._count && (deletingCategory._count.products > 0 || deletingCategory._count.children > 0) && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {deletingCategory._count.products > 0 && (
                  <p>{t('deleteHasProducts', { count: deletingCategory._count.products })}</p>
                )}
                {deletingCategory._count.children > 0 && (
                  <p>{t('deleteHasChildren', { count: deletingCategory._count.children })}</p>
                )}
                <p className="mt-1 font-medium">{t('deleteReassignFirst')}</p>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
