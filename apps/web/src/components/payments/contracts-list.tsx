'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, FileSignature } from '@/components/ui/icons';

import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useAllRecords } from '@/lib/list-all';
import { useDateFormat } from '@/lib/dates';
import { ListCapNotice } from '@/components/ui/list-cap-notice';
import { useToast } from '@/components/ui/toast';
import { CustomerLink } from '@/components/ui/entity-link';
import { Money } from '@/components/ui/money';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, CellBadge, type Column } from '@/components/ui/data-table';

type InstalmentState = 'PAID' | 'DUE' | 'OVERDUE' | 'UPCOMING';

/** One plan as `GET /payment-plans` returns it, with its standing worked out by the API. */
export interface Plan {
  id: string;
  reference: string;
  status: string;
  agreedOn: string;
  customer: { id: string; displayName: string; phone?: string | null };
  /** The sale the contract was signed for (§7, 2026-10-16); null for an older plan. */
  saleOrder?: { id: string; orderNo: string } | null;
  instalments: { id: string; dueOn: string; state: InstalmentState }[];
  totalEgp: number | string;
  paidEgp: number | string;
  remainingEgp: number | string;
  overdueEgp: number | string;
  isOverdue: boolean;
  nextDueOn: string | null;
  nextDueEgp: number | string | null;
}

/** Where a contract stands, from the figures the API already worked out. */
export type ContractStanding = 'overdue' | 'paid' | 'open';

export function contractStanding(p: Pick<Plan, 'isOverdue' | 'remainingEgp'>): ContractStanding {
  if (p.isOverdue) return 'overdue';
  return Number(p.remainingEgp) <= 0 ? 'paid' : 'open';
}

/** Rows shown while loading — a shop rarely has more than a handful. */
const SKELETON_ROWS = 4;

/**
 * Contracts, one row each (owner, 2026-10-17: "replace payment plans with
 * contracts, where I can see the contract for this shop"). A contract is a sale
 * with its instalment plan (§7); the row opens its page, where it is printed,
 * downloaded and shared.
 *
 * The same list in two places: every shop's on Payments' Contracts tab, and one
 * shop's on that shop's page (`customerId`). A plan agreed before contracts
 * existed has no sale and so no contract page: it is still listed — it is money
 * owed — and says it has no contract (§7, 2026-10-17).
 */
export function ContractsList({ customerId }: { customerId?: string }) {
  const t = useTranslations('contracts');
  const tc = useTranslations('common');
  const { formatDate } = useDateFormat();
  const apiError = useApiError();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const scoped = !!customerId;

  const { items, capped, isLoading, isError, error } = useAllRecords<Plan>(
    scoped ? ['paymentPlans', customerId] : ['paymentPlans'],
    '/payment-plans',
    scoped ? { customerId } : undefined,
  );

  const cancelMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/payment-plans/${id}/cancel`, { reason }),
    onSuccess: () => {
      addToast(t('cancelled'), 'success');
      void queryClient.invalidateQueries({ queryKey: ['paymentPlans'] });
      void queryClient.invalidateQueries({ queryKey: ['sale'] });
    },
    onError: (e: unknown) => addToast(apiError(e, t('cancelFailed')), 'error'),
  });

  // The API filters by shop; this makes sure a row of another shop's can never
  // be shown on this one's page, whatever reached the cache.
  const list = (Array.isArray(items) ? items : []).filter((p) => !scoped || p.customer?.id === customerId);
  // Whoever is behind comes first — this is a collections list.
  const rows = [...list].sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue));
  const totalOverdue = list.reduce((s, p) => s + Number(p.overdueEgp), 0);

  const contractHref = (p: Plan) => (p.saleOrder ? `/sales/${p.saleOrder.id}/contract` : null);
  const open = (p: Plan) => {
    const href = contractHref(p);
    if (href) router.push(href);
  };
  const stop = (e: MouseEvent) => e.stopPropagation();

  const cancel = (p: Plan) => {
    const reason = window.prompt(t('cancelReason'));
    if (reason && reason.trim().length >= 3) cancelMutation.mutate({ id: p.id, reason });
  };

  /** The order number, opening the contract; or that there is none. */
  const contractCell = (p: Plan) =>
    p.saleOrder ? (
      <Link
        href={`/sales/${p.saleOrder.id}/contract`}
        onClick={stop}
        data-testid="contract-open"
        className="inline-flex items-center gap-1.5 text-primary-600 hover:underline"
      >
        <FileSignature aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <bdi dir="ltr" className="font-mono text-xs">{p.saleOrder.orderNo}</bdi>
      </Link>
    ) : (
      <span className="text-xs text-muted-foreground" data-testid="contract-none">{t('noContract')}</span>
    );

  /** Next due date and amount, or the contract's state when there is nothing ahead to show. */
  const nextCell = (p: Plan): ReactNode => {
    const standing = contractStanding(p);
    if (standing === 'paid') {
      return <CellBadge className="bg-success/10 text-success">{t('allPaid')}</CellBadge>;
    }
    if (standing === 'overdue') {
      return (
        <span className="inline-flex flex-col items-end gap-0.5">
          <CellBadge className="bg-destructive/10 text-destructive">{t('overdue')}</CellBadge>
          <Money value={p.overdueEgp} className="text-xs font-medium text-destructive" />
        </span>
      );
    }
    return (
      <span className="inline-flex flex-col items-end">
        <span className="text-sm text-foreground">{p.nextDueOn ? formatDate(p.nextDueOn) : '—'}</span>
        {p.nextDueEgp != null && <Money value={p.nextDueEgp} className="text-xs text-muted-foreground" />}
      </span>
    );
  };

  const actionsCell = (p: Plan) =>
    p.status === 'ACTIVE' ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          cancel(p);
        }}
        disabled={cancelMutation.isPending}
        title={t('cancelPlan')}
        aria-label={t('cancelPlan')}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/5 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Ban className="h-3.5 w-3.5" />
      </button>
    ) : null;

  const columns: Column<Plan>[] = [
    ...(scoped
      ? []
      : [
          {
            key: 'shop',
            header: t('shop'),
            width: 'auto',
            kind: 'name' as const,
            title: (p: Plan) => p.customer.displayName,
            cell: (p: Plan) => (
              <span onClick={stop} className="font-medium text-foreground">
                <CustomerLink id={p.customer.id} name={p.customer.displayName} />
              </span>
            ),
          },
        ]),
    { key: 'contract', header: t('contract'), width: scoped ? 'auto' : '10rem', kind: 'plain', cell: contractCell },
    { key: 'total', header: t('total'), width: '8.5rem', kind: 'value', align: 'end', className: 'text-foreground', cell: (p) => <Money value={p.totalEgp} /> },
    { key: 'paid', header: t('paid'), width: '8.5rem', kind: 'value', align: 'end', className: 'text-muted-foreground', cell: (p) => <Money value={p.paidEgp} /> },
    {
      key: 'next', header: t('nextDue'), width: '8.5rem', kind: 'plain', align: 'end',
      skeleton: { kind: 'text', share: 'w-3/4' },
      cell: nextCell,
    },
    { key: 'actions', header: <span className="sr-only">{tc('actions')}</span>, width: '4rem', align: 'end', skeleton: { kind: 'buttons', count: 1 }, cell: actionsCell },
  ];

  if (isError) {
    return (
      <p role="alert" data-testid="contracts-error" className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        {apiError(error, t('loadFailed'))}
      </p>
    );
  }

  const empty = (
    <EmptyState
      size={scoped ? 'compact' : 'default'}
      icon={FileSignature}
      title={scoped ? t('noneForShop') : t('none')}
      description={t('emptyHint')}
      action={scoped ? undefined : { label: t('goToSales'), href: '/sales' }}
    />
  );

  return (
    <div className="space-y-4" data-testid="contracts">
      {!scoped && totalOverdue > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">
            {t('overdueBanner')} <Money value={totalOverdue} className="font-semibold" />
          </p>
        </div>
      )}

      <ListCapNotice capped={capped} count={items.length} />

      {!isLoading && rows.length === 0 ? (
        <div className={scoped ? '' : 'rounded-xl border border-dashed border-border bg-card'} data-testid="contracts-empty">
          {empty}
        </div>
      ) : (
        <>
          <DataTable
            className="hidden md:block"
            frame={scoped ? 'none' : 'card'}
            density={scoped ? 'compact' : 'normal'}
            autoMin="9rem"
            columns={columns}
            rows={rows}
            rowKey={(p) => p.id}
            isLoading={isLoading}
            skeletonRows={SKELETON_ROWS}
            onRowClick={open}
            rowClassName={(p) => (p.saleOrder ? undefined : 'cursor-default')}
            rowProps={(p) => ({
              'data-testid': 'contract-row',
              'data-standing': contractStanding(p),
            })}
            caption={t('title')}
          />

          {/* On a phone, a card per contract: the same figures, stacked. */}
          {isLoading ? (
            <SkeletonRegion className="space-y-2 md:hidden">
              {repeat(SKELETON_ROWS, (i) => <ContractCardSkeleton key={i} />)}
            </SkeletonRegion>
          ) : (
            <ul className="space-y-2 md:hidden">
              {rows.map((p) => (
                <li
                  key={p.id}
                  data-testid="contract-card"
                  data-standing={contractStanding(p)}
                  onClick={() => open(p)}
                  className={`rounded-xl border bg-card p-4 ${p.saleOrder ? 'cursor-pointer' : ''} ${p.isOverdue ? 'border-destructive/30' : 'border-border'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {!scoped && (
                        <p className="truncate font-medium text-foreground" onClick={stop}>
                          <CustomerLink id={p.customer.id} name={p.customer.displayName} truncate />
                        </p>
                      )}
                      <div className="mt-0.5">{contractCell(p)}</div>
                    </div>
                    <div className="shrink-0 text-end">{nextCell(p)}</div>
                  </div>
                  <div className="mt-3 flex items-end justify-between gap-3 text-xs text-muted-foreground">
                    <span>
                      {t('paid')} <Money value={p.paidEgp} className="text-foreground" /> {t('of')}{' '}
                      <Money value={p.totalEgp} className="text-foreground" />
                    </span>
                    {actionsCell(p)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** A phone card, traced: shop and order number over the paid line; the next due at the end. */
function ContractCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <SkeletonText className="w-2/3" />
          <SkeletonText size="xs" className="w-1/3" />
        </div>
        <SkeletonText lineClassName="justify-end" className="w-20" />
      </div>
      <SkeletonText size="xs" className="w-1/2" lineClassName="mt-3" />
    </div>
  );
}
