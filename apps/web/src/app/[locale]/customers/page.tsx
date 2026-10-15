'use client';
import { NoMatch } from '@/components/ui/no-match';
import { LatinText } from '@/components/ui/latin-text';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';
import { Money } from '../../../components/ui/money';
import { CustomerLink } from '../../../components/ui/entity-link';
import { Select } from '../../../components/ui/select';

import { useTranslations, useLocale } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useToast } from '../../../components/ui/toast';
import { Suspense, useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import { useDateFormat } from '../../../lib/dates';
import {
  Users, Plus, Search, Eye, Edit, Loader2,
  ChevronRight, Phone, Mail, DollarSign, ShoppingCart,
  ShieldAlert, ShieldCheck,
} from 'lucide-react';

import { useApiError } from '../../../lib/api-error';
import { ENTITY_FORMS } from '../../../components/entities/entity-forms';
import { InputField } from '../../../components/ui/fields';
import { sortByBalance } from '../../../components/dashboard/list-params';
import { useCodeLabel } from '@/lib/labels';
import { ValidatedForm } from '@/components/ui/validated-form';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, CellBadge, type Column } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
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

// ─── Skeletons ────────────────────────────────────────────────────────
// The table's skeleton rows are drawn by DataTable from each column's
// `skeleton`; the phone card below is traced by hand. Change one, change the other.

function CustomerCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <SkeletonText size="base" className="w-40" />
        <Skeleton className="h-5 w-12 rounded-full" />
      </div>
      <div className="flex items-center gap-4 mb-2">
        <SkeletonText className="w-28" />
        <SkeletonText className="w-32" />
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-muted">
        <SkeletonText className="w-36" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-[22px] w-[30px] rounded" />
          <Skeleton className="size-4 rounded" />
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
/**
 * Reads `?sort=balance` (the dashboard's Receivables tile) to put whoever owes
 * the most first. `useSearchParams` cannot be prerendered, so Next requires a
 * Suspense boundary or `next build` fails on this page.
 */
export default function CustomersPage() {
  return (
    <Suspense fallback={null}>
      <CustomersPageContent />
    </Suspense>
  );
}

function CustomersPageContent() {
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const apiError = useApiError();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('customers');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const td = useTranslations('dashboard');
  const ts = useTranslations('sales');
  const searchParams = useSearchParams();
  const byBalance = searchParams.get('sort') === 'balance';
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
  useEffect(() => { setPage(1); }, [search, verification, byBalance]);

  // ── Queries ───────────────────────────────────────────────────────
  // Changing the verification filter is a new query: keep the rows on screen
  // (dimmed) until it answers rather than dropping back to skeletons.
  const { items: customers, capped, isLoading, reloading } = useAllRecords(
    ['customers', verification],
    '/customers',
    verification ? { verification } : {},
    { keepPrevious: true },
  );

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
      toast(t('createSuccess'), 'success');
    },
    onError: (error: any) => {
      toast(apiError(error, t('createFailed')), 'error');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: any) => api.put(`/customers/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['customer'] });
      setEditingCustomer(null);
      toast(t('updateSuccess'), 'success');
    },
    onError: (error: any) => {
      toast(apiError(error, t('updateFailed')), 'error');
    },
  });

  const verifyMutation = useMutation({
    mutationFn: (id: string) => api.post(`/customers/${id}/verify`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      toast(t('verifySuccess'), 'success');
    },
    onError: (error: any) => {
      toast(apiError(error, t('verifyFailed')), 'error');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const customerList: Customer[] = Array.isArray(customers) ? customers : [];

  const matching = customerList.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.displayName?.toLowerCase().includes(q) ||
      c.phone?.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q)
    );
  });
  const filtered = byBalance ? sortByBalance(matching) : matching;

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  // Nothing at all says what goes here and offers the first one; nothing for
  // this search or filter says only that (UX #12).
  const emptyList =
    customerList.length === 0 ? (
      <EmptyState
        title={t('emptyTitle')}
        description={t('emptyHint')}
        action={{ label: t('create'), onClick: () => setShowCreateModal(true) }}
      />
    ) : (
      <NoMatch filtered={!!verification} onClear={() => { setSearch(''); setVerification(''); }} />
    );

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

  // ── Columns ───────────────────────────────────────────────────────
  // Name, type, phone, email, balance, actions (components/ui/data-table.tsx).
  // The phone fits "+971 50 123 4567", the balance "-123,456.00 EGP"; a long
  // email is cut with the whole of it on hover; the name takes what is left.
  const columns: Column<Customer>[] = [
    {
      key: 'name', header: t('name'), width: 'auto', title: (c) => c.displayName,
      className: 'font-medium text-gray-900',
      cell: (customer) => (
        // The name wraps to two lines and is cut after them; the badge keeps its line.
        <span className="flex items-center gap-2" title={customer.displayName}>
          <span className="min-w-0 line-clamp-2 break-words">
            <CustomerLink id={customer.id} name={customer.displayName} />
          </span>
          {customer.verificationStatus === 'UNVERIFIED' && (
            <span
              title={t('awaitingReviewHint')}
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700"
            >
              <ShieldAlert className="h-3 w-3" />
              {t('awaitingReview')}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'type', header: t('type'), width: '5.5rem', skeleton: { kind: 'pill', share: 'w-1/2' },
      cell: (customer) => (
        <CellBadge className={TYPE_COLORS[customer.type] ?? 'bg-gray-100 text-gray-600'}>
          {customer.type === 'B2B' ? t('b2b') : t('b2c')}
        </CellBadge>
      ),
    },
    {
      key: 'phone', header: t('phone'), width: '10rem', className: 'text-gray-600', skeleton: { kind: 'text', share: 'w-3/4' },
      cell: (customer) => (
        <span className="flex items-center gap-1">
          <Phone className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          {customer.phone ? <LatinText dir="ltr" truncate>{customer.phone}</LatinText> : '—'}
        </span>
      ),
    },
    {
      key: 'email', header: t('email'), width: '13rem', className: 'text-gray-600', skeleton: { kind: 'text', share: 'w-3/4' },
      cell: (customer) => (
        <span className="flex items-center gap-1">
          <Mail className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          {customer.email ? <LatinText truncate>{customer.email}</LatinText> : '—'}
        </span>
      ),
    },
    {
      key: 'balance', header: t('balance'), width: '9rem', kind: 'value', skeleton: { kind: 'text', share: 'w-2/3' },
      headerProps: { 'aria-sort': byBalance ? 'descending' : undefined },
      cell: (customer) => (
        <Money
          value={customer.outstandingBalance ?? 0}
          currency={customer.currency ?? 'EGP'}
          className={`font-medium ${customer.outstandingBalance > 0 ? 'text-red-600' : 'text-green-600'}`}
        />
      ),
    },
    {
      key: 'actions', header: tc('actions'), width: '8rem', skeleton: { kind: 'buttons', count: 2 },
      cell: (customer) => (
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
      ),
    },
  ];

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

      {byBalance && (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="balance-sort-chip">
          <span className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 font-medium text-primary">
            {td('sortedByBalance')}
          </span>
          <button
            type="button"
            onClick={() => router.replace(`/${locale}/customers`, { scroll: false })}
            className="min-h-11 cursor-pointer px-2 text-primary hover:underline sm:min-h-0"
          >
            {tc('clear')}
          </button>
        </div>
      )}

      <ListCapNotice capped={capped} count={customers.length} />

      {/* Loading: the table's own header over skeleton rows, skeleton cards on a phone. */}
      {isLoading && <LoadingStatus />}

      {/* Desktop Table — the shared one (components/ui/data-table.tsx). */}
      <DataTable
        className="hidden md:block"
        columns={columns}
        rows={paginated}
        rowKey={(c) => c.id}
        isLoading={isLoading}
        stale={reloading}
        empty={emptyList}
      />

      {/* Mobile Cards */}
      {isLoading && (
        <SkeletonGroup className="md:hidden space-y-3">
          {repeat(PAGE_SIZE, (i) => <CustomerCardSkeleton key={i} />)}
        </SkeletonGroup>
      )}
      {!isLoading && (
        <div className={`md:hidden space-y-3 transition-opacity ${reloading ? 'opacity-60' : ''}`}>
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200">{emptyList}</div>
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
                  <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5 text-gray-400" />{customer.phone ? <LatinText dir="ltr">{customer.phone}</LatinText> : '—'}</span>
                  <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5 text-gray-400" />{customer.email ? <LatinText>{customer.email}</LatinText> : '—'}</span>
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
                    <ChevronRight className="h-4 w-4 text-gray-400 rtl:rotate-180" />
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
        <Dialog
          title={t('create')}
          onClose={() => setShowCreateModal(false)}
          footer={
            <>
              <button type="button" onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit"
                form="customers-1-form" disabled={createMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('create')}
              </button>
            </>
          }
        >
          <ValidatedForm id="customers-1-form" onSubmit={handleCreate} className="space-y-4">
            <ENTITY_FORMS.customer.Fields />
          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── Verify Confirmation ───────────────────────────────────── */}
      {verifyingCustomer && (
        <Dialog
          title={t('verify')}
          onClose={() => setVerifyingCustomer(null)}
          footer={
            <>
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
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-600">{t('confirmVerify')}</p>
            <p className="text-sm font-medium text-gray-900">{verifyingCustomer.displayName}</p>
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              {t('verifyWarning')}
            </p>
          </div>
        </Dialog>
      )}

      {/* ─── Edit Modal ────────────────────────────────────────────── */}
      {editingCustomer && (
        <Dialog
          title={t('edit')}
          onClose={() => setEditingCustomer(null)}
          footer={
            <>
              <button type="button" onClick={() => setEditingCustomer(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit"
                form="customers-3-form" disabled={updateMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('save')}
              </button>
            </>
          }
        >
          <ValidatedForm id="customers-3-form" onSubmit={handleUpdate} className="space-y-4">
            <InputField label={t('name')} name="displayName" defaultValue={editingCustomer.displayName} required placeholder={tph('customerName')} />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t('type')}<span className="text-red-500 ms-1">*</span>
              </label>
              <Select
                name="type"
                required
                defaultValue={editingCustomer.type}
                placeholder={tph('chooseCustomerType')}
                options={CUSTOMER_TYPES.map((v) => ({ value: v, label: t(v.toLowerCase()) }))}
              />
            </div>
            <InputField label={t('phone')} name="phone" type="tel" defaultValue={editingCustomer.phone} placeholder={tph('phone')} />
            <InputField label={t('email')} name="email" type="email" defaultValue={editingCustomer.email} placeholder={tph('email')} />
          </ValidatedForm>
        </Dialog>
      )}

      {/* ─── View Customer Detail ──────────────────────────────────── */}
      {viewingCustomer && detail && (
        <Dialog title={detail.displayName} onClose={() => setViewingCustomer(null)}>
          <div className="space-y-6">
            {/* Info */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('name')} value={detail.displayName} />
              <Detail label={t('type')} value={detail.type === 'B2B' ? t('b2b') : t('b2c')} />
              <Detail label={t('phone')} value={detail.phone ? <LatinText dir="ltr">{detail.phone}</LatinText> : '—'} />
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
                <EmptyState
                  size="compact"
                  icon={ShoppingCart}
                  title={t('noOrders')}
                  description={t('noOrdersHint')}
                  action={{ label: ts('create'), href: `/sales?customer=${detail.id}` }}
                />
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
                          {codeLabel('orderStatus', order.status)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Dialog>
      )}
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
