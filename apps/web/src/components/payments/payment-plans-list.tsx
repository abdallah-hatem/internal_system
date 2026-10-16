'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, CalendarClock, FileSignature } from 'lucide-react';

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

interface Instalment {
  id: string;
  sequence: number;
  dueOn: string;
  amount: number | string;
  paidEgp: number | string;
  outstandingEgp: number | string;
  state: InstalmentState;
  note?: string | null;
}

export interface Plan {
  id: string;
  reference: string;
  status: string;
  agreedOn: string;
  note?: string | null;
  customer: { id: string; displayName: string; phone?: string | null };
  /** The sale a contract plan was agreed for (§7, 2026-10-16); null for an older plan. */
  saleOrder?: { id: string; orderNo: string } | null;
  instalments: Instalment[];
  totalEgp: number | string;
  paidEgp: number | string;
  remainingEgp: number | string;
  overdueEgp: number | string;
  isOverdue: boolean;
  nextDueOn: string | null;
  nextDueEgp: number | string | null;
}

const STATE_STYLE: Record<InstalmentState, string> = {
  PAID: 'bg-success/10 text-success',
  DUE: 'bg-accent-100 text-accent-700',
  OVERDUE: 'bg-destructive/10 text-destructive',
  UPCOMING: 'bg-muted text-muted-foreground',
};

/** Plans a shop is usually on at once — a short list, not a page of ten. */
const PLAN_SKELETONS = 4;

/**
 * A collapsed plan card below, traced: customer, reference and the next-due
 * line on the start side; the figure and its caption on the end side.
 */
function PlanCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="rounded-xl border border-border bg-card">
      <div className="flex w-full items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SkeletonText size="base" className="w-32" />
            <SkeletonText size="xs" className="w-16" />
          </div>
          <SkeletonText size="xs" className="w-56 max-w-full" lineClassName="mt-1" />
        </div>
        <div className="shrink-0">
          <SkeletonText size="base" className="w-20" lineClassName="justify-end" />
          <SkeletonText size="xs" className="w-14" lineClassName="justify-end" />
        </div>
      </div>
    </div>
  );
}

/**
 * Every shop's instalment plan, for following up (owner, 2026-10-16): who is
 * behind, what has been paid, what remains, what falls due next, and cancel.
 * The Instalment plans tab of Payments.
 *
 * Nothing here creates a plan. A plan is agreed from a sale's Contract button
 * (BUSINESS_LOGIC §7), and a plan linked to a sale names it and opens its
 * contract.
 */
export function PaymentPlansList() {
  const { formatDate } = useDateFormat();
  const apiError = useApiError();
  const t = useTranslations('paymentPlans');
  const tc = useTranslations('common');
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  const [expanded, setExpanded] = useState<string | null>(null);

  const { items: plans, capped, isLoading } = useAllRecords<Plan>(['paymentPlans'], '/payment-plans');

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

  const list = Array.isArray(plans) ? plans : [];
  // Whoever is behind comes first — this page is a collections list.
  const ordered = [...list].sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue));
  const totalOverdue = list.reduce((s, p) => s + Number(p.overdueEgp), 0);

  // A plan's instalments, opened under it: due date (and note), amount, paid, state.
  const instalmentColumns: Column<Instalment>[] = [
    {
      key: 'dueOn', header: t('dueOn'), width: 'auto', className: 'text-foreground',
      cell: (i) => (
        <span className="line-clamp-2 break-words" title={i.note ?? undefined}>
          <span className="whitespace-nowrap">{formatDate(i.dueOn)}</span>
          {i.note && <span className="ms-2 text-xs text-muted-foreground">{i.note}</span>}
        </span>
      ),
    },
    { key: 'amount', header: t('amount'), width: '8.5rem', kind: 'value', align: 'end', className: 'text-foreground', cell: (i) => <Money value={i.amount} /> },
    { key: 'paid', header: t('paid'), width: '8.5rem', kind: 'value', align: 'end', className: 'text-muted-foreground', cell: (i) => <Money value={i.paidEgp} /> },
    {
      key: 'status', header: tc('status'), width: '6rem', align: 'end',
      cell: (i) => <CellBadge className={`px-2 ${STATE_STYLE[i.state]}`}>{t(i.state.toLowerCase())}</CellBadge>,
    },
  ];

  return (
    <div className="space-y-6" data-testid="payment-plans">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {totalOverdue > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">
            {t('overdueBanner')} <Money value={totalOverdue} className="font-semibold" />
          </p>
        </div>
      )}

      <ListCapNotice capped={capped} count={plans.length} />

      {isLoading ? (
        <SkeletonRegion className="space-y-3">
          {repeat(PLAN_SKELETONS, (i) => <PlanCardSkeleton key={i} />)}
        </SkeletonRegion>
      ) : ordered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card">
          <EmptyState
            icon={CalendarClock}
            title={t('noData')}
            description={t('emptyHint')}
            action={{ label: t('goToSales'), href: '/sales' }}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {ordered.map((plan) => (
            <div
              key={plan.id}
              data-testid="payment-plan"
              className={`rounded-xl border bg-card ${plan.isOverdue ? 'border-destructive/30' : 'border-border'}`}
            >
              <button
                type="button"
                onClick={() => setExpanded(expanded === plan.id ? null : plan.id)}
                className="flex w-full items-center justify-between gap-3 p-4 text-start"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">
                      <CustomerLink id={plan.customer.id} name={plan.customer.displayName} />
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">{plan.reference}</span>
                    {plan.saleOrder && (
                      <span className="text-xs text-muted-foreground" data-testid="plan-sale">
                        {t('sale')} <bdi dir="ltr" className="font-mono">{plan.saleOrder.orderNo}</bdi>
                      </span>
                    )}
                    {plan.isOverdue && (
                      <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                        {t('overdue')}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {plan.nextDueOn
                      ? `${t('nextDue')}: ${formatDate(plan.nextDueOn)} · `
                      : ''}
                    {t('remaining')}: <Money value={plan.remainingEgp} /> {t('of')}{' '}
                    <Money value={plan.totalEgp} />
                  </p>
                </div>
                <div className="shrink-0 text-end">
                  {plan.isOverdue ? (
                    <p className="font-semibold text-destructive">
                      <Money value={plan.overdueEgp} />
                    </p>
                  ) : (
                    <p className="font-medium text-foreground">
                      <Money value={plan.paidEgp} />
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {plan.isOverdue ? t('behind') : t('paidSoFar')}
                  </p>
                </div>
              </button>

              {expanded === plan.id && (
                <div className="border-t border-border px-4 py-3">
                  {/* The shared table (components/ui/data-table.tsx): the date
                      and its note take what is left; the amounts fit
                      "123,456.00 EGP" and never cut. */}
                  <DataTable
                    frame="none"
                    density="compact"
                    autoMin="8rem"
                    rows={plan.instalments}
                    rowKey={(i) => i.id}
                    columns={instalmentColumns}
                  />

                  {/* Payments are applied to the earliest promise first, so a
                      shop that pays generously early is not chased. */}
                  <p className="mt-3 text-xs text-muted-foreground">{t('cumulativeNote')}</p>

                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    {plan.saleOrder && (
                      <Link
                        href={`/${locale}/sales/${plan.saleOrder.id}/contract`}
                        data-testid="plan-open-contract"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
                      >
                        <FileSignature className="h-3.5 w-3.5" /> {t('openContract')}
                      </Link>
                    )}
                    {plan.status === 'ACTIVE' && (
                      <button
                        type="button"
                        onClick={() => {
                          const reason = window.prompt(t('cancelReason'));
                          if (reason && reason.trim().length >= 3) {
                            cancelMutation.mutate({ id: plan.id, reason });
                          }
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/5"
                      >
                        <Ban className="h-3.5 w-3.5" /> {t('cancelPlan')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
