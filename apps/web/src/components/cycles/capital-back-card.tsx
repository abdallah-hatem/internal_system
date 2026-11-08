'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { useCodeLabel } from '@/lib/labels';
import { businessToday, useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { Money } from '@/components/ui/money';
import { MoneyInput } from '@/components/ui/money-input';
import { DatePicker } from '@/components/ui/date-picker';
import { Select } from '@/components/ui/select';
import { Dialog, DialogAlert } from '@/components/ui/dialog';
import { FieldLabel, FormActions } from '@/components/ui/fields';
import { ValidatedForm } from '@/components/ui/validated-form';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';
import { AlertTriangle, Plus, Undo2, Wallet } from '@/components/ui/icons';
import { UndoDrawDialog, useRefreshDraws } from './profit-draws-card';

/**
 * Capital taken back before a cycle is settled (BUSINESS_LOGIC §8, owner
 * 2026-11-08) — "Capital back early" / «استرداد رأس المال مبكرًا».
 *
 * Mid-cycle the capital is stock, customers' debt, or cash paid sales brought
 * back — and that cash is everyone's, investors' included. So each person may
 * take back the share of the cycle's cost recovered so far, times what he put
 * in, less what he already took back. Cash on hand goes down; the profit and
 * the split do not. Settlement pays him the rest of his capital.
 *
 * Every figure is the server's (`GET /cycles/:id/capital-back`); the form's
 * check is only to say so sooner.
 */

export interface CapitalBackPerson {
  userId: string;
  participantType: string;
  name: string;
  contributionEgp: string;
  recoveredEgp: string;
  takenEgp: string;
  availableEgp: string;
}

export interface CapitalTaken {
  id: string;
  userId: string;
  name: string;
  amountEgp: string;
  takenOn: string;
  note: string | null;
  createdAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
  settled: boolean;
}

export interface CapitalBackView {
  cycleId: string;
  cycleCode: string;
  locked: string | null;
  toFundEgp: string;
  recoveredEgp: string;
  recoveredPct: string;
  people: CapitalBackPerson[];
  taken: CapitalTaken[];
}

const num = (v: unknown) => Number(v ?? 0);
const piastres = (v: unknown) => Math.round(num(v) * 100);

const inputClass =
  'w-full rounded-lg border border-border bg-card px-3 py-2 text-start text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-primary-500';
const primaryButton =
  'inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0';
const linkButton =
  'inline-flex min-h-11 cursor-pointer items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0';

export function CapitalBackCard({ cycleId }: { cycleId: string }) {
  const t = useTranslations('capitalBack');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const { user } = useAuth();
  const canRead = useCan('capitalBack.read');
  const canTake = useCan('capitalBack.take');
  const canReverse = useCan('profitDraw.reverse');
  const [taking, setTaking] = useState(false);
  const [undoing, setUndoing] = useState<CapitalTaken | null>(null);

  const query = useQuery<CapitalBackView>({
    queryKey: ['capital-back', cycleId],
    queryFn: () => api.get(`/cycles/${cycleId}/capital-back`).then((r) => r.data.data ?? r.data),
    enabled: canRead,
  });

  if (!canRead) return null;
  if (query.isLoading) return <CapitalBackCardSkeleton />;
  const data = query.data;
  if (query.isError || !data || !Array.isArray(data.people) || !Array.isArray(data.taken)) {
    return (
      <section data-testid="capital-back-error" className="rounded-xl border border-border bg-card p-5">
        <CardTitle />
        <EmptyState
          size="compact"
          icon={AlertTriangle}
          title={t('loadFailed')}
          action={{ label: t('retry'), onClick: () => void query.refetch() }}
          className="text-destructive"
        />
      </section>
    );
  }

  const locked = data.locked;
  const mayTake = canTake && !locked && data.people.length > 0;
  const me = data.people.some((p) => p.userId === user?.id) ? user?.id : undefined;

  return (
    <section data-testid="capital-back-card" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <CardTitle />
        {mayTake && (
          <button type="button" data-testid="take-capital" onClick={() => setTaking(true)} className={primaryButton}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('take')}
          </button>
        )}
      </div>

      {locked && (
        <p data-testid="capital-back-locked" className="mb-3 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          {t('locked', { reason: codeLabel('profitDrawLock', locked) })}
        </p>
      )}

      <div>
        <p className="text-xs text-muted-foreground">{t('recovered')}</p>
        <p data-testid="capital-back-recovered" className="text-lg font-bold text-foreground">
          <bdi dir="ltr">{formatNumber(num(data.recoveredPct), { maximumFractionDigits: 2 })}%</bdi>
        </p>
        <p className="text-xs text-muted-foreground">
          {t.rich('recoveredOf', {
            amount: () => <Money value={data.recoveredEgp} />,
            total: () => <Money value={data.toFundEgp} />,
          })}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('recoveredHint')}</p>
      </div>

      {data.people.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('noPeople')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {data.people.map((p) => (
            <li key={p.userId} data-testid="capital-back-person" data-person={p.userId} className="py-2">
              <p className="min-w-0 break-words font-medium text-foreground [overflow-wrap:anywhere]">
                <bdi>{p.name}</bdi>
                {p.participantType === 'TEMP_INVESTOR' && (
                  <span className="ms-2 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-normal text-primary">
                    {t('investor')}
                  </span>
                )}
              </p>
              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                <Figure label={t('colPutIn')} value={p.contributionEgp} testId="put-in" />
                <Figure label={t('colRecovered')} value={p.recoveredEgp} testId="recovered" />
                <Figure label={t('colTaken')} value={p.takenEgp} testId="taken" />
                <Figure label={t('colAvailable')} value={p.availableEgp} testId="available" tone="font-semibold text-foreground" />
              </dl>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-4 mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('historyHeading')}</h3>
      {data.taken.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noneYet')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.taken.map((d) => {
            const standing = !d.reversedAt && !d.settled;
            return (
              <li key={d.id} data-testid="capital-taken" data-taken={d.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-foreground [overflow-wrap:anywhere]">
                    <bdi>{d.name}</bdi>
                    <span className="ms-2 text-xs text-muted-foreground">{formatDate(d.takenOn)}</span>
                  </p>
                  {d.note && <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]"><bdi>{d.note}</bdi></p>}
                  {d.reversedAt && (
                    <p data-testid="capital-reversed" className="text-xs text-muted-foreground">
                      {d.reversalReason ? t('reversedReason', { reason: d.reversalReason }) : t('reversed')}
                    </p>
                  )}
                  {d.settled && !d.reversedAt && (
                    <p data-testid="capital-settled" className="text-xs text-muted-foreground">{t('settled')}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className={cn('whitespace-nowrap tabular-nums', d.reversedAt ? 'text-muted-foreground line-through' : 'text-foreground')}>
                    <Money value={d.amountEgp} />
                  </span>
                  {standing && canReverse && !locked && (
                    <button type="button" data-testid="undo-capital" onClick={() => setUndoing(d)} className={linkButton}>
                      <Undo2 className="h-4 w-4" aria-hidden="true" />
                      {t('undo')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {taking && (
        <TakeCapitalDialog cycleId={cycleId} people={data.people} defaultPerson={me} onClose={() => setTaking(false)} />
      )}
      {undoing && (
        <UndoDrawDialog
          cycleId={cycleId}
          ns="capitalBack"
          draw={{ id: undoing.id, name: undoing.name, amountEgp: undoing.amountEgp, drawnOn: undoing.takenOn }}
          onClose={() => setUndoing(null)}
        />
      )}
    </section>
  );
}

function Figure({ label, value, testId, tone = 'text-foreground' }: { label: string; value: string; testId: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd data-testid={`capital-${testId}`} className={cn('whitespace-nowrap tabular-nums', tone)}>
        <Money value={value} />
      </dd>
    </div>
  );
}

function CardTitle() {
  const t = useTranslations('capitalBack');
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
      <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      {t('title')}
    </h2>
  );
}

/** Someone on the cycle — partner or investor — takes part of his capital back. */
export function TakeCapitalDialog({
  cycleId,
  people,
  defaultPerson,
  onClose,
}: {
  cycleId: string;
  people: CapitalBackPerson[];
  defaultPerson?: string;
  onClose: () => void;
}) {
  const t = useTranslations('capitalBack');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const { formatMoney } = useNumberFormat();
  const { addToast } = useToast();
  const refresh = useRefreshDraws(cycleId);
  const [who, setWho] = useState(defaultPerson ?? '');
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = people.find((p) => p.userId === who);
  const sending = useRef(false);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/cycles/${cycleId}/capital-back`, body),
    onSettled: () => {
      sending.current = false;
    },
    onSuccess: () => {
      refresh();
      addToast(t('saved', { name: chosen?.name ?? '' }), 'success');
      onClose();
    },
    onError: (e) => {
      refresh();
      setProblem(apiError(e, t('failed')));
    },
  });

  return (
    <Dialog
      title={t('takeTitle')}
      description={t('takeHint')}
      onClose={onClose}
      busy={save.isPending}
      cardProps={{ 'data-testid': 'take-capital-dialog' }}
      footer={<FormActions form="take-capital-form" onCancel={onClose} cancelLabel={tc('cancel')} submitLabel={t('take')} busy={save.isPending} />}
    >
      <ValidatedForm
        id="take-capital-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!chosen || sending.current) return;
          const asked = piastres(amount);
          if (!(asked > 0)) return setProblem(t('notPositive'));
          if (asked > piastres(chosen.availableEgp)) {
            return setProblem(
              piastres(chosen.availableEgp) <= 0
                ? t('nothingAvailable', { name: chosen.name })
                : t('overAvailable', { name: chosen.name, max: formatMoney(num(chosen.availableEgp)) }),
            );
          }
          setProblem(null);
          sending.current = true;
          const fd = new FormData(e.currentTarget);
          save.mutate({
            userId: chosen.userId,
            amountEgp: asked / 100,
            takenOn: (fd.get('takenOn') as string) || undefined,
            note: ((fd.get('note') as string) || '').trim() || undefined,
          });
        }}
      >
        <DialogAlert message={problem} testId="take-capital-problem" />
        <FieldLabel label={t('person')} required>
          <Select
            name="person"
            required
            value={who}
            onChange={(v) => {
              setWho(v);
              setProblem(null);
            }}
            placeholder={tph('choosePerson')}
            options={people.map((p) => ({ value: p.userId, label: p.name }))}
          />
        </FieldLabel>
        <div>
          <label htmlFor="take-capital-amount" className="mb-1 block text-sm font-medium text-foreground">
            {t('amount')}
            <span aria-hidden="true" className="ms-1 text-destructive">*</span>
          </label>
          <MoneyInput
            id="take-capital-amount"
            name="amountEgp"
            required
            value={amount}
            onChange={(v) => {
              setAmount(v);
              setProblem(null);
            }}
            placeholder={tph('money')}
            className={inputClass}
          />
          {chosen && (
            <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground">
              <span data-testid="take-capital-max">{t.rich('max', { amount: () => <Money value={chosen.availableEgp} /> })}</span>
              {num(chosen.availableEgp) > 0 && (
                <button
                  type="button"
                  data-testid="take-all-capital"
                  onClick={() => {
                    setAmount(String(num(chosen.availableEgp)));
                    setProblem(null);
                  }}
                  className="min-h-11 cursor-pointer font-medium text-primary-600 hover:text-primary-700 sm:min-h-0"
                >
                  {t('takeAll')}
                </button>
              )}
            </div>
          )}
        </div>
        <FieldLabel label={t('date')} required>
          <DatePicker name="takenOn" required disableFuture defaultValue={businessToday()} />
        </FieldLabel>
        <FieldLabel label={t('note')}>
          <textarea name="note" rows={3} maxLength={500} placeholder={tph('profitDrawNote')} className={inputClass} />
        </FieldLabel>
      </ValidatedForm>
    </Dialog>
  );
}

/** The card above while it loads. */
export function CapitalBackCardSkeleton() {
  return (
    <section data-testid="capital-back-loading" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3">
        <CardTitle />
      </div>
      <SkeletonRegion testId="capital-back-skeleton">
        <SkeletonText size="xs" className="w-36" />
        <SkeletonText size="lg" className="w-20" />
        <SkeletonText size="xs" className="w-56 max-w-full" />
        <div className="mt-4 divide-y divide-border">
          {repeat(3, (i) => (
            <div key={i} data-testid="skeleton-row" className="py-2">
              <SkeletonText className="w-32" />
              <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                {repeat(4, (j) => (
                  <div key={j}>
                    <SkeletonText size="xs" className="w-16" />
                    <SkeletonText className="w-20" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </SkeletonRegion>
    </section>
  );
}
