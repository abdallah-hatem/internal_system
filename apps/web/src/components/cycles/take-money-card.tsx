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
 * "Take money from this cycle" / «سحب أموال من هذه الدورة» (BUSINESS_LOGIC §8,
 * owner 2026-11-10) — the one card that replaced "Profit taken" and "Capital
 * back early". The rules and the records stay two: profit taken is a core
 * partner's share of the profit customers have paid for; capital taken back is
 * anyone's part of the goods' cost they have paid for. One take uses profit
 * first, then capital (the order a GUESS, api `common/take-money.ts`), and the
 * server records both parts in one transaction (`POST /cycles/:id/take`).
 *
 * Every figure — each room, the lock — is the server's (`GET /cycles/:id/take`).
 * The dialog's split and limit are only to say so sooner; the server decides.
 */

export interface TakeProfitRoom {
  sharePct: string | null;
  shareOfCollectedEgp: string;
  takenEgp: string;
  owedEgp: string;
  availableEgp: string;
}

export interface TakeCapitalRoom {
  contributionEgp: string;
  recoveredEgp: string;
  takenEgp: string;
  availableEgp: string;
}

export interface TakePerson {
  userId: string;
  name: string;
  participantType: string;
  /** Null for someone with no share of profit to take (an investor). */
  profit: TakeProfitRoom | null;
  capital: TakeCapitalRoom;
  /** Profit and capital he may take now, together. */
  availableEgp: string;
}

export type TakenKind = 'PROFIT' | 'CAPITAL';

export interface Taken {
  id: string;
  kind: TakenKind;
  userId: string;
  name: string;
  amountEgp: string;
  takenOn: string;
  note: string | null;
  createdAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
  /** Taken off a paid settlement: only reversing that settlement undoes it. */
  settled: boolean;
}

export interface TakeMoneyView {
  cycleId: string;
  cycleCode: string;
  /** Why nothing can be taken or undone now (a settlement's state or the cycle's status), or null. */
  locked: string | null;
  /** No split to take profit by: CYCLE_NOT_FUNDED, PARTIAL_CUSTOM_SPLIT, SPLIT_NOT_100. */
  problem: string | null;
  profitEgp: string | null;
  sharePaidPct: string;
  collectedProfitEgp: string;
  toFundEgp: string;
  recoveredEgp: string;
  recoveredPct: string;
  people: TakePerson[];
  taken: Taken[];
}

const num = (v: unknown) => Number(v ?? 0);
/** To the piastre, so 0.1 + 0.2 never reads as more than 0.3. */
const piastres = (v: unknown) => Math.round(num(v) * 100);

/**
 * The server's cut (api `splitTake`), in piastres: his profit room first, the
 * rest from capital; null when the two together are less than the amount.
 * A unit test pins it to the server's on the same cases.
 */
export function splitTake(amount: number, profitRoom: number, capitalRoom: number) {
  const p = Math.max(profitRoom, 0);
  const c = Math.max(capitalRoom, 0);
  if (!(amount > 0) || amount > p + c) return null;
  const profit = Math.min(amount, p);
  return { profit, capital: amount - profit };
}

const inputClass =
  'w-full rounded-lg border border-border bg-card px-3 py-2 text-start text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-primary-500';
const primaryButton =
  'inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0';
const linkButton =
  'inline-flex min-h-11 cursor-pointer items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0';

/** Everything a take or an undo moves: this card, the cycle's money, cash, the ledger, a settlement being worked out. */
export function useRefreshTaken(cycleId: string) {
  const qc = useQueryClient();
  return () => {
    for (const queryKey of [
      ['take-money', cycleId],
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

export function TakeMoneyCard({ cycleId }: { cycleId: string }) {
  const t = useTranslations('takeMoney');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const { user } = useAuth();
  const canRead = useCan('takeMoney.read');
  const canTake = useCan('takeMoney.take');
  const canReverse = useCan('profitDraw.reverse');
  const [taking, setTaking] = useState(false);
  const [undoing, setUndoing] = useState<Taken | null>(null);

  const query = useQuery<TakeMoneyView>({
    queryKey: ['take-money', cycleId],
    queryFn: () => api.get(`/cycles/${cycleId}/take`).then((r) => r.data.data ?? r.data),
    enabled: canRead,
  });

  if (!canRead) return null;
  if (query.isLoading) return <TakeMoneyCardSkeleton />;
  const data = query.data;
  if (query.isError || !data || !Array.isArray(data.people) || !Array.isArray(data.taken)) {
    return (
      <section data-testid="take-money-error" className="rounded-xl border border-border bg-card p-5">
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
  // He takes for himself by default, when he is on this cycle.
  const me = data.people.some((p) => p.userId === user?.id) ? user?.id : undefined;
  const pct = (v: string) => <bdi dir="ltr">{formatNumber(num(v), { maximumFractionDigits: 2 })}</bdi>;

  return (
    <section data-testid="take-money-card" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <CardTitle />
        {mayTake && (
          <button type="button" data-testid="take-money" onClick={() => setTaking(true)} className={primaryButton}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('take')}
          </button>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('intro')}</p>

      {locked && (
        <p data-testid="take-money-locked" className="mb-3 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          {t('locked', { reason: codeLabel('profitDrawLock', locked) })}
        </p>
      )}
      {data.problem && (
        <p data-testid="take-money-problem" className="mb-3 flex items-start gap-2 rounded-lg border border-accent-200 bg-accent-50 px-3 py-2 text-sm text-accent-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('problem')}
        </p>
      )}

      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t('collected')}</p>
          <p data-testid="take-money-collected" className="text-lg font-bold text-foreground">
            <Money value={data.collectedProfitEgp} />
          </p>
          <p className="text-xs text-muted-foreground">{t('collectedHint')}</p>
          {data.profitEgp !== null && (
            <p className="text-xs text-muted-foreground">
              {t.rich('profitSoFar', { amount: () => <Money value={data.profitEgp} />, pct: () => pct(data.sharePaidPct) })}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{t('recovered')}</p>
          <p data-testid="take-money-recovered" className="text-lg font-bold text-foreground">
            <bdi dir="ltr">{formatNumber(num(data.recoveredPct), { maximumFractionDigits: 2 })}%</bdi>
          </p>
          <p className="text-xs text-muted-foreground">
            {t.rich('recoveredHint', {
              amount: () => <Money value={data.recoveredEgp} />,
              total: () => <Money value={data.toFundEgp} />,
            })}
          </p>
        </div>
      </div>

      {data.people.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('noPeople')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {data.people.map((p) => (
            <li key={p.userId} data-testid="take-person" data-person={p.userId} className="py-2">
              <p className="min-w-0 break-words font-medium text-foreground [overflow-wrap:anywhere]">
                <bdi>{p.name}</bdi>
                {p.participantType === 'TEMP_INVESTOR' && (
                  <span className="ms-2 inline-block whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-normal text-primary">{t('investor')}</span>
                )}
                {p.profit?.sharePct != null && (
                  <span className="ms-2 text-xs font-normal text-muted-foreground">
                    {t('sharePct', { pct: formatNumber(num(p.profit.sharePct), { maximumFractionDigits: 2 }) })}
                  </span>
                )}
              </p>
              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{t('colProfit')}</dt>
                  <dd data-testid="take-profit-room" className="whitespace-nowrap tabular-nums text-foreground">
                    {p.profit ? <Money value={p.profit.availableEgp} /> : <span className="text-xs text-muted-foreground">{t('noProfitShare')}</span>}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{t('colCapital')}</dt>
                  <dd data-testid="take-capital-room" className="whitespace-nowrap tabular-nums text-foreground">
                    <Money value={p.capital.availableEgp} />
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{t('colTaken')}</dt>
                  <dd data-testid="take-taken" className="text-xs tabular-nums text-muted-foreground">
                    {p.profit && (
                      <span className="block whitespace-nowrap">{t.rich('takenProfit', { amount: () => <Money value={p.profit!.takenEgp} /> })}</span>
                    )}
                    <span className="block whitespace-nowrap">{t.rich('takenCapital', { amount: () => <Money value={p.capital.takenEgp} /> })}</span>
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{t('colTotal')}</dt>
                  <dd data-testid="take-total" className="whitespace-nowrap font-semibold tabular-nums text-foreground">
                    <Money value={p.availableEgp} />
                  </dd>
                </div>
              </dl>
              {p.profit && num(p.profit.owedEgp) > 0 && (
                <p data-testid="take-owes" className="mt-1 text-xs text-destructive">
                  {t.rich('owes', { amount: () => <Money value={p.profit!.owedEgp} /> })}
                </p>
              )}
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
              <li key={d.id} data-testid="taken-row" data-taken={d.id} data-kind={d.kind} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-foreground [overflow-wrap:anywhere]">
                    <bdi>{d.name}</bdi>
                    <span
                      data-testid="taken-kind"
                      className={cn(
                        'ms-2 inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] [overflow-wrap:normal]',
                        d.kind === 'PROFIT' ? 'bg-success/10 text-success' : 'bg-primary/10 text-primary',
                      )}
                    >
                      {t(`kind${d.kind}`)}
                    </span>
                    <span className="ms-2 whitespace-nowrap text-xs text-muted-foreground">{formatDate(d.takenOn)}</span>
                  </p>
                  {d.note && <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]"><bdi>{d.note}</bdi></p>}
                  {d.reversedAt && (
                    <p data-testid="taken-reversed" className="text-xs text-muted-foreground">
                      {d.reversalReason ? t('reversedReason', { reason: d.reversalReason }) : t('reversed')}
                    </p>
                  )}
                  {d.settled && !d.reversedAt && (
                    <p data-testid="taken-settled" className="text-xs text-muted-foreground">{t(`settled${d.kind}`)}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className={cn('whitespace-nowrap tabular-nums', d.reversedAt ? 'text-muted-foreground line-through' : 'text-foreground')}>
                    <Money value={d.amountEgp} />
                  </span>
                  {standing && canReverse && !locked && (
                    <button type="button" data-testid="undo-taken" onClick={() => setUndoing(d)} className={linkButton}>
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

      {taking && <TakeMoneyDialog cycleId={cycleId} people={data.people} defaultPerson={me} onClose={() => setTaking(false)} />}
      {undoing && <UndoTakenDialog cycleId={cycleId} taken={undoing} onClose={() => setUndoing(null)} />}
    </section>
  );
}

function CardTitle() {
  const t = useTranslations('takeMoney');
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
      <HandCoins className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      {t('title')}
    </h2>
  );
}

/** One take: pick who, an amount up to his total; the split is shown before Take is pressed. */
export function TakeMoneyDialog({
  cycleId,
  people,
  defaultPerson,
  onClose,
}: {
  cycleId: string;
  people: TakePerson[];
  /** The signed-in partner, when he is on this cycle. */
  defaultPerson?: string;
  onClose: () => void;
}) {
  const t = useTranslations('takeMoney');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const { formatMoney } = useNumberFormat();
  const { addToast } = useToast();
  const refresh = useRefreshTaken(cycleId);
  const [who, setWho] = useState(defaultPerson ?? '');
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = people.find((p) => p.userId === who);
  // A second press before the first re-renders the button disabled must not send twice.
  const sending = useRef(false);
  const profitRoom = piastres(chosen?.profit?.availableEgp);
  const capitalRoom = piastres(chosen?.capital.availableEgp);
  const total = piastres(chosen?.availableEgp);
  const asked = piastres(amount);
  const split = chosen ? splitTake(asked, profitRoom, capitalRoom) : null;

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/cycles/${cycleId}/take`, body),
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

  const profitPart = (v: number) => <Money value={v / 100} />;

  return (
    <Dialog
      title={t('takeTitle')}
      description={t('takeHint')}
      onClose={onClose}
      busy={save.isPending}
      cardProps={{ 'data-testid': 'take-money-dialog' }}
      footer={<FormActions form="take-money-form" onCancel={onClose} cancelLabel={tc('cancel')} submitLabel={t('take')} busy={save.isPending} />}
    >
      <ValidatedForm
        id="take-money-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!chosen || sending.current) return;
          if (!(asked > 0)) return setProblem(t('notPositive'));
          if (asked > total) {
            return setProblem(
              total <= 0
                ? t('nothingAvailable', { name: chosen.name })
                : t('overAvailable', { name: chosen.name, max: formatMoney(total / 100) }),
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
        <DialogAlert message={problem} testId="take-money-problem" />
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
        {chosen && (
          <p data-testid="take-rooms" className="-mt-2 text-xs text-muted-foreground">
            {t.rich('rooms', { profit: () => profitPart(profitRoom), capital: () => profitPart(capitalRoom) })}
          </p>
        )}
        <div>
          <label htmlFor="take-money-amount" className="mb-1 block text-sm font-medium text-foreground">
            {t('amount')}
            <span aria-hidden="true" className="ms-1 text-destructive">*</span>
          </label>
          <MoneyInput
            id="take-money-amount"
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
              <span data-testid="take-money-max">{t.rich('max', { amount: () => <Money value={chosen.availableEgp} /> })}</span>
              {total > 0 && (
                <button
                  type="button"
                  data-testid="take-all"
                  onClick={() => {
                    setAmount(String(total / 100));
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
        {split && (
          <div data-testid="take-split" className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
            <span className="text-xs text-muted-foreground">{t('splitLabel')}</span>
            <p className="font-medium tabular-nums text-foreground">
              {split.profit > 0 && split.capital > 0
                ? t.rich('splitBoth', { profit: () => profitPart(split.profit), capital: () => profitPart(split.capital) })
                : split.profit > 0
                  ? t.rich('splitProfit', { profit: () => profitPart(split.profit) })
                  : t.rich('splitCapital', { capital: () => profitPart(split.capital) })}
            </p>
          </div>
        )}
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

/** Undo one part taken — profit or capital — once, with a reason. Both go through the same endpoint. */
export function UndoTakenDialog({ cycleId, taken, onClose }: { cycleId: string; taken: Taken; onClose: () => void }) {
  const t = useTranslations('takeMoney');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const { formatDate } = useDateFormat();
  const { addToast } = useToast();
  const refresh = useRefreshTaken(cycleId);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);

  const run = useMutation({
    mutationFn: () => api.post(`/profit-draws/${taken.id}/reverse`, { reason: reason.trim() }),
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
      title={t(`undoTitle${taken.kind}`)}
      description={t.rich('undoHint', {
        amount: () => <Money value={taken.amountEgp} />,
        name: taken.name,
        day: formatDate(taken.takenOn),
      })}
      onClose={onClose}
      busy={run.isPending}
      cardProps={{ 'data-testid': 'undo-taken-dialog' }}
      footer={
        <FormActions
          form="undo-taken-form"
          onCancel={onClose}
          cancelLabel={tc('cancel')}
          submitLabel={t('undo')}
          busy={run.isPending}
          disabled={!reason.trim()}
        />
      }
    >
      <ValidatedForm
        id="undo-taken-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!reason.trim() || sending.current) return;
          sending.current = true;
          run.mutate();
        }}
      >
        <DialogAlert message={problem} testId="undo-taken-problem" />
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

/** The card above while it loads: the title, the two figures and three people's rows. */
export function TakeMoneyCardSkeleton() {
  return (
    <section data-testid="take-money-loading" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3">
        <CardTitle />
      </div>
      <SkeletonRegion testId="take-money-skeleton">
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {repeat(2, (i) => (
            <div key={i}>
              <SkeletonText size="xs" className="w-32" />
              <SkeletonText size="lg" className="w-28" />
              <SkeletonText size="xs" className="w-56 max-w-full" />
            </div>
          ))}
        </div>
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
