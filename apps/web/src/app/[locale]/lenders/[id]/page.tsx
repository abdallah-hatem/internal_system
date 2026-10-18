'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Edit, HandCoins, Loader2, RotateCcw, Trash2, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useCan } from '@/lib/can';
import { useDateFormat } from '@/lib/dates';
import { Money } from '@/components/ui/money';
import { BackLink } from '@/components/ui/back-link';
import { EmptyState } from '@/components/ui/empty-state';
import { LatinText } from '@/components/ui/latin-text';
import { Skeleton, SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Dialog as Modal } from '@/components/ui/dialog';
import { FormActions } from '@/components/ui/fields';
import { ValidatedForm } from '@/components/ui/validated-form';
import { ENTITY_FORMS } from '@/components/entities/entity-forms';
import { useToast } from '@/components/ui/toast';
import { useApiError } from '@/lib/api-error';
import {
  PlanDialog,
  ReasonDialog,
  RecordRepaymentDialog,
  type FinancingView,
} from '@/components/lenders/lender-dialogs';

/**
 * One friend who paid suppliers for us (BUSINESS_LOGIC §18): every order he
 * paid for, each repayment with the day's rate and what it cleared, the plan,
 * and what is still owed — in his currency, which is what the debt is.
 */
interface LenderDetail {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  owed: { currency: string; owed: string }[];
  financings: FinancingView[];
}

type Dialog =
  | { kind: 'repay'; financing: FinancingView }
  | { kind: 'plan'; financing: FinancingView }
  | { kind: 'reverse'; repaymentId: string }
  | { kind: 'remove'; financingId: string }
  | { kind: 'cancelPlan'; planId: string }
  | { kind: 'edit' }
  | { kind: 'delete' };

const STATE_STYLE: Record<string, string> = {
  PAID: 'bg-primary-50 text-primary-700',
  DUE: 'bg-accent-50 text-accent-700',
  OVERDUE: 'bg-destructive/10 text-destructive',
  UPCOMING: 'bg-muted text-muted-foreground',
};

export default function LenderPage() {
  const t = useTranslations('lenders');
  const { id, locale } = useParams<{ id: string; locale: string }>();
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // A removed payment is history, not a debt: hidden until asked for, so it
  // does not read as a second payment beside the one that replaced it
  // (owner, 2026-10-16).
  const [showRemoved, setShowRemoved] = useState(false);
  const close = () => setDialog(null);
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const apiError = useApiError();
  const mayEdit = useCan('lender.edit');
  const mayDelete = useCan('lender.delete');

  // Correcting his name or phone (owner, 2026-10-18); the money is untouched.
  const updateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put(`/lenders/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lender', id] });
      void queryClient.invalidateQueries({ queryKey: ['lenders'] });
      close();
      addToast(t('updateSuccess'), 'success');
    },
    onError: (e) => addToast(apiError(e, t('updateFailed')), 'error'),
  });

  // Only while nothing he paid still stands; the API says so if it does.
  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/lenders/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lenders'] });
      queryClient.removeQueries({ queryKey: ['lender', id] });
      addToast(t('deleteSuccess'), 'success');
      router.push(`/${locale}/lenders`);
    },
    onError: (e) => addToast(apiError(e, t('deleteFailed')), 'error'),
  });

  const { data, isLoading, isError } = useQuery<LenderDetail>({
    queryKey: ['lender', id],
    queryFn: () => api.get(`/lenders/${id}`).then((r) => r.data.data ?? r.data),
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <BackLink onClick={() => router.push(`/${locale}/lenders`)} label={t('back')} />
        <LenderDetailSkeleton />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <EmptyState
          title={t('notFoundTitle')}
          description={t('notFoundHint')}
          action={{ label: t('back'), href: '/lenders' }}
        />
      </div>
    );
  }

  const standing = data.financings.filter((f) => !f.removedAt);
  const removedOnes = data.financings.filter((f) => f.removedAt);

  return (
    <div className="space-y-6">
      <BackLink onClick={() => router.push(`/${locale}/lenders`)} label={t('back')} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <h1 className="text-2xl font-bold text-foreground">
              <LatinText>{data.name}</LatinText>
            </h1>
            {mayEdit && (
              <button
                type="button"
                data-testid="edit-action"
                onClick={() => setDialog({ kind: 'edit' })}
                className="p-1.5 text-muted-foreground hover:text-accent-600 hover:bg-accent-50 rounded-lg transition-colors"
                title={tc('edit')}
                aria-label={tc('edit')}
              >
                <Edit className="h-4 w-4" />
              </button>
            )}
            {mayDelete && (
              <button
                type="button"
                data-testid="delete-action"
                onClick={() => setDialog({ kind: 'delete' })}
                className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                title={tc('delete')}
                aria-label={tc('delete')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
          {(data.phone || data.notes) && (
            <p className="mt-1 text-sm text-muted-foreground">
              {data.phone && <span dir="ltr">{data.phone}</span>}
              {data.phone && data.notes && ' · '}
              {data.notes}
            </p>
          )}
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-3 text-start sm:text-end" data-testid="lender-owed">
          <p className="text-xs text-muted-foreground">{t('owed')}</p>
          {data.owed.length === 0 ? (
            <p className="text-lg font-semibold text-muted-foreground">{t('nothingOwed')}</p>
          ) : (
            data.owed.map((o) => (
              <p key={o.currency} className="text-lg font-bold text-foreground">
                <Money value={o.owed} currency={o.currency} />
              </p>
            ))
          )}
        </div>
      </div>

      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
        <HandCoins className="h-4 w-4 text-muted-foreground" /> {t('paidFor')}
      </h2>

      {standing.length === 0 ? (
        <div className="rounded-xl border border-border bg-card">
          <EmptyState icon={HandCoins} title={t('noFinancings')} description={t('noFinancingsHint')} />
        </div>
      ) : (
        standing.map((f) => (
          <FinancingCard key={f.id} f={f} locale={locale} onOpen={setDialog} />
        ))
      )}

      {removedOnes.length > 0 && (
        <div className="space-y-3">
          <button
            type="button"
            data-testid="toggle-removed"
            aria-expanded={showRemoved}
            onClick={() => setShowRemoved((v) => !v)}
            className="text-sm font-medium text-primary-600 hover:underline"
          >
            {showRemoved ? t('hideRemoved') : t('showRemoved', { count: removedOnes.length })}
          </button>
          {showRemoved &&
            removedOnes.map((f) => <FinancingCard key={f.id} f={f} locale={locale} onOpen={setDialog} />)}
        </div>
      )}

      {dialog?.kind === 'repay' && <RecordRepaymentDialog financing={dialog.financing} onClose={close} />}
      {dialog?.kind === 'plan' && <PlanDialog financing={dialog.financing} onClose={close} />}
      {dialog?.kind === 'reverse' && (
        <ReasonDialog
          title={t('reverseTitle')}
          hint={t('reverseHint')}
          submitLabel={t('reverse')}
          endpoint={`/lender-repayments/${dialog.repaymentId}/reverse`}
          successMessage={t('reverseDone')}
          onClose={close}
          testId="reverse-repayment-dialog"
        />
      )}
      {dialog?.kind === 'remove' && (
        <ReasonDialog
          title={t('removeTitle')}
          hint={t('removeHint')}
          submitLabel={t('remove')}
          endpoint={`/lender-financings/${dialog.financingId}/remove`}
          successMessage={t('removeDone')}
          onClose={close}
        />
      )}
      {dialog?.kind === 'cancelPlan' && (
        <ReasonDialog
          title={t('cancelPlanTitle')}
          hint={t('cancelPlanHint')}
          submitLabel={t('cancelPlan')}
          endpoint={`/lender-plans/${dialog.planId}/cancel`}
          successMessage={t('planCancelled')}
          onClose={close}
        />
      )}

      {dialog?.kind === 'edit' && (
        <Modal
          title={t('edit')}
          onClose={close}
          footer={
            <FormActions
              form="lender-edit-form"
              onCancel={close}
              cancelLabel={tc('cancel')}
              submitLabel={tc('save')}
              busy={updateMutation.isPending}
            />
          }
        >
          <ValidatedForm
            id="lender-edit-form"
            onSubmit={(e) => {
              e.preventDefault();
              updateMutation.mutate(ENTITY_FORMS.lender.toPayload(new FormData(e.currentTarget)));
            }}
            className="space-y-4"
          >
            <ENTITY_FORMS.lender.Fields record={data} />
          </ValidatedForm>
        </Modal>
      )}

      {dialog?.kind === 'delete' && (
        <Modal
          title={t('delete')}
          onClose={close}
          footer={
            <>
              <button
                type="button"
                onClick={close}
                className="px-4 py-2 text-sm text-muted-foreground hover:bg-muted rounded-lg"
              >
                {standing.length > 0 ? tc('close') : tc('cancel')}
              </button>
              {standing.length === 0 && (
                <button
                  type="button"
                  data-testid="confirm-delete"
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                  className="px-4 py-2 text-sm bg-destructive text-destructive-foreground rounded-lg hover:bg-destructive/90 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {deleteMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {tc('delete')}
                </button>
              )}
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-sm font-medium text-foreground"><LatinText>{data.name}</LatinText></p>
            {standing.length > 0 ? (
              <p className="text-sm text-accent-700 bg-accent-50 border border-accent-200 rounded-lg px-3 py-2">
                {t('deleteBlocked', { count: standing.length })}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{t('confirmDelete')}</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Orders a lender has usually paid for — the page shows every one, unpaged. */
const FINANCING_SKELETONS = 2;

/**
 * The page below the back link, traced: the name and phone beside the owed
 * box, the "paid for" heading, and financing cards. Change the page, change this.
 */
function LenderDetailSkeleton() {
  const t = useTranslations('lenders');
  return (
    <SkeletonRegion className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <SkeletonText size="2xl" className="w-48" />
          <SkeletonText className="w-32" lineClassName="mt-1" />
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <SkeletonText size="xs" className="w-16" lineClassName="sm:justify-end" />
          <SkeletonText size="lg" className="w-28" lineClassName="sm:justify-end" />
        </div>
      </div>
      {/* The section's title needs no data: the real one. */}
      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
        <HandCoins className="h-4 w-4 text-muted-foreground" /> {t('paidFor')}
      </h2>
      {repeat(FINANCING_SKELETONS, (i) => <FinancingCardSkeleton key={i} />)}
    </SkeletonRegion>
  );
}

/** `FinancingCard` below, traced: header, the three figures, the actions, repayments. */
function FinancingCardSkeleton() {
  return (
    <section data-testid="skeleton-row" className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div className="min-w-0 space-y-1">
          <SkeletonText className="w-48" />
          <SkeletonText className="w-40" />
          <SkeletonText size="xs" className="w-56 max-w-full" />
        </div>
        <div>
          <SkeletonText size="xs" className="w-12" lineClassName="sm:justify-end" />
          <SkeletonText size="xl" className="w-28" lineClassName="sm:justify-end" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px border-b border-border bg-muted sm:grid-cols-3">
        {repeat(3, (i) => (
          <div key={i} className={`min-w-0 bg-card px-4 py-3 sm:px-5 ${i === 2 ? 'col-span-2 sm:col-span-1' : ''}`}>
            <SkeletonText size="xs" className="w-16" />
            <SkeletonText className="w-24" />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
        <Skeleton className="h-8 w-40 rounded-lg" />
        {/* The bordered one is 2px taller than the filled one beside it. */}
        <Skeleton className="h-8.5 w-28 rounded-lg" />
      </div>
      <div className="px-4 py-3 sm:px-5">
        <SkeletonText className="w-24" lineClassName="mb-2" />
        <SkeletonText className="w-40" />
      </div>
    </section>
  );
}

function FinancingCard({
  f,
  locale,
  onOpen,
}: {
  f: FinancingView;
  locale: string;
  onOpen: (d: Dialog) => void;
}) {
  const t = useTranslations('lenders');
  const { formatDate } = useDateFormat();
  const may = {
    repay: useCan('lender.repay'),
    reverse: useCan('lender.reverseRepayment'),
    remove: useCan('lender.removeFinancing'),
    plan: useCan('lender.plan'),
    cancelPlan: useCan('lender.cancelPlan'),
  };
  const removed = Boolean(f.removedAt);
  const owed = Number(f.owed);
  const standing = f.repayments.filter((r) => !r.reversedAt);
  type Repayment = FinancingView['repayments'][number];
  const struck = (r: Repayment) => (r.reversedAt ? 'line-through' : undefined);

  // A financing's repayments: date, pounds paid, rate, cleared, exchange
  // difference, and Reverse.
  const repaymentColumns: Column<Repayment>[] = [
    { key: 'date', header: t('date'), width: 'auto', kind: 'value', className: struck, cell: (r) => formatDate(r.paidOn) },
    {
      key: 'pounds', header: t('pounds'), width: '8.5rem', kind: 'value', align: 'end', className: struck,
      cell: (r) => <Money value={r.amountEgp} currency="EGP" />,
    },
    {
      key: 'rate', header: t('rate'), width: '5rem', kind: 'value', align: 'end', className: struck,
      cell: (r) => <span dir="ltr">{Number(r.rateToEgp)}</span>,
    },
    {
      key: 'cleared', header: t('cleared'), width: '8.5rem', kind: 'value', align: 'end', className: struck,
      cell: (r) => <Money value={r.cleared} currency={f.currency} />,
    },
    {
      key: 'exchangeDiff', header: t('exchangeDiff'), width: '8.5rem', kind: 'value', align: 'end', className: struck,
      cell: (r) => <Money value={r.exchangeDiffEgp} currency="EGP" />,
    },
    {
      key: 'actions', header: null, width: '6rem', align: 'end', className: 'whitespace-nowrap',
      cell: (r) =>
        r.reversedAt ? (
          <span className="text-xs" title={r.reversalReason ?? ''}>{t('reversed')}</span>
        ) : (
          may.reverse && (
            <button
              type="button"
              onClick={() => onOpen({ kind: 'reverse', repaymentId: r.id })}
              data-testid="reverse-repayment"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
            >
              <RotateCcw className="h-3.5 w-3.5" /> {t('reverse')}
            </button>
          )
        ),
    },
  ];

  return (
    <section
      data-testid="financing-card"
      className={`overflow-hidden rounded-xl border bg-card ${removed ? 'border-border opacity-70' : 'border-border'}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-mono font-medium text-foreground" dir="ltr">{f.purchaseOrder.reference}</span>
            <span className="text-muted-foreground">·</span>
            <Link
              href={`/${locale}/cycles/${f.cycle.id}/details`}
              className="font-mono text-muted-foreground underline-offset-2 hover:text-primary-600 hover:underline"
              dir="ltr"
            >
              {f.cycle.code}
            </Link>
            {removed && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t('removed')}</span>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('paid')} <Money value={f.amount} currency={f.currency} className="font-semibold text-foreground" />{' '}
            <span className="text-muted-foreground">· {formatDate(f.paidOn)}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {t.rich('atOrderRate', {
              amount: () => <Money value={f.amountEgp} currency="EGP" />,
              rate: () => <span dir="ltr">{Number(f.fxRateToEgp)}</span>,
            })}
          </p>
        </div>
        <div className="text-start sm:text-end">
          <p className="text-xs text-muted-foreground">{t('owed')}</p>
          <p className={`text-xl font-bold ${owed > 0 ? 'text-accent-700' : 'text-primary-700'}`} data-testid="financing-owed">
            <Money value={f.owed} currency={f.currency} />
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px border-b border-border bg-muted sm:grid-cols-3">
        <Figure label={t('repaid')} value={<Money value={f.repaid} currency={f.currency} />} />
        <Figure label={t('pounds')} value={<Money value={f.paidEgp} currency="EGP" />} />
        <Figure
          label={t('exchangeDiff')}
          title={t('exchangeDiffHint')}
          value={
            <Money
              value={f.exchangeDiffEgp}
              currency="EGP"
              className={Number(f.exchangeDiffEgp) > 0 ? 'text-destructive' : Number(f.exchangeDiffEgp) < 0 ? 'text-primary-700' : ''}
            />
          }
          testId="financing-exchange-diff"
          wide
        />
      </div>

      {!removed && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
          {may.repay && owed > 0 && (
            <button
              type="button"
              onClick={() => onOpen({ kind: 'repay', financing: f })}
              data-testid="record-repayment"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-700"
            >
              <Wallet className="h-4 w-4" /> {t('recordRepayment')}
            </button>
          )}
          {may.plan && owed > 0 && !f.plan && (
            <button
              type="button"
              onClick={() => onOpen({ kind: 'plan', financing: f })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
            >
              <CalendarClock className="h-4 w-4" /> {t('setPlan')}
            </button>
          )}
          {may.remove && standing.length === 0 && (
            <button
              type="button"
              onClick={() => onOpen({ kind: 'remove', financingId: f.id })}
              className="ms-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4" /> {t('remove')}
            </button>
          )}
        </div>
      )}

      {f.plan && (
        <div className="space-y-2 border-b border-border px-4 py-3 sm:px-5" data-testid="lender-plan">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">{t('plan')}</p>
            {may.cancelPlan && (
              <button
                type="button"
                onClick={() => onOpen({ kind: 'cancelPlan', planId: f.plan!.id })}
                className="text-xs font-medium text-muted-foreground hover:text-destructive"
              >
                {t('cancelPlan')}
              </button>
            )}
          </div>
          <ul className="divide-y divide-border text-sm">
            {f.plan.instalments.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span className="text-foreground">
                  {t('instalment', { n: i.sequence })} · {formatDate(i.dueOn)}
                </span>
                <span className="flex items-center gap-2">
                  <Money value={i.amount} currency={f.currency} className="tabular-nums" />
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLE[i.state]}`}>
                    {t(`state.${i.state}`)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="px-4 py-3 sm:px-5">
        <p className="mb-2 text-sm font-semibold text-foreground">{t('repayments')}</p>
        {f.repayments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noRepayments')}</p>
        ) : (
          <>
            {/* Desktop — the shared table (components/ui/data-table.tsx). The
                amounts fit "123,456.00 EGP" and never cut; the date takes the rest. */}
            <DataTable
              className="hidden md:block"
              frame="none"
              density="compact"
              autoMin="7rem"
              rows={f.repayments}
              rowKey={(r) => r.id}
              rowProps={() => ({ 'data-testid': 'repayment-row' })}
              rowClassName={(r) => (r.reversedAt ? 'text-muted-foreground' : undefined)}
              columns={repaymentColumns}
            />

            {/* Phone */}
            <ul className="space-y-2 md:hidden">
              {f.repayments.map((r) => (
                <li
                  key={r.id}
                  data-testid="repayment-card"
                  className={`rounded-lg border border-border p-3 text-sm ${r.reversedAt ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground">{formatDate(r.paidOn)}</span>
                    <Money value={r.amountEgp} currency="EGP" className={`font-semibold ${r.reversedAt ? 'line-through' : ''}`} />
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {t('rate')} <span dir="ltr">{Number(r.rateToEgp)}</span>
                    </span>
                    <span>
                      {t.rich('clears', { amount: () => <Money value={r.cleared} currency={f.currency} /> })}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {t('exchangeDiff')}: <Money value={r.exchangeDiffEgp} currency="EGP" />
                    </span>
                    {r.reversedAt ? (
                      <span>{t('reversed')}</span>
                    ) : (
                      may.reverse && (
                        <button
                          type="button"
                          onClick={() => onOpen({ kind: 'reverse', repaymentId: r.id })}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-destructive hover:bg-destructive/10"
                        >
                          <RotateCcw className="h-3.5 w-3.5" /> {t('reverse')}
                        </button>
                      )
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

function Figure({
  label,
  value,
  title,
  testId,
  wide,
}: {
  label: string;
  value: React.ReactNode;
  title?: string;
  testId?: string;
  /** Takes the whole row on a phone, where the grid is two wide. */
  wide?: boolean;
}) {
  return (
    <div className={`min-w-0 bg-card px-4 py-3 sm:px-5 ${wide ? 'col-span-2 sm:col-span-1' : ''}`} title={title} data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}
