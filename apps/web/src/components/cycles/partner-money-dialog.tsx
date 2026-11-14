'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDateFormat } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { Money } from '@/components/ui/money';
import { Dialog, DialogCancel } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRegion, repeat } from '@/components/ui/skeleton';
import { AlertTriangle, Wallet } from '@/components/ui/icons';
import type { AccountMovement } from '@/components/partners/account-dialogs';

/**
 * One partner's money in one cycle — the Funding card's Details (owner
 * 2026-11-14, from an approved mockup; BUSINESS_LOGIC §8). Every figure is
 * the server's (`GET /cycles/:id/partner-money/:partnerUserId`, read from the
 * pots in `common/partner-account.ts`); this only lays them out:
 *
 * 1. what he paid for this cycle — reversed rows struck through, not counted;
 * 2. the money tied to no cycle this cycle drew, or can still draw;
 * 3. total available, into the cycle's capital, left in his account — and,
 *    when part of his contribution was entered by hand, that part and the
 *    row's "Put in", so the totals explain the figure the link sat beside.
 */
export interface PartnerMoney {
  cycleId: string;
  cycleCode: string;
  partnerUserId: string;
  name: string;
  onCycle: boolean;
  forCycle: { movements: AccountMovement[]; totalEgp: string };
  untied: {
    shown: boolean;
    movements: AccountMovement[];
    netEgp: string;
    drawnHereEgp: string;
    otherCyclesEgp: string;
    stillUntiedEgp: string;
    totalEgp: string;
  };
  totals: {
    availableEgp: string;
    intoCapitalEgp: string;
    leftEgp: string;
    leftForCycleEgp: string;
    leftUntiedEgp: string;
    enteredEgp: string;
    putInEgp: string;
  };
}

const num = (v: unknown) => Number(v ?? 0);

export function partnerMoneyKey(cycleId: string, partnerUserId: string) {
  return ['partner-money', cycleId, partnerUserId] as const;
}

export function PartnerMoneyDialog({
  cycleId,
  cycleCode,
  partnerUserId,
  name,
  onClose,
}: {
  cycleId: string;
  cycleCode: string;
  partnerUserId: string;
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations('fundingCard.details');
  const tc = useTranslations('common');
  const money = useQuery<PartnerMoney>({
    queryKey: partnerMoneyKey(cycleId, partnerUserId),
    queryFn: () => api.get(`/cycles/${cycleId}/partner-money/${partnerUserId}`).then((r) => r.data.data ?? r.data),
  });
  const d = money.data;

  return (
    <Dialog
      size="md"
      data-testid="partner-money-dialog"
      title={t.rich('title', {
        name: () => <bdi>{name}</bdi>,
        // A code never breaks at its hyphens: "CYC-2026-" over "0002" at 390.
        cycle: () => <bdi dir="ltr" className="whitespace-nowrap">{cycleCode}</bdi>,
      })}
      description={t('subtitle')}
      onClose={onClose}
      footer={<DialogCancel onClick={onClose} label={tc('close')} />}
    >
      {money.isLoading ? (
        <MoneySkeleton />
      ) : money.isError || !d ? (
        <EmptyState
          size="compact"
          icon={AlertTriangle}
          title={t('loadFailed')}
          action={{ label: t('retry'), onClick: () => void money.refetch() }}
          className="text-destructive"
        />
      ) : (
        <Body d={d} />
      )}
    </Dialog>
  );
}

function Body({ d }: { d: PartnerMoney }) {
  const t = useTranslations('fundingCard.details');
  const nothing =
    d.forCycle.movements.length === 0 &&
    !d.untied.shown &&
    num(d.totals.intoCapitalEgp) === 0 &&
    num(d.totals.enteredEgp) === 0;
  if (nothing) {
    return <EmptyState size="compact" icon={Wallet} title={t('empty')} className="text-muted-foreground" />;
  }
  const entered = num(d.totals.enteredEgp) > 0;
  const bothLeft = num(d.totals.leftForCycleEgp) > 0 && num(d.totals.leftUntiedEgp) > 0;

  return (
    <div className="space-y-5 py-1">
      <section data-testid="money-for-cycle">
        <Heading total={d.forCycle.totalEgp}>{t('forCycle')}</Heading>
        {d.forCycle.movements.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{t('noneForCycle')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {d.forCycle.movements.map((m) => (
              <MovementRow key={m.id} m={m} value={m.amountEgp} />
            ))}
          </ul>
        )}
      </section>

      {d.untied.shown && (
        <section data-testid="money-untied">
          <Heading total={d.untied.totalEgp}>{t('untied')}</Heading>
          <ul className="divide-y divide-border">
            {d.untied.movements.map((m) => (
              <MovementRow key={m.id} m={m} value={m.signedEgp} />
            ))}
          </ul>
          <dl className="mt-1 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
            {num(d.untied.otherCyclesEgp) !== 0 && (
              <Line testId="untied-other" label={t('untiedOther')} value={-num(d.untied.otherCyclesEgp)} />
            )}
            {num(d.untied.drawnHereEgp) > 0 && (
              <Line
                testId="untied-drawn"
                label={t.rich('untiedDrawn', { cycle: () => <bdi dir="ltr">{d.cycleCode}</bdi> })}
                value={d.untied.drawnHereEgp}
              />
            )}
            {num(d.untied.stillUntiedEgp) > 0 && (
              <Line testId="untied-still" label={t('untiedStill')} value={d.untied.stillUntiedEgp} />
            )}
          </dl>
        </section>
      )}

      <dl data-testid="money-totals" className="space-y-1.5 rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
        <Line testId="money-available" label={t('total')} value={d.totals.availableEgp} />
        <Line testId="money-into-capital" label={t('intoCapital')} value={d.totals.intoCapitalEgp} />
        <div className="border-t border-border pt-1.5">
          <Line testId="money-left" label={t('left')} value={d.totals.leftEgp} strong />
          {bothLeft && (
            <p data-testid="money-left-split" className="text-xs text-muted-foreground">
              {t.rich('leftSplit', {
                own: () => <Money value={d.totals.leftForCycleEgp} />,
                untied: () => <Money value={d.totals.leftUntiedEgp} />,
              })}
            </p>
          )}
        </div>
        {entered && (
          <div className="space-y-1.5 border-t border-border pt-1.5">
            <Line testId="money-entered" label={t('entered')} hint={t('enteredHint')} value={d.totals.enteredEgp} />
            <Line testId="money-put-in" label={t('putIn')} value={d.totals.putInEgp} strong />
          </div>
        )}
      </dl>
    </div>
  );
}

function Heading({ children, total }: { children: ReactNode; total: string }) {
  return (
    <h3 className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <span>{children}</span>
      <Money value={total} className="shrink-0 text-sm font-semibold normal-case tracking-normal text-foreground tabular-nums" />
    </h3>
  );
}

function MovementRow({ m, value }: { m: AccountMovement; value: string }) {
  const ta = useTranslations('accounts');
  const { formatDate } = useDateFormat();
  const reversed = !!m.reversedAt;
  return (
    <li data-testid="money-movement" data-reversed={reversed || undefined} className="flex items-start gap-3 py-2 text-sm">
      {/* A column of its own from sm; on a phone a line above the label, so a note has the row's width. */}
      <span className="hidden w-[5.5rem] shrink-0 whitespace-nowrap text-xs leading-5 text-muted-foreground tabular-nums sm:block">
        {formatDate(m.occurredOn)}
      </span>
      <span className="min-w-0 flex-1">
        <span data-testid="money-movement-day" className="block text-xs text-muted-foreground tabular-nums sm:hidden">
          {formatDate(m.occurredOn)}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={cn('font-medium text-foreground', reversed && 'text-muted-foreground line-through')}>
            {ta(`kind.${m.kind}`)}
          </span>
          {m.currency !== 'EGP' && (
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              <Money value={m.amount} currency={m.currency} /> <bdi dir="ltr">@ {Number(m.fxRateToEgp)}</bdi>
            </span>
          )}
          {reversed && (
            <span
              data-testid="money-reversed-tag"
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
              title={m.reversalReason ?? undefined}
            >
              {ta('reversedTag')}
            </span>
          )}
        </span>
        {m.note && <bdi className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{m.note}</bdi>}
      </span>
      <Money
        value={value}
        className={cn('shrink-0 text-sm tabular-nums', reversed ? 'text-muted-foreground line-through' : 'text-foreground')}
      />
    </li>
  );
}

function Line({
  label,
  value,
  strong,
  hint,
  testId,
}: {
  label: ReactNode;
  value: string | number;
  strong?: boolean;
  hint?: string;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="flex items-baseline justify-between gap-3">
      <dt className={cn('min-w-0', strong ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
        {label}
        {hint && <span className="block text-[11px] font-normal text-muted-foreground">{hint}</span>}
      </dt>
      <dd className={cn('shrink-0 tabular-nums', strong ? 'font-semibold text-foreground' : 'text-foreground')}>
        <Money value={value} />
      </dd>
    </div>
  );
}

function MoneySkeleton() {
  return (
    <SkeletonRegion className="space-y-5 py-1">
      {repeat(2, (s) => (
        <div key={s} className="space-y-2">
          <Skeleton className="h-4 w-40" />
          {repeat(2, (i) => (
            <div key={i} className="flex items-center gap-3 py-1">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      ))}
      <Skeleton className="h-20 w-full rounded-lg" />
    </SkeletonRegion>
  );
}
