'use client';

import { useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { useCodeLabel } from '@/lib/labels';
import { useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { useAllRecords } from '@/lib/list-all';
import { splitAcrossPartners } from '@/lib/funding-split';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { Money } from '@/components/ui/money';
import { MoneyInput } from '@/components/ui/money-input';
import { Dialog, DialogCancel, DialogPrimary } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';
import { AlertTriangle, Loader2, PencilLine, Plus, Scale, Wallet } from '@/components/ui/icons';
import {
  FundingTargetDialog,
  RecordAdvanceDialog,
  useRefreshAccounts,
  type AccountMovement,
} from '@/components/partners/account-dialogs';
import { AmountsForm } from '@/components/cycles/amounts-form';
import { AddParticipantForm, type ParticipantCandidate } from '@/components/cycles/add-participant-form';
import { FundingNote, lenderList, type FundingTotals } from '@/components/cycles/funding-note';

/**
 * The cycle page's money-in, in one card (BUSINESS_LOGIC §8, owner
 * 2026-10-26 from a rendered sample: "build it like this"). It replaced the
 * Participants card and the separate funding panel; every control in it is
 * one that already existed — this re-arranges them, it adds no money rule.
 *
 * Top to bottom:
 *
 * 1. **The target and put in so far** (owner 2026-10-26) — the target's
 *    progress, and per participant everything he has put into this cycle:
 *    his contribution plus his advances on it not yet drawn (`putIn`), what
 *    of it is capital, and how it came in — "repaid Ahmad Eraiby" for a
 *    contribution entered directly on a cycle a friend paid, "contributed"
 *    otherwise, "from his account", and an undrawn advance with its day;
 *    investors after the partners, "invested" (owner 2026-10-27); "Record
 *    what I paid".
 * 2. **Contributions** — each core partner's share: what he contributed when
 *    the partners' contributions make up their part ("as agreed", 2026-10-27),
 *    else an equal share (of the target, the cost to fund, or — on a cycle a
 *    friend paid, once he is repaid anything — what was repaid him or all
 *    that was put in: the server's `shares.basis`), what this cycle can draw
 *    for him, and "covered · N left over" or "N short".
 *    "Contribute equal thirds" draws from the accounts; "Enter amounts" and
 *    "Split equally" write contributions by hand, as before. Investors keep
 *    their own row. On a cycle with repayments to a friend, the exchange
 *    difference on them, as a cost (or a gain) taken from the profit, with
 *    each one's part by the profit split (`friends`).
 * 3. **The profit split and who is on the cycle** — "Change split" (the
 *    agreed percentages), "+ Add investor".
 *
 * Every figure is the server's (`GET /cycles/:id/account-funding`), one
 * definition each: put in by `putInSoFar`, shares by `contributionShares`,
 * the exchange difference by `exchangeDifferenceEgp` (the settlement's) and
 * its parts by `profitShareOf`, the split line from `profitSplitView`.
 */

export interface CardParticipant {
  id: string;
  participantType: string;
  contributionAmount: unknown;
  customProfitPct?: unknown;
  partner?: { email?: string; partner?: { displayName?: string } | null } | null;
  investor?: { email?: string; partner?: { displayName?: string } | null } | null;
}

export interface AccountFunding {
  cycleId: string;
  code: string;
  status: string;
  currency: string;
  fundingLock: string | null;
  closed: boolean;
  target: { amount: string; currency: string; fxRateToEgp: string; amountEgp: string } | null;
  /** Everything each partner has put into this cycle: contribution + undrawn advances (owner 2026-10-26). */
  putIn: {
    totalEgp: string;
    inTargetCurrency: string | null;
    /** The partners, then the investors, then anyone not on the cycle who paid for it (owner 2026-10-27). */
    byPartner: {
      partnerUserId: string;
      name: string;
      /** Null for someone not on the cycle who paid for it. */
      participantType?: 'CORE_PARTNER' | 'TEMP_INVESTOR' | null;
      totalEgp: string;
      inTargetCurrency: string | null;
      contributionEgp: string;
      enteredEgp: string;
      fromAccountEgp: string;
      undrawnAdvancesEgp: string;
      advances: AccountMovement[];
    }[];
  };
  /** Friends who paid the supplier (§18); null when none did. */
  friends: {
    names: string[];
    financedEgp: string;
    repaidEgp: string;
    /** + a cost (the rate rose since he paid), − a gain. */
    exchangeDifferenceEgp: string;
    exchangeSplit: { participantId: string; participantType: string; name: string; amountEgp: string }[] | null;
  } | null;
  paidSoFar: {
    totalEgp: string;
    inTargetCurrency: string | null;
    byPartner: {
      partnerUserId: string;
      name: string;
      totalEgp: string;
      inTargetCurrency: string | null;
      /** Of what he paid on this cycle, how much his contributions to it drew. */
      intoCapitalEgp: string;
      advances: AccountMovement[];
    }[];
  };
  partners: {
    partnerUserId: string;
    participantId: string;
    name: string;
    shareEgp: string;
    stillToGiveEgp: string;
    /** What this cycle can draw for him less what he still has to give: ≥ 0 covered, < 0 short. */
    coverEgp: string;
    availableEgp: string;
    ownAdvancesEgp: string;
    untiedEgp: string;
    elsewhereEgp: string;
    balanceEgp: string;
    contributionEgp: string;
    fromAccountEgp: string;
  }[];
  toFundEgp: string;
  investorsEgp: string;
  partnersContributedEgp: string;
  stillToContributeEgp: string;
  shares: {
    basis: 'TARGET' | 'COST_TO_FUND' | 'REPAID' | 'PUT_IN';
    ofEgp: string;
    partnersEgp: string;
    stillEgp: string;
    /** Every partner's share is his own contribution: all entered, and together the partners' part (owner 2026-10-27). */
    agreed?: boolean;
  };
  participants: {
    participantId: string;
    participantType: string;
    name: string;
    contributionEgp: string;
    customProfitPct: string | null;
    investorFeePct: string | null;
    profitPct: string | null;
  }[];
  profitSplit: {
    basis: 'CUSTOM_SPLIT' | 'CONTRIBUTIONS' | 'NONE';
    equal: boolean;
    problem: 'PARTIAL_CUSTOM_SPLIT' | 'SPLIT_NOT_100' | null;
  };
}

const num = (v: unknown) => Number(v ?? 0);

/** `partner` here is the User; the display name hangs off their partner record. */
export const participantName = (p: CardParticipant): string =>
  p.partner?.partner?.displayName ??
  p.investor?.partner?.displayName ??
  p.partner?.email ??
  p.investor?.email ??
  '—';

const linkButton =
  'inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50';
const quietButton =
  'inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const primaryButton =
  'inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50';

/** Section rows: on a phone the name and the last value, then the two middle ones; on a computer one line. */
const ROW = 'grid grid-cols-2 items-center gap-x-3 gap-y-0.5 py-2 md:grid-cols-[minmax(0,1fr)_9.5rem_9.5rem_14rem]';

export function FundingCard({
  cycle,
  totals,
  lenderNames,
  canFinance,
  onPaidByLender,
}: {
  cycle: {
    id: string;
    code: string;
    status: string;
    currency: string;
    fundingLock?: string | null;
    participants?: CardParticipant[];
  };
  totals: FundingTotals | undefined;
  /** The friends who paid towards the cycle (§18) — the note names them. */
  lenderNames: string[];
  /** May record a friend's payment here: an order to pay, and the cycle open to it. */
  canFinance: boolean;
  onPaidByLender: () => void;
}) {
  const t = useTranslations('fundingCard');
  const ta = useTranslations('accounts');
  const tcy = useTranslations('cycles');
  const tc = useTranslations('common');
  const locale = useLocale();
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const apiError = useApiError();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const refreshAccounts = useRefreshAccounts();

  const canRead = useCan('partnerAccount.read');
  const canAdvance = useCan('partnerAccount.advance');
  const canContribute = useCan('partnerAccount.contribute');
  const canTarget = useCan('partnerAccount.target');
  const canEdit = useCan('cycle.editParticipant');
  const canAdd = useCan('cycle.addParticipant');
  const canListUsers = useCan('users.list');

  const [advancing, setAdvancing] = useState(false);
  const [targeting, setTargeting] = useState(false);
  const [contributing, setContributing] = useState(false);
  const [enteringAmounts, setEnteringAmounts] = useState(false);
  const [changingSplit, setChangingSplit] = useState(false);
  const [adding, setAdding] = useState(false);

  const funding = useQuery<AccountFunding>({
    queryKey: ['account-funding', cycle.id],
    queryFn: () => api.get(`/cycles/${cycle.id}/account-funding`).then((r) => r.data.data ?? r.data),
    enabled: canRead,
  });
  // The people list only feeds Add investor's picker: asked for when it opens.
  const { items: users } = useAllRecords<ParticipantCandidate>(['users'], '/users', undefined, {
    enabled: canListUsers && canAdd && adding,
  });

  const participants = cycle.participants ?? [];
  const partners = participants.filter((p) => p.participantType === 'CORE_PARTNER');
  const toFund = num(totals?.toFundEgp ?? totals?.landedEgp);

  /** The cycle, its costing and this card's figures: whatever a funding change moves. */
  function refreshFunding() {
    void queryClient.invalidateQueries({ queryKey: ['cycle', cycle.id] });
    void queryClient.invalidateQueries({ queryKey: ['cycles'] });
    void queryClient.invalidateQueries({ queryKey: ['landedCost', cycle.id] });
    void queryClient.invalidateQueries({ queryKey: ['account-funding', cycle.id] });
  }

  /**
   * Each partner an equal share of what the cycle costs, written by hand —
   * the old Participants card's Split equally, unchanged (§8, §18: on a cycle
   * a friend paid for, each one's share of repaying him). To the piastre, the
   * last partner taking the residual; investors untouched.
   */
  const splitEqually = useMutation({
    mutationFn: async () => {
      if (partners.length === 0) throw new Error('no partners on this cycle');
      const investors = participants
        .filter((p) => p.participantType !== 'CORE_PARTNER')
        .reduce((sum, p) => sum + num(p.contributionAmount), 0);
      const { total, shares } = splitAcrossPartners(toFund, investors, partners.length);
      for (let i = 0; i < partners.length; i++) {
        await api.put(`/cycles/participants/${partners[i].id}`, { contributionAmount: shares[i] });
      }
      return total;
    },
    onSuccess: (total) => {
      refreshFunding();
      addToast(tcy('splitDone', { total: formatNumber(total, { maximumFractionDigits: 2 }) }), 'success');
    },
    onError: (e: unknown) => {
      refreshFunding();
      addToast(apiError(e, tc('error')), 'error');
    },
  });

  /** Every contribution that differs from what is recorded, one by one. */
  const saveAmounts = useMutation({
    mutationFn: async (amounts: Record<string, string>) => {
      for (const p of participants) {
        if (!(p.id in amounts)) continue;
        const next = num(amounts[p.id] || 0);
        if (next === num(p.contributionAmount)) continue;
        await api.put(`/cycles/participants/${p.id}`, { contributionAmount: next });
      }
    },
    onSuccess: () => {
      refreshFunding();
      setEnteringAmounts(false);
      addToast(tcy('amountsSaved'), 'success');
    },
    onError: (e: unknown) => {
      refreshFunding();
      addToast(apiError(e, tcy('amountsFailed')), 'error');
    },
  });

  const addParticipant = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post(`/cycles/${cycle.id}/participants`, body),
    onSuccess: () => {
      refreshFunding();
      setAdding(false);
      addToast(tcy('participantAdded'), 'success');
    },
    onError: (e: unknown) => addToast(apiError(e, tc('error')), 'error'),
  });

  if (!canRead) return null;
  if (funding.isLoading) return <FundingCardSkeleton />;
  const data = funding.data;
  if (funding.isError || !data?.putIn || !data.shares) {
    return (
      <section data-testid="funding-card-error" className="rounded-xl border border-border bg-card p-5">
        <CardTitle />
        <EmptyState
          size="compact"
          icon={AlertTriangle}
          title={ta('fundingLoadFailed')}
          action={{ label: ta('retry'), onClick: () => void funding.refetch() }}
          className="text-destructive"
        />
      </section>
    );
  }

  // ── Locks ─────────────────────────────────────────────────────────────
  // Approved, paid or closed (§8, 2026-10-18): everything off, the reason
  // beside it. A cycle being settled, closed or cancelled also takes nothing
  // from the accounts (2026-10-25) — those controls go off with that reason.
  const fundingLock = data.fundingLock ?? cycle.fundingLock ?? null;
  const lockReason = fundingLock
    ? tcy('fundingLocked', { reason: codeLabel('fundingLock', fundingLock) })
    : undefined;
  const accountsReason = lockReason ?? (data.closed ? ta('closed', { status: codeLabel('cycleStatus', data.status) }) : undefined);

  // ── 1. Target and put in so far ───────────────────────────────────────
  const target = data.target;
  const paidInTarget = num(data.putIn.inTargetCurrency);
  const pct = target && num(target.amount) > 0 ? Math.floor((paidInTarget / num(target.amount)) * 100) : null;
  // The server lists the cycle's partners first, then its investors, then anyone else who paid for it.
  const putInRows = data.putIn.byPartner;
  const friends = data.friends;
  const friendNames = friends ? lenderList(friends.names, locale) : '';

  /** How what he put in came in, each part with its amount (shown when there is more than one). */
  function howParts(r: AccountFunding['putIn']['byPartner'][number]) {
    const parts: { key: string; label: ReactNode; amount: string }[] = [];
    if (num(r.enteredEgp) > 0) {
      parts.push({
        key: 'entered',
        label:
          r.participantType === 'TEMP_INVESTOR'
            ? t('howInvested')
            : friends
              ? t('howRepaid', { friends: friendNames })
              : t('howContributed'),
        amount: r.enteredEgp,
      });
    }
    if (num(r.fromAccountEgp) > 0) parts.push({ key: 'account', label: t('howFromAccount'), amount: r.fromAccountEgp });
    if (num(r.undrawnAdvancesEgp) > 0) {
      parts.push({
        key: 'advances',
        label:
          r.advances.length === 1
            ? t('howPaidOn', { day: formatDate(r.advances[0].occurredOn) })
            : t('howPayments', { count: r.advances.length }),
        amount: r.undrawnAdvancesEgp,
      });
    }
    return parts;
  }

  // ── 2. Contributions ──────────────────────────────────────────────────
  const count = data.partners.length;
  const nothingToShare = num(data.shares.partnersEgp) <= 0;
  // Nothing for "Contribute equal thirds" to do (owner 2026-10-27): the shares are
  // as agreed, or there is a share to give and every partner has already given it.
  // With nothing to share yet it stays — advances can still be drawn in.
  const contributeDone = !!data.shares.agreed || (!nothingToShare && num(data.shares.stillEgp) <= 0);
  const investors = data.participants.filter((p) => p.participantType !== 'CORE_PARTNER');
  const canSplit =
    partners.length > 0 &&
    num(totals?.cycleCostEgp ?? totals?.landedEgp) + num(totals?.transferredInEgp) > 0;
  // A friend paid towards it and the partners entered their shares: say that
  // those shares are what each repays him (owner 2026-10-19).
  const lenderPaid = num(totals?.lenderFinancedEgp);
  const coreTotal = data.participants
    .filter((p) => p.participantType === 'CORE_PARTNER')
    .reduce((s, p) => s + num(p.contributionEgp), 0);
  const fullyLent =
    lenderPaid >= num(totals?.cycleCostEgp ?? totals?.landedEgp) + num(totals?.transferredInEgp);

  // ── 3. Profit split ───────────────────────────────────────────────────
  const pcts = data.participants
    .map((p) => (p.profitPct === null ? null : formatNumber(num(p.profitPct), { maximumFractionDigits: 2 })))
    .filter((p): p is string => p !== null)
    .join(' / ');
  const pctsNode = <bdi>{pcts}</bdi>;
  const splitLine =
    data.profitSplit.basis === 'NONE'
      ? t('splitNone')
      : data.profitSplit.basis === 'CUSTOM_SPLIT'
        ? t.rich('splitCustom', { pcts: () => pctsNode })
        : data.profitSplit.equal
          ? t.rich('splitEqual', { count: data.participants.length, pcts: () => pctsNode })
          : t.rich('splitByContribution', { pcts: () => pctsNode });
  const names = lenderList(data.participants.map((p) => p.name), locale);

  return (
    <section data-testid="funding-card" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <CardTitle />
        <span data-testid="funding-target" className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          {target ? (
            <>
              {ta.rich('target', { amount: () => <Money value={target.amount} currency={target.currency} /> })}
              {target.currency !== 'EGP' && (
                <span className="text-xs">
                  {ta.rich('targetEgp', { rate: Number(target.fxRateToEgp), egp: () => <Money value={target.amountEgp} /> })}
                </span>
              )}
            </>
          ) : (
            ta('noTarget')
          )}
          {canTarget && (
            <button
              type="button"
              onClick={() => setTargeting(true)}
              disabled={!!accountsReason}
              title={accountsReason}
              data-testid="edit-funding-target"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PencilLine className="h-3.5 w-3.5" /> {target ? ta('changeTarget') : ta('setTarget')}
            </button>
          )}
        </span>
      </div>

      <div className="space-y-2">
        <FundingNote
          cycle={{ status: cycle.status, fundingLock }}
          totals={totals}
          lenders={lenderNames}
          canFinance={canFinance}
          onPaidByLender={onPaidByLender}
        />
        {accountsReason && (
          <p data-testid="funding-locked" className="text-xs text-muted-foreground">
            {accountsReason}
          </p>
        )}
      </div>

      {/* ── 1. Target and put in so far ───────────────────────────────── */}
      <div data-testid="funding-paid" className="mt-4">
        {target ? (
          <div className="space-y-1.5">
            <p data-testid="paid-of-target" className="text-base font-semibold text-foreground">
              {pct !== null && pct >= 100
                ? t.rich('putInReached', { paid: () => <Money value={paidInTarget} currency={target.currency} /> })
                : t.rich('putInToGo', {
                    paid: () => <Money value={paidInTarget} currency={target.currency} />,
                    left: () => <Money value={Math.max(num(target.amount) - paidInTarget, 0)} currency={target.currency} />,
                  })}
            </p>
            <div
              data-testid="funding-progress"
              className="h-2 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={Math.min(pct ?? 0, 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-full rounded-full bg-primary-600" style={{ width: `${Math.min(pct ?? 0, 100)}%` }} />
            </div>
          </div>
        ) : (
          <p data-testid="paid-so-far" className="text-base font-semibold text-foreground">
            {t.rich('putInSoFar', { paid: () => <Money value={data.putIn.totalEgp} /> })}
          </p>
        )}

        <SectionHeading>{t('putInHeading')}</SectionHeading>
        <div className="divide-y divide-border">
          <ColumnHeads cols={[t('colName'), t('colPutIn'), t('colIntoCapital'), t('colHow')]} />
          {putInRows.length === 0 && <p className="py-2 text-sm text-muted-foreground">{ta('nothingPaid')}</p>}
          {putInRows.map((r) => {
            const parts = howParts(r);
            return (
              <div key={r.partnerUserId} data-testid="paid-row" className={ROW}>
                <bdi className="truncate font-medium text-foreground">{r.name}</bdi>
                <span data-testid="paid-amount" className="text-end text-sm tabular-nums md:text-start">
                  {num(r.totalEgp) > 0 ? <Money value={r.totalEgp} /> : '—'}
                </span>
                <span data-testid="paid-into-capital" className="text-xs text-muted-foreground">
                  {num(r.totalEgp) > 0 && (
                    <>
                      <span className="md:hidden">{t('colIntoCapital')} </span>
                      {num(r.contributionEgp) > 0 ? <Money value={r.contributionEgp} className="whitespace-nowrap text-sm text-foreground" /> : '—'}
                    </>
                  )}
                </span>
                <span data-testid="paid-how" className="text-end text-xs text-muted-foreground md:text-start">
                  {parts.map((part, i) => (
                    <span key={part.key} className="block md:inline">
                      {i > 0 && <span className="hidden md:inline"> · </span>}
                      {part.label}
                      {parts.length > 1 && (
                        <>
                          {' '}
                          <Money value={part.amount} className="text-foreground" />
                        </>
                      )}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
        {canAdvance && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setAdvancing(true)}
              disabled={!!accountsReason}
              title={accountsReason}
              data-testid="record-advance"
              className={linkButton}
            >
              <Plus className="h-4 w-4" /> {t('recordWhatIPaid')}
            </button>
          </div>
        )}
      </div>

      {/* ── 2. Contributions ──────────────────────────────────────────── */}
      <div data-testid="funding-contributions" className="mt-5 border-t border-border pt-4">
        <SectionHeading first>
          {nothingToShare
            ? t('contributionsNothing')
            : data.shares.agreed
              ? t.rich('contributionsAgreed', { amount: () => <Money value={data.shares.partnersEgp} /> })
              : t.rich(
                  data.shares.basis === 'TARGET'
                    ? 'contributionsTarget'
                    : data.shares.basis === 'REPAID'
                      ? 'contributionsRepaid'
                      : data.shares.basis === 'PUT_IN'
                        ? 'contributionsPutIn'
                        : 'contributionsCost',
                  {
                    count,
                    friends: friendNames || tcy('fundingNoteSomeLender'),
                    amount: () => <Money value={data.shares.ofEgp} />,
                  },
                )}
        </SectionHeading>
        <div className="divide-y divide-border">
          <ColumnHeads cols={[t('colName'), t('colShare'), t('colFromAdvances'), t('colStatus')]} />
          {count === 0 && <p className="py-2 text-sm text-accent-700">{tcy('noParticipantsYet')}</p>}
          {data.partners.map((p) => {
            const cover = num(p.coverEgp);
            return (
              <div key={p.partnerUserId} data-testid="share-row" className={ROW}>
                <span className="min-w-0">
                  <bdi className="block truncate font-medium text-foreground">{p.name}</bdi>
                  {num(p.contributionEgp) > 0 && (
                    <span data-testid="share-put-in" className="block text-[11px] text-muted-foreground">
                      {t.rich('putIn', { amount: () => <Money value={p.contributionEgp} /> })}
                    </span>
                  )}
                </span>
                <span data-testid="share-amount" className="hidden text-sm tabular-nums md:block">
                  <Money value={p.shareEgp} />
                </span>
                <span data-testid="share-available" className="hidden text-sm tabular-nums md:block">
                  <Money value={p.availableEgp} />
                  {num(p.elsewhereEgp) > 0 && (
                    <span data-testid="held-elsewhere" className="block text-[11px] text-muted-foreground">
                      {ta.rich('heldElsewhere', { amount: () => <Money value={p.elsewhereEgp} /> })}
                    </span>
                  )}
                </span>
                <span className="justify-self-end md:justify-self-start">
                  {!nothingToShare && (
                    <StatusPill short={cover < 0}>
                      {cover < 0
                        ? t.rich('short', { amount: () => <Money value={-cover} /> })
                        : cover > 0
                          ? t.rich('coveredLeft', { amount: () => <Money value={cover} /> })
                          : t('covered')}
                    </StatusPill>
                  )}
                </span>
                {/* A phone has no column titles: the two figures, labelled, on their own line. */}
                <span className="col-span-2 flex flex-wrap gap-x-4 text-xs text-muted-foreground md:hidden" aria-hidden="true">
                  <span className="tabular-nums">{t('colShare')} <Money value={p.shareEgp} className="text-foreground" /></span>
                  <span className="tabular-nums">{t('colFromAdvances')} <Money value={p.availableEgp} className="text-foreground" /></span>
                </span>
              </div>
            );
          })}
          {investors.map((p) => (
            <div key={p.participantId} data-testid="investor-row" className={ROW}>
              <span className="min-w-0">
                <bdi className="block truncate font-medium text-foreground">{p.name}</bdi>
                <span className="block text-[11px] text-muted-foreground">
                  {codeLabel('role', p.participantType)}
                  {p.investorFeePct ? ` · ${tcy('fee')} ${formatNumber(num(p.investorFeePct), { maximumFractionDigits: 2 })}%` : ''}
                </span>
              </span>
              <span className="text-end text-sm tabular-nums md:text-start">
                <Money value={p.contributionEgp} />
              </span>
              <span className="col-span-2 text-xs text-muted-foreground md:col-span-2">{t('investorOwnMoney')}</span>
            </div>
          ))}
        </div>

        {/* Each one's share of the cycle (owner 2026-10-27): everyone on it, investors too, at the
            profit split's own percentages (`profitSplitView`) — never a second sum over the partners. */}
        {lenderPaid > 0 && coreTotal > 0 && (
          <div data-testid="repay-shares" className="mt-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">
              {investors.length > 0
                ? t('sharesOfCycle', { lenders: lenderList(lenderNames, locale) || tcy('fundingNoteSomeLender') })
                : tcy(fullyLent ? 'repayShares' : 'repaySharesPartial', {
                    lenders: lenderList(lenderNames, locale) || tcy('fundingNoteSomeLender'),
                  })}
            </p>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
              {data.participants.map((p) => (
                <li key={p.participantId} data-testid={`repay-share-${p.participantId}`}>
                  <bdi>{p.name}</bdi> <Money value={p.contributionEgp} />
                  {p.profitPct !== null && (
                    <>
                      {' '}
                      <span dir="ltr">({formatNumber(num(p.profitPct), { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%)</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {friends && num(friends.repaidEgp) > 0 && num(friends.exchangeDifferenceEgp) !== 0 && (
          <ExchangeLine friends={friends} names={friendNames} />
        )}

        <p className="mt-2 text-xs text-muted-foreground">{t('sharesHint')}</p>
        {(canContribute || canEdit) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canContribute && !contributeDone && (
              <button
                type="button"
                onClick={() => setContributing(true)}
                disabled={!!accountsReason || count === 0}
                title={accountsReason}
                data-testid="contribute-thirds"
                className={primaryButton}
              >
                <Wallet className="h-4 w-4" /> {t('contributeThirds', { count })}
              </button>
            )}
            {canEdit && participants.length > 0 && (
              <button
                type="button"
                onClick={() => setEnteringAmounts(true)}
                disabled={!!lockReason}
                title={lockReason}
                data-testid="enter-amounts"
                className={quietButton}
              >
                <PencilLine className="h-4 w-4" /> {tcy('fundingEnterAmounts')}
              </button>
            )}
            {canEdit && canSplit && (
              <button
                type="button"
                onClick={() => splitEqually.mutate()}
                disabled={splitEqually.isPending || !!lockReason}
                title={lockReason ?? t('splitByHandHint')}
                data-testid="split-equally"
                className={quietButton}
              >
                {splitEqually.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scale className="h-4 w-4" />}
                {tcy('splitEqually')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── 3. Profit split and who is on the cycle ───────────────────── */}
      <div data-testid="funding-split" className="mt-5 space-y-3 border-t border-border pt-4">
        <SectionHeading first>{t('profitHeading')}</SectionHeading>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <p data-testid="profit-split-line" className="text-sm text-foreground">{splitLine}</p>
          {canEdit && data.participants.length > 0 && (
            <button
              type="button"
              onClick={() => setChangingSplit(true)}
              disabled={!!lockReason}
              title={lockReason}
              data-testid="change-split"
              className={linkButton}
            >
              <PencilLine className="h-4 w-4" /> {t('changeSplit')}
            </button>
          )}
        </div>
        {data.profitSplit.problem && (
          <p data-testid="profit-split-problem" className="text-xs text-destructive">{t('splitProblem')}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <p data-testid="on-cycle" className="text-sm text-foreground">
            {data.participants.length > 0 ? t('onCycle', { names }) : tcy('noParticipantsYet')}
          </p>
          {canAdd && !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              disabled={!!lockReason}
              title={lockReason}
              data-testid="add-investor"
              className={linkButton}
            >
              <Plus className="h-4 w-4" /> {t('addInvestor')}
            </button>
          )}
        </div>
        {adding && !lockReason && (
          <AddParticipantForm
            users={users}
            pending={addParticipant.isPending}
            onCancel={() => setAdding(false)}
            onSubmit={(body) => addParticipant.mutate(body)}
          />
        )}
      </div>

      {advancing && (
        <RecordAdvanceDialog
          partners={data.partners.map((p) => ({ partnerUserId: p.partnerUserId, name: p.name }))}
          cycles={[{ id: data.cycleId, code: data.code, currency: data.currency }]}
          cycleId={data.cycleId}
          onClose={() => setAdvancing(false)}
        />
      )}
      {targeting && (
        <FundingTargetDialog
          cycleId={data.cycleId}
          cycleCurrency={data.currency}
          target={target}
          onClose={() => setTargeting(false)}
        />
      )}
      {contributing && (
        <ContributeDialog
          data={data}
          onClose={() => setContributing(false)}
          onDone={() => {
            refreshAccounts();
            setContributing(false);
          }}
        />
      )}
      {enteringAmounts && (
        <Dialog
          title={tcy('fundingEnterAmounts')}
          subtitle={data.code}
          size="lg"
          onClose={() => setEnteringAmounts(false)}
          busy={saveAmounts.isPending}
        >
          <AmountsForm
            participants={participants}
            toFund={toFund}
            nameOf={participantName}
            roleOf={(p: CardParticipant) => codeLabel('role', p.participantType)}
            pending={saveAmounts.isPending}
            onCancel={() => setEnteringAmounts(false)}
            onSubmit={(amounts) => saveAmounts.mutate(amounts)}
          />
        </Dialog>
      )}
      {changingSplit && (
        <SplitDialog
          code={data.code}
          participants={data.participants}
          onClose={() => setChangingSplit(false)}
          onSaved={() => {
            refreshFunding();
            setChangingSplit(false);
          }}
        />
      )}
    </section>
  );
}

/**
 * The exchange difference on repaying a friend (owner 2026-10-26: "it should
 * state as well, the exchange difference"): the settlement's own figure, a
 * cost when positive (the rate rose since he paid), a gain when negative —
 * and each one's part of it by the profit split, "each" when the parts are
 * equal. A contribution is still handed back whole as capital; this comes off
 * the profit.
 */
function ExchangeLine({ friends, names }: { friends: NonNullable<AccountFunding['friends']>; names: string }) {
  const t = useTranslations('fundingCard');
  const diff = num(friends.exchangeDifferenceEgp);
  const split = friends.exchangeSplit;
  const equal = !!split && split.length > 0 && split.every((p) => p.amountEgp === split[0].amountEgp);
  const parts = () =>
    !split || split.length === 0 ? null : equal ? (
      <> {t.rich('exchangeEach', { amount: () => <Money value={Math.abs(num(split[0].amountEgp))} /> })}</>
    ) : (
      <>
        {' ('}
        {split.map((p, i) => (
          <span key={p.participantId} data-testid="exchange-part">
            {i > 0 && ' · '}
            <bdi>{p.name}</bdi> <Money value={Math.abs(num(p.amountEgp))} />
          </span>
        ))}
        {')'}
      </>
    );
  return (
    <p
      data-testid="exchange-difference"
      data-gain={diff < 0 ? 'true' : 'false'}
      className="mt-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"
    >
      {t.rich(diff < 0 ? 'exchangeGain' : 'exchangeCost', {
        friends: names,
        amount: () => <Money value={Math.abs(diff)} className="font-medium text-foreground" />,
        parts,
      })}
    </p>
  );
}

function CardTitle() {
  const ta = useTranslations('accounts');
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
      <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      {ta('fundingTitle')}
    </h2>
  );
}

function SectionHeading({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <h3 className={cn('mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground', !first && 'mt-4')}>
      {children}
    </h3>
  );
}

/** Column titles over a section's rows — on a computer; a phone labels each value instead. */
function ColumnHeads({ cols }: { cols: string[] }) {
  return (
    <div className={cn(ROW, 'hidden py-1.5 text-xs text-muted-foreground md:grid')} aria-hidden="true">
      {cols.map((c) => (
        <span key={c}>{c}</span>
      ))}
    </div>
  );
}

function StatusPill({ short, children }: { short: boolean; children: ReactNode }) {
  return (
    <span
      data-testid="share-status"
      data-short={short ? 'true' : 'false'}
      className={cn(
        'inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
        short ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success',
      )}
    >
      {children}
    </span>
  );
}

/**
 * Equal shares drawn from the accounts — the old panel's Contribute box, in a
 * dialog. The total starts at what the partners still have to give of their
 * shares; once typed, a refetch never overwrites it (CLAUDE.md §0). A partner
 * this cycle cannot draw enough for stops it; the server decides anyway.
 */
function ContributeDialog({ data, onClose, onDone }: { data: AccountFunding; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('fundingCard');
  const ta = useTranslations('accounts');
  const tc = useTranslations('common');
  const { formatNumber, formatMoney } = useNumberFormat();
  const apiError = useApiError();
  const { addToast } = useToast();
  const [typedTotal, setTypedTotal] = useState<string | null>(null);
  const total = typedTotal ?? (num(data.shares.stillEgp) > 0 ? data.shares.stillEgp : '');
  const { shares } = splitAcrossPartners(num(total), 0, data.partners.length);
  const rows = data.partners.map((p, i) => {
    const share = shares[i] ?? 0;
    return { ...p, share, after: Math.round((num(p.availableEgp) - share) * 100) / 100 };
  });
  const someoneShort = rows.some((r) => r.after < 0);

  const contribute = useMutation({
    mutationFn: (totalEgp: number) =>
      api.post(`/cycles/${data.cycleId}/account-contributions`, { totalEgp }).then((r) => r.data.data ?? r.data),
    onSuccess: (res: { totalEgp: string }) => {
      addToast(ta('contributed', { total: formatNumber(num(res.totalEgp), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }), 'success');
      onDone();
    },
    onError: (e) => addToast(apiError(e, ta('contributeFailed')), 'error'),
  });
  const canSubmit = num(total) > 0 && rows.length > 0 && !someoneShort && !contribute.isPending;

  return (
    <Dialog
      title={t('contributeThirds', { count: data.partners.length })}
      subtitle={data.code}
      size="lg"
      onClose={onClose}
      busy={contribute.isPending}
      cardProps={{ 'data-testid': 'contribute-dialog' }}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={contribute.isPending} label={tc('cancel')} />
          <DialogPrimary
            type="button"
            onClick={() => contribute.mutate(num(total))}
            disabled={!canSubmit}
            pending={contribute.isPending}
            label={num(total) > 0 ? `${ta('contribute')} ${formatMoney(num(total))}` : ta('contribute')}
          />
        </>
      }
    >
      <div className="space-y-3">
        <div className="max-w-xs">
          <label htmlFor="contribute-total" className="mb-1 block text-sm font-medium text-foreground">
            {ta('totalToContribute')}
          </label>
          <MoneyInput
            id="contribute-total"
            name="totalEgp"
            value={total}
            onChange={setTypedTotal}
            className="w-full rounded-lg border border-border px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div className="divide-y divide-border">
          <div className="hidden grid-cols-4 items-center gap-2 py-2 text-xs text-muted-foreground sm:grid">
            <span>{ta('colPartner')}</span>
            <span>{ta('colAvailable')}</span>
            <span>{ta('colShare')}</span>
            <span>{ta('colAfter')}</span>
          </div>
          {rows.map((r) => (
            <div key={r.partnerUserId} data-testid="contribute-row" className="grid grid-cols-2 items-center gap-2 py-2 sm:grid-cols-4">
              <bdi className="font-medium text-foreground">{r.name}</bdi>
              <span data-testid="contribute-available" className="text-sm tabular-nums">
                <Money value={r.availableEgp} />
                {num(r.elsewhereEgp) > 0 && (
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    {ta.rich('heldElsewhere', { amount: () => <Money value={r.elsewhereEgp} /> })}
                  </span>
                )}
              </span>
              <span data-testid="contribute-share" className="text-sm tabular-nums"><Money value={r.share} /></span>
              {r.after < 0 ? (
                <span data-testid="contribute-short" className="text-xs text-destructive">
                  {ta.rich('short', { amount: () => <Money value={-r.after} /> })}
                </span>
              ) : (
                <span className="text-sm tabular-nums text-success"><Money value={r.after} /></span>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{ta('noNegative')}</p>
        {someoneShort && <p className="text-xs text-destructive">{ta('someoneShort')}</p>}
      </div>
    </Dialog>
  );
}

/**
 * The agreed profit split (§8): a percentage for every participant, adding
 * up to 100, or none — then profit follows the contributions. Settling
 * refuses a partial one or one off 100 (`PARTIAL_CUSTOM_SPLIT`,
 * `SPLIT_NOT_100`), so Save waits for one of the two. It opens on what is
 * recorded; written through each participant's own PUT, only what changed.
 */
function SplitDialog({
  code,
  participants,
  onClose,
  onSaved,
}: {
  code: string;
  participants: AccountFunding['participants'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('fundingCard');
  const tc = useTranslations('common');
  const codeLabel = useCodeLabel();
  const { formatNumber } = useNumberFormat();
  const apiError = useApiError();
  const { addToast } = useToast();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(participants.map((p) => [p.participantId, p.customProfitPct === null ? '' : String(num(p.customProfitPct))])),
  );
  const filled = participants.filter((p) => values[p.participantId]?.trim());
  const totalCents = filled.reduce((s, p) => s + Math.round(num(values[p.participantId]) * 100), 0);
  const cleared = filled.length === 0;
  const valid = cleared || (filled.length === participants.length && totalCents === 10000);

  const save = useMutation({
    mutationFn: async () => {
      for (const p of participants) {
        const raw = values[p.participantId]?.trim() ?? '';
        const next = raw === '' ? null : num(raw);
        const before = p.customProfitPct === null ? null : num(p.customProfitPct);
        if (next === before) continue;
        await api.put(`/cycles/participants/${p.participantId}`, { customProfitPct: next });
      }
    },
    onSuccess: () => {
      addToast(t('splitSaved'), 'success');
      onSaved();
    },
    onError: (e: unknown) => addToast(apiError(e, t('splitFailed')), 'error'),
  });

  return (
    <Dialog
      title={t('changeSplit')}
      subtitle={code}
      description={t('splitDialogHint')}
      onClose={onClose}
      busy={save.isPending}
      cardProps={{ 'data-testid': 'split-dialog' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
      footer={
        <>
          <button
            type="button"
            onClick={() => setValues(Object.fromEntries(participants.map((p) => [p.participantId, ''])))}
            data-testid="split-clear"
            className="me-auto text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {t('splitByContributionAction')}
          </button>
          <DialogCancel onClick={onClose} disabled={save.isPending} label={tc('cancel')} />
          <DialogPrimary disabled={!valid} pending={save.isPending} label={tc('save')} />
        </>
      }
    >
      <div className="divide-y divide-border">
        {participants.map((p) => (
          <div key={p.participantId} className="flex items-center gap-3 py-2">
            <label htmlFor={`split-${p.participantId}`} className="min-w-0 flex-1 text-sm text-foreground">
              <bdi className="font-medium">{p.name}</bdi>
              <span className="ms-2 text-xs text-muted-foreground">{codeLabel('role', p.participantType)}</span>
            </label>
            <span className="inline-flex items-center gap-1">
              <MoneyInput
                id={`split-${p.participantId}`}
                data-field={`split-${p.participantId}`}
                value={values[p.participantId] ?? ''}
                placeholder={p.profitPct === null ? '' : formatNumber(num(p.profitPct), { maximumFractionDigits: 2 })}
                onChange={(raw) => setValues((prev) => (prev[p.participantId] === raw ? prev : { ...prev, [p.participantId]: raw }))}
                className="w-24 rounded-lg border border-border px-2 py-1.5 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <span className="text-xs text-muted-foreground" aria-hidden="true">%</span>
            </span>
          </div>
        ))}
      </div>
      <p data-testid="split-total" className={cn('mt-3 text-xs', valid ? 'text-muted-foreground' : 'text-accent-700')}>
        {cleared ? t('splitWillFollow') : t('splitTotal', { total: formatNumber(totalCents / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}
      </p>
    </Dialog>
  );
}

/**
 * The card before its figures arrive, traced from it (LEARNINGS "Loading
 * states"): the title and target, the put-in-so-far line and its bar, three
 * partner rows, the contributions heading with three rows and the buttons,
 * then the split's two lines.
 */
/** The column titles' place, on a computer, as the real rows have it. */
function HeadsSkeleton() {
  return (
    <div className={cn(ROW, 'hidden py-1.5 md:grid')}>
      {repeat(4, (i) => (
        <SkeletonText key={i} size="xs" className="w-16" />
      ))}
    </div>
  );
}

export function FundingCardSkeleton() {
  return (
    <section data-testid="funding-card-loading" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <CardTitle />
        <SkeletonText size="sm" className="w-44" />
      </div>
      <SkeletonRegion testId="funding-card-skeleton">
        <div className="mt-4 space-y-1.5">
          <SkeletonText size="base" className="w-64 max-w-full" />
          <Skeleton className="h-2 w-full rounded-full" />
        </div>
        <SkeletonText size="xs" className="mt-4 mb-1 w-40" />
        <div className="divide-y divide-border"><HeadsSkeleton />
          {repeat(3, (i) => (
            <div key={i} data-testid="skeleton-row" className={ROW}>
              <SkeletonText size="base" className="w-20" />
              <SkeletonText size="sm" className="w-24 justify-self-end md:justify-self-start" />
              <SkeletonText size="xs" className="w-20" />
              <SkeletonText size="xs" className="w-16 justify-self-end md:justify-self-start" />
            </div>
          ))}
        </div>
        <SkeletonText size="sm" className="mt-2 w-32" />
        <div className="mt-5 border-t border-border pt-4">
          <SkeletonText size="xs" className="mb-1 w-72 max-w-full" />
          <div className="divide-y divide-border"><HeadsSkeleton />
            {repeat(3, (i) => (
              <div key={i} data-testid="skeleton-row" className={ROW}>
                <SkeletonText size="base" className="w-20" />
                <SkeletonText size="sm" className="w-24 justify-self-end md:justify-self-start" />
                <SkeletonText size="sm" className="hidden w-24 md:block" />
                <Skeleton className="h-5 w-32 justify-self-end rounded-full md:justify-self-start" />
              </div>
            ))}
          </div>
          <SkeletonText size="xs" className="mt-2 w-3/4" />
          <div className="mt-3 flex flex-wrap gap-2">
            <Skeleton className="h-8 w-48 rounded-lg" />
            <Skeleton className="h-8 w-36 rounded-lg" />
            <Skeleton className="h-8 w-32 rounded-lg" />
          </div>
        </div>
        <div className="mt-5 space-y-3 border-t border-border pt-4">
          <SkeletonText size="xs" className="w-24" />
          <SkeletonText size="sm" className="w-64 max-w-full" />
          <SkeletonText size="sm" className="w-56 max-w-full" />
        </div>
      </SkeletonRegion>
    </section>
  );
}
