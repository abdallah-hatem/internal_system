'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { AlertTriangle, HandCoins, Plus, Undo2 } from '@/components/ui/icons';

/**
 * Profit a core partner takes before his cycle is settled (BUSINESS_LOGIC §8,
 * owner 2026-11-08) — "Profit taken" / «أرباح مسحوبة».
 *
 * Cash on hand goes down; the cycle's profit does not change. He may take his
 * share of the profit already collected from customers, less what he already
 * took, less anything he still owes from an earlier payout. Settlement takes
 * it off his payout. Any core partner records it for any core partner, and it
 * can be undone, with a reason, until the settlement is approved.
 *
 * Every figure — the collected profit, each partner's room, the lock — is the
 * server's (`GET /cycles/:id/profit-draws`). The form checks the limit it was
 * shown only to say so sooner; the server decides, and its refusal is shown.
 */

export interface ProfitDrawPartner {
  partnerUserId: string;
  name: string;
  sharePct: string | null;
  shareOfCollectedEgp: string;
  drawnEgp: string;
  owedEgp: string;
  availableEgp: string;
}

export interface ProfitDraw {
  id: string;
  partnerUserId: string;
  name: string;
  amountEgp: string;
  drawnOn: string;
  note: string | null;
  createdAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
  /** Taken off a settlement's payout: only reversing that settlement undoes it. */
  settled: boolean;
}

export interface ProfitDrawsView {
  cycleId: string;
  cycleCode: string;
  /** Why nothing can be taken or undone now (a settlement's state or the cycle's status), or null. */
  locked: string | null;
  profitEgp: string | null;
  uncollectedEgp: string;
  /** The share of its sales paid, in percent (the share of its profit collected). */
  sharePaidPct: string;
  salesEgp: string;
  salesPaidEgp: string;
  collectedProfitEgp: string;
  /** No split to take a share of: CYCLE_NOT_FUNDED, PARTIAL_CUSTOM_SPLIT, SPLIT_NOT_100. */
  problem: string | null;
  partners: ProfitDrawPartner[];
  draws: ProfitDraw[];
}

const num = (v: unknown) => Number(v ?? 0);
/** To the piastre, so 0.1 + 0.2 never reads as more than 0.3. */
const piastres = (v: unknown) => Math.round(num(v) * 100);

const inputClass =
  'w-full rounded-lg border border-border bg-card px-3 py-2 text-start text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-primary-500';
const primaryButton =
  'inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0';
const linkButton =
  'inline-flex min-h-11 cursor-pointer items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0';

/** Everything a draw moves: this card, the cycle's money, cash, the ledger, a settlement being worked out. */
function useRefreshDraws(cycleId: string) {
  const qc = useQueryClient();
  return () => {
    for (const queryKey of [
      ['profit-draws', cycleId],
      ['cycle', cycleId],
      ['cycles'],
      ['landedCost', cycleId],
      ['analytics'],
      ['ledger'],
      ['settlements'],
      ['partner-accounts'],
    ]) {
      void qc.invalidateQueries({ queryKey });
    }
  };
}

export function ProfitDrawsCard({ cycleId }: { cycleId: string }) {
  const t = useTranslations('profitDraws');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const { user } = useAuth();
  const canRead = useCan('profitDraw.read');
  const canTake = useCan('profitDraw.take');
  const canReverse = useCan('profitDraw.reverse');
  const [taking, setTaking] = useState(false);
  const [undoing, setUndoing] = useState<ProfitDraw | null>(null);

  const query = useQuery<ProfitDrawsView>({
    queryKey: ['profit-draws', cycleId],
    queryFn: () => api.get(`/cycles/${cycleId}/profit-draws`).then((r) => r.data.data ?? r.data),
    enabled: canRead,
  });

  if (!canRead) return null;
  if (query.isLoading) return <ProfitDrawsCardSkeleton />;
  const data = query.data;
  if (query.isError || !data || !Array.isArray(data.partners) || !Array.isArray(data.draws)) {
    return (
      <section data-testid="profit-draws-error" className="rounded-xl border border-border bg-card p-5">
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
  const lockedReason = locked ? t('locked', { reason: codeLabel('profitDrawLock', locked) }) : null;
  const mayTake = canTake && !locked && !data.problem && data.partners.length > 0;
  // He takes for himself by default, when he is on this cycle.
  const me = data.partners.some((p) => p.partnerUserId === user?.id) ? user?.id : undefined;

  return (
    <section data-testid="profit-draws-card" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <CardTitle />
        {mayTake && (
          <button type="button" data-testid="take-profit" onClick={() => setTaking(true)} className={primaryButton}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('take')}
          </button>
        )}
      </div>

      {lockedReason && (
        <p data-testid="profit-draws-locked" className="mb-3 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          {lockedReason}
        </p>
      )}
      {data.problem && (
        <p data-testid="profit-draws-problem" className="mb-3 flex items-start gap-2 rounded-lg border border-accent-200 bg-accent-50 px-3 py-2 text-sm text-accent-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('problem')}
        </p>
      )}

      <div>
        <p className="text-xs text-muted-foreground">{t('collected')}</p>
        <p data-testid="profit-draws-collected" className="text-lg font-bold text-foreground">
          <Money value={data.collectedProfitEgp} />
        </p>
        <p className="text-xs text-muted-foreground">{t('collectedHint')}</p>
        {data.profitEgp !== null && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t.rich('profitSoFar', {
              amount: () => <Money value={data.profitEgp} />,
              pct: () => (
                <bdi dir="ltr">
                  {formatNumber(num(data.sharePaidPct), { maximumFractionDigits: 2 })}
                </bdi>
              ),
            })}
          </p>
        )}
      </div>

      {data.partners.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('noPartners')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {data.partners.map((p) => (
            <li key={p.partnerUserId} data-testid="profit-draw-partner" data-partner={p.partnerUserId} className="py-2">
              <p className="min-w-0 break-words font-medium text-foreground [overflow-wrap:anywhere]">
                <bdi>{p.name}</bdi>
                {p.sharePct !== null && (
                  <span className="ms-2 text-xs font-normal text-muted-foreground">
                    <bdi dir="ltr">{t('sharePct', { pct: formatNumber(num(p.sharePct), { maximumFractionDigits: 2 }) })}</bdi>
                  </span>
                )}
              </p>
              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                <Figure label={t('colShare')} value={p.shareOfCollectedEgp} testId="share" />
                <Figure label={t('colTaken')} value={p.drawnEgp} testId="taken" />
                {num(p.owedEgp) > 0 && <Figure label={t('colOwes')} value={p.owedEgp} testId="owes" tone="text-destructive" />}
                <Figure label={t('colAvailable')} value={p.availableEgp} testId="available" tone="font-semibold text-foreground" />
              </dl>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-4 mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('historyHeading')}</h3>
      {data.draws.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noDraws')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.draws.map((d) => {
            const standing = !d.reversedAt && !d.settled;
            return (
              <li key={d.id} data-testid="profit-draw" data-draw={d.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-foreground [overflow-wrap:anywhere]">
                    <bdi>{d.name}</bdi>
                    <span className="ms-2 text-xs text-muted-foreground">{formatDate(d.drawnOn)}</span>
                  </p>
                  {d.note && <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]"><bdi>{d.note}</bdi></p>}
                  {d.reversedAt && (
                    <p data-testid="draw-reversed" className="text-xs text-muted-foreground">
                      {d.reversalReason ? t('reversedReason', { reason: d.reversalReason }) : t('reversed')}
                    </p>
                  )}
                  {d.settled && !d.reversedAt && (
                    <p data-testid="draw-settled" className="text-xs text-muted-foreground">{t('settled')}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className={cn('whitespace-nowrap tabular-nums', d.reversedAt ? 'text-muted-foreground line-through' : 'text-foreground')}>
                    <Money value={d.amountEgp} />
                  </span>
                  {standing && canReverse && !locked && (
                    <button type="button" data-testid="undo-draw" onClick={() => setUndoing(d)} className={linkButton}>
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
        <TakeProfitDialog cycleId={cycleId} partners={data.partners} defaultPartner={me} onClose={() => setTaking(false)} />
      )}
      {undoing && <UndoDrawDialog cycleId={cycleId} draw={undoing} onClose={() => setUndoing(null)} />}
    </section>
  );
}

function Figure({ label, value, testId, tone = 'text-foreground' }: { label: string; value: string; testId: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd data-testid={`draw-${testId}`} className={cn('whitespace-nowrap tabular-nums', tone)}>
        <Money value={value} />
      </dd>
    </div>
  );
}

function CardTitle() {
  const t = useTranslations('profitDraws');
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
      <HandCoins className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      {t('title')}
    </h2>
  );
}

/** He takes part of his share of the profit collected so far. */
export function TakeProfitDialog({
  cycleId,
  partners,
  defaultPartner,
  onClose,
}: {
  cycleId: string;
  partners: ProfitDrawPartner[];
  /** The signed-in partner, when he is on this cycle. */
  defaultPartner?: string;
  onClose: () => void;
}) {
  const t = useTranslations('profitDraws');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const { formatMoney } = useNumberFormat();
  const { addToast } = useToast();
  const refresh = useRefreshDraws(cycleId);
  const [who, setWho] = useState(defaultPartner ?? '');
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = partners.find((p) => p.partnerUserId === who);
  // A second press before the first re-renders the button disabled must not send twice.
  const sending = useRef(false);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/cycles/${cycleId}/profit-draws`, body),
    onSettled: () => {
      sending.current = false;
    },
    onSuccess: () => {
      refresh();
      addToast(t('saved', { name: chosen?.name ?? '' }), 'success');
      onClose();
    },
    onError: (e) => {
      // The server's figures may have moved since the card was read.
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
      cardProps={{ 'data-testid': 'take-profit-dialog' }}
      footer={<FormActions form="take-profit-form" onCancel={onClose} cancelLabel={tc('cancel')} submitLabel={t('take')} busy={save.isPending} />}
    >
      <ValidatedForm
        id="take-profit-form"
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
            partnerUserId: chosen.partnerUserId,
            amountEgp: asked / 100,
            drawnOn: (fd.get('drawnOn') as string) || undefined,
            note: ((fd.get('note') as string) || '').trim() || undefined,
          });
        }}
      >
        <DialogAlert message={problem} testId="take-profit-problem" />
        <FieldLabel label={t('partner')} required>
          <Select
            name="partner"
            required
            value={who}
            onChange={(v) => {
              setWho(v);
              setProblem(null);
            }}
            placeholder={tph('choosePerson')}
            options={partners.map((p) => ({ value: p.partnerUserId, label: p.name }))}
          />
        </FieldLabel>
        <div>
          <label htmlFor="take-profit-amount" className="mb-1 block text-sm font-medium text-foreground">
            {t('amount')}
            <span aria-hidden="true" className="ms-1 text-destructive">*</span>
          </label>
          <MoneyInput
            id="take-profit-amount"
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
              <span data-testid="take-profit-max">{t.rich('max', { amount: () => <Money value={chosen.availableEgp} /> })}</span>
              {num(chosen.availableEgp) > 0 && (
                <button
                  type="button"
                  data-testid="take-all"
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
          <DatePicker name="drawnOn" required disableFuture defaultValue={businessToday()} />
        </FieldLabel>
        <FieldLabel label={t('note')}>
          <textarea name="note" rows={3} maxLength={500} placeholder={tph('profitDrawNote')} className={inputClass} />
        </FieldLabel>
      </ValidatedForm>
    </Dialog>
  );
}

/** Undo one draw, once, with a reason (§8, 2026-11-08). */
export function UndoDrawDialog({ cycleId, draw, onClose }: { cycleId: string; draw: ProfitDraw; onClose: () => void }) {
  const t = useTranslations('profitDraws');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const { formatDate } = useDateFormat();
  const { addToast } = useToast();
  const refresh = useRefreshDraws(cycleId);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);

  const run = useMutation({
    mutationFn: () => api.post(`/profit-draws/${draw.id}/reverse`, { reason: reason.trim() }),
    onSettled: () => {
      sending.current = false;
    },
    onSuccess: () => {
      refresh();
      addToast(t('undoSaved'), 'success');
      onClose();
    },
    onError: (e) => {
      refresh();
      setProblem(apiError(e, tc('operationFailed')));
    },
  });

  return (
    <Dialog
      size="sm"
      title={t('undoTitle')}
      description={t.rich('undoHint', {
        amount: () => <Money value={draw.amountEgp} />,
        name: draw.name,
        day: formatDate(draw.drawnOn),
      })}
      onClose={onClose}
      busy={run.isPending}
      cardProps={{ 'data-testid': 'undo-draw-dialog' }}
      footer={
        <FormActions
          form="undo-draw-form"
          onCancel={onClose}
          cancelLabel={tc('cancel')}
          submitLabel={t('undo')}
          busy={run.isPending}
          disabled={!reason.trim()}
        />
      }
    >
      <ValidatedForm
        id="undo-draw-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!reason.trim() || sending.current) return;
          sending.current = true;
          run.mutate();
        }}
      >
        <DialogAlert message={problem} testId="undo-draw-problem" />
        <FieldLabel label={t('reason')} required>
          <input
            name="reason"
            required
            maxLength={500}
            placeholder={tph('reverseReason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={inputClass}
          />
        </FieldLabel>
      </ValidatedForm>
    </Dialog>
  );
}

/** The card above while it loads: the title, the collected figure and three partners' rows. */
export function ProfitDrawsCardSkeleton() {
  return (
    <section data-testid="profit-draws-loading" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3">
        <CardTitle />
      </div>
      <SkeletonRegion testId="profit-draws-skeleton">
        <SkeletonText size="xs" className="w-36" />
        <SkeletonText size="lg" className="w-32" />
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
