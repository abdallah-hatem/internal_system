'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useCan } from '@/lib/can';
import { useAllRecords } from '@/lib/list-all';
import { useDateFormat } from '@/lib/dates';
import { Money } from '@/components/ui/money';
import { ArrowDownRight, Plus, RotateCcw } from '@/components/ui/icons';
import { SkeletonGroup, SkeletonText, Skeleton, repeat } from '@/components/ui/skeleton';
import {
  RecordAdvanceDialog,
  ReverseMovementDialog,
  WithdrawDialog,
  type AccountMovement,
  type PartnerAccount,
} from './account-dialogs';

/**
 * Each core partner's running account on the Partners page (BUSINESS_LOGIC §8,
 * owner 2026-10-25): his balance — read from the server, whose one definition
 * the cycle panel and settlement read too — what made it, and his entries,
 * newest first. Record a payment, take money out, reverse an entry.
 */

/** Cycles that can still take an advance — the server's CLOSED_FOR_ACCOUNTS, mirrored for the picker only. */
export const CLOSED_FOR_ACCOUNTS = ['SETTLEMENT', 'CLOSED', 'CANCELLED'];

/** Entries a card shows before "All N entries". */
const FIRST_ENTRIES = 5;

const KIND_STYLE: Record<AccountMovement['kind'], string> = {
  ADVANCE: 'bg-success/10 text-success',
  CONTRIBUTION: 'bg-primary-100 text-primary-700',
  WITHDRAWAL: 'bg-accent-100 text-accent-800',
  PAYOUT_LEFT_IN: 'bg-secondary text-secondary-foreground',
  EXPENSE_PAID: 'bg-success/10 text-success',
};

export function PartnerAccountsSection() {
  const t = useTranslations('accounts');
  const canRead = useCan('partnerAccount.read');
  const canAdvance = useCan('partnerAccount.advance');
  const { data, isLoading } = useQuery<PartnerAccount[]>({
    queryKey: ['partner-accounts'],
    queryFn: () => api.get('/partner-accounts').then((r) => r.data.data ?? r.data),
    enabled: canRead,
  });
  const { items: cycles } = useAllRecords(['cycles'], '/cycles', undefined, { enabled: canAdvance });
  const openCycles = (cycles as { id: string; code: string; currency: string; status: string }[])
    .filter((c) => !CLOSED_FOR_ACCOUNTS.includes(c.status));
  const [advanceFor, setAdvanceFor] = useState<string | null>(null);
  const [withdrawFrom, setWithdrawFrom] = useState<PartnerAccount | null>(null);
  const [reversing, setReversing] = useState<{ partnerUserId: string; movementId: string } | null>(null);

  if (!canRead) return null;
  const accounts = data ?? [];

  return (
    <section data-testid="partner-accounts" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('hint')}</p>
      </div>
      {isLoading ? (
        <SkeletonGroup className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {repeat(3, (i) => (
            <div key={i} data-testid="skeleton-row" className="rounded-xl border border-border bg-card p-5">
              <div className="mb-4 flex items-start justify-between">
                <SkeletonText size="base" className="w-28" />
                <SkeletonText size="xl" className="w-32" />
              </div>
              <Skeleton className="h-16 w-full rounded-lg" />
            </div>
          ))}
        </SkeletonGroup>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noAccounts')}</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {accounts.map((a) => (
            <AccountCard
              key={a.partnerUserId}
              account={a}
              onAdvance={() => setAdvanceFor(a.partnerUserId)}
              onWithdraw={() => setWithdrawFrom(a)}
              onReverse={(movementId) => setReversing({ partnerUserId: a.partnerUserId, movementId })}
            />
          ))}
        </div>
      )}

      {advanceFor && (
        <RecordAdvanceDialog
          partners={accounts.filter((a) => a.active).map((a) => ({ partnerUserId: a.partnerUserId, name: a.name }))}
          partnerUserId={advanceFor}
          cycles={openCycles}
          onClose={() => setAdvanceFor(null)}
        />
      )}
      {withdrawFrom && <WithdrawDialog account={withdrawFrom} onClose={() => setWithdrawFrom(null)} />}
      {reversing && (
        <ReverseMovementDialog
          partnerUserId={reversing.partnerUserId}
          movementId={reversing.movementId}
          onClose={() => setReversing(null)}
        />
      )}
    </section>
  );
}

function AccountCard({
  account: a,
  onAdvance,
  onWithdraw,
  onReverse,
}: {
  account: PartnerAccount;
  onAdvance: () => void;
  onWithdraw: () => void;
  onReverse: (movementId: string) => void;
}) {
  const t = useTranslations('accounts');
  const locale = useLocale();
  const { formatDate } = useDateFormat();
  const canAdvance = useCan('partnerAccount.advance');
  const canWithdraw = useCan('partnerAccount.withdraw');
  const canReverse = useCan('partnerAccount.reverse');
  const [all, setAll] = useState(false);
  const shown = all ? a.movements : a.movements.slice(0, FIRST_ENTRIES);
  const balance = Number(a.balanceEgp);

  return (
    <div data-testid="partner-account" data-email={a.email} className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-10 w-10 shrink-0 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center text-sm font-bold">
            {a.name?.[0] ?? '?'}
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{a.name}</p>
            <p className="truncate text-xs text-muted-foreground">{a.email}</p>
          </div>
        </div>
        <div className="text-end">
          <p className="text-[11px] text-muted-foreground">{t('balance')}</p>
          <p data-testid="account-balance" className={`text-xl font-bold whitespace-nowrap tabular-nums ${balance > 0 ? 'text-success' : 'text-muted-foreground'}`}>
            <Money value={a.balanceEgp} />
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Figure label={t('advanced')} value={a.advancedEgp} tone="text-foreground" />
        <Figure label={t('leftIn')} value={a.leftInEgp} tone="text-primary-700" />
        <Figure label={t('contributedTotal')} value={a.contributedEgp} tone="text-primary-600" />
        <Figure label={t('withdrawn')} value={a.withdrawnEgp} tone="text-accent-700" />
        {Number(a.expensesPaidEgp ?? 0) > 0 && (
          <Figure label={t('expensesPaid')} value={a.expensesPaidEgp!} tone="text-foreground" />
        )}
      </div>

      {/* The balance by pot (owner 2026-10-26, "each cycle has its own
          funding"): what any cycle can draw, and what only one cycle can. */}
      {(a.byCycle ?? []).length > 0 && (
        <p data-testid="account-pots" className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t('untiedPot')}: <span className="tabular-nums text-foreground"><Money value={a.untiedEgp} /></span>
          </span>
          {a.byCycle.map((c) => (
            <span key={c.cycleId} data-testid="account-pot">
              {t('cyclePot', { cycle: c.cycleCode })}:{' '}
              <span className="tabular-nums text-foreground"><Money value={c.amountEgp} /></span>
            </span>
          ))}
        </p>
      )}

      {a.movements.length === 0 ? (
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">{t('noMovements')}</p>
      ) : (
        <ul className="border-t border-border pt-3 space-y-1.5">
          {shown.map((m) => {
            const reversed = !!m.reversedAt;
            const signed = Number(m.signedEgp);
            return (
              <li key={m.id} data-testid="account-movement" data-kind={m.kind} className="flex items-center justify-between gap-3 text-xs">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="whitespace-nowrap text-muted-foreground">{formatDate(m.occurredOn)}</span>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_STYLE[m.kind]}`}>
                    {t(`kind.${m.kind}`)}
                  </span>
                  {m.cycleId && m.cycleCode && (
                    <Link href={`/${locale}/cycles/${m.cycleId}/details`} className="font-mono whitespace-nowrap text-primary-600 hover:underline">
                      {m.cycleCode}
                    </Link>
                  )}
                  {m.currency !== 'EGP' && (
                    <span className="whitespace-nowrap text-muted-foreground">
                      <Money value={m.amount} currency={m.currency} /> <bdi dir="ltr">@ {Number(m.fxRateToEgp)}</bdi>
                    </span>
                  )}
                  {m.note && <bdi className="truncate text-muted-foreground">{m.note}</bdi>}
                  {reversed && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground" title={m.reversalReason ?? undefined}>
                      {t('reversedTag')}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className={`tabular-nums ${reversed ? 'text-muted-foreground line-through' : signed > 0 ? 'text-success' : 'text-foreground'}`}>
                    <Money value={m.signedEgp} />
                  </span>
                  {canReverse && !reversed && m.kind !== 'PAYOUT_LEFT_IN' && m.kind !== 'EXPENSE_PAID' && (
                    <button
                      type="button"
                      onClick={() => onReverse(m.id)}
                      title={t('reverse')}
                      aria-label={t('reverse')}
                      data-testid="reverse-movement"
                      className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-border pt-3">
        {canAdvance && a.active && (
          <button type="button" onClick={onAdvance} data-testid="record-advance" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700">
            <Plus className="h-4 w-4" /> {t('recordPayment')}
          </button>
        )}
        {canWithdraw && (
          <button
            type="button"
            onClick={onWithdraw}
            disabled={balance <= 0}
            data-testid="withdraw"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <ArrowDownRight className="h-4 w-4" /> {t('takeOut')}
          </button>
        )}
        {a.movements.length > FIRST_ENTRIES && (
          <button type="button" onClick={() => setAll((v) => !v)} className="ms-auto text-sm font-medium text-muted-foreground hover:text-foreground">
            {all ? t('showFewer') : t('showAll', { count: a.movements.length })}
          </button>
        )}
      </div>
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone: string }) {
  const zero = Number(value) === 0;
  return (
    <div>
      <p className="text-[11px] text-muted-foreground mb-0.5">{label}</p>
      <p className={`text-sm font-semibold whitespace-nowrap ${zero ? 'text-muted-foreground' : tone}`}>
        <Money value={value} />
      </p>
    </div>
  );
}
