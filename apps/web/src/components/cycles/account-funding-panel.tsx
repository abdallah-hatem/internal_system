'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { useCodeLabel } from '@/lib/labels';
import { useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { splitAcrossPartners } from '@/lib/funding-split';
import { useToast } from '@/components/ui/toast';
import { Money } from '@/components/ui/money';
import { MoneyInput } from '@/components/ui/money-input';
import { AlertTriangle, Loader2, PencilLine, Plus, Scale, Wallet } from '@/components/ui/icons';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';
import {
  FundingTargetDialog,
  RecordAdvanceDialog,
  useRefreshAccounts,
  type AccountMovement,
} from '@/components/partners/account-dialogs';

/**
 * A cycle's funding from the partners' running accounts (BUSINESS_LOGIC §8,
 * owner 2026-10-25): its optional target ("1,600 of 2,000 paid so far"), who
 * has paid the supplier so far, and contributing from the accounts — equal
 * shares by default, never more than an account holds.
 *
 * Every figure is the server's (`GET /cycles/:id/account-funding`); the
 * preview of the equal shares is the cycle page's own Split equally
 * arithmetic (`splitAcrossPartners`), over the partners in the server's
 * order, so the last one shown is the one the server gives the odd piastre.
 */

export interface AccountFunding {
  cycleId: string;
  code: string;
  status: string;
  currency: string;
  fundingLock: string | null;
  closed: boolean;
  target: { amount: string; currency: string; fxRateToEgp: string; amountEgp: string } | null;
  paidSoFar: {
    totalEgp: string;
    inTargetCurrency: string | null;
    byPartner: {
      partnerUserId: string;
      name: string;
      totalEgp: string;
      inTargetCurrency: string | null;
      advances: AccountMovement[];
    }[];
  };
  partners: {
    partnerUserId: string;
    participantId: string;
    name: string;
    /** What THIS cycle can draw from his account (owner 2026-10-26): its own advances not yet drawn, and untied money. */
    availableEgp: string;
    ownAdvancesEgp: string;
    untiedEgp: string;
    /** Advanced for other cycles: in his account, never this cycle's to draw. */
    elsewhereEgp: string;
    /** His whole account. */
    balanceEgp: string;
    contributionEgp: string;
    fromAccountEgp: string;
  }[];
  toFundEgp: string;
  investorsEgp: string;
  partnersContributedEgp: string;
  stillToContributeEgp: string;
}

const num = (v: unknown) => Number(v ?? 0);

/**
 * The panel before its figures arrive, traced from it (LEARNINGS "Loading
 * states"): the title and target line, the paid-so-far line and its bar, who
 * paid (three rows, the partners a cycle has), and — for someone who may
 * contribute — the Contribute box with its total and a row per partner.
 */
function AccountFundingSkeleton({ canContribute }: { canContribute: boolean }) {
  const t = useTranslations('accounts');
  return (
    <section data-testid="account-funding-loading" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('fundingTitle')}
        </h2>
        <SkeletonText size="sm" className="w-40" />
      </div>
      <SkeletonRegion testId="account-funding-skeleton">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <SkeletonText size="base" className="w-56" />
            <SkeletonText size="xs" className="w-32" />
          </div>
          <Skeleton className="h-2 w-full rounded-full" />
        </div>
        <SkeletonText size="xs" className="mt-5 mb-1 w-28" />
        <div className="divide-y divide-border">
          {repeat(3, (i) => (
            <div key={i} className="grid grid-cols-2 items-center gap-2 py-2 sm:grid-cols-4">
              <SkeletonText size="base" className="w-20" />
              <SkeletonText size="sm" className="w-24" />
              <SkeletonText size="xs" className="w-28" />
              <SkeletonText size="xs" className="w-16" />
            </div>
          ))}
        </div>
        {canContribute && (
          <div className="mt-5 rounded-lg border border-border p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <SkeletonText size="sm" className="w-44" />
              <SkeletonText size="xs" className="w-40" />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <SkeletonText size="sm" className="mb-1 w-32" />
                <Skeleton className="h-9 w-full rounded-lg" />
              </div>
            </div>
            <div className="mt-3 divide-y divide-border">
              {repeat(3, (i) => (
                <div key={i} className="grid grid-cols-2 items-center gap-2 py-2 sm:grid-cols-4">
                  <SkeletonText size="base" className="w-20" />
                  <SkeletonText size="sm" className="w-24" />
                  <SkeletonText size="sm" className="w-20" />
                  <SkeletonText size="sm" className="w-20" />
                </div>
              ))}
            </div>
          </div>
        )}
      </SkeletonRegion>
    </section>
  );
}

export function AccountFundingPanel({ cycleId }: { cycleId: string }) {
  const t = useTranslations('accounts');
  const tc = useTranslations('cycles');
  const codeLabel = useCodeLabel();
  const canRead = useCan('partnerAccount.read');
  const canAdvance = useCan('partnerAccount.advance');
  const canContribute = useCan('partnerAccount.contribute');
  const canTarget = useCan('partnerAccount.target');
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const apiError = useApiError();
  const { addToast } = useToast();
  const refresh = useRefreshAccounts();
  const [advancing, setAdvancing] = useState(false);
  const [targeting, setTargeting] = useState(false);
  // null until typed: until then the total follows what is still to contribute,
  // and once typed a refetch never overwrites it (CLAUDE.md §0).
  const [typedTotal, setTypedTotal] = useState<string | null>(null);

  const funding = useQuery<AccountFunding>({
    queryKey: ['account-funding', cycleId],
    queryFn: () => api.get(`/cycles/${cycleId}/account-funding`).then((r) => r.data.data ?? r.data),
    enabled: canRead,
  });
  const data = funding.data;

  const contribute = useMutation({
    mutationFn: (totalEgp: number) =>
      api.post(`/cycles/${cycleId}/account-contributions`, { totalEgp }).then((r) => r.data.data ?? r.data),
    onSuccess: (res: { totalEgp: string }) => {
      refresh();
      setTypedTotal(null);
      addToast(t('contributed', { total: formatNumber(num(res.totalEgp), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }), 'success');
    },
    onError: (e) => {
      refresh();
      addToast(apiError(e, t('contributeFailed')), 'error');
    },
  });

  // Hidden for good from someone who may not read the accounts; otherwise the
  // card holds its place while it loads, and says so if it could not.
  if (!canRead) return null;
  if (funding.isLoading) return <AccountFundingSkeleton canContribute={canContribute} />;
  if (funding.isError || !data?.paidSoFar) {
    return (
      <section data-testid="account-funding-error" className="rounded-xl border border-border bg-card p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('fundingTitle')}
        </h2>
        <EmptyState
          size="compact"
          icon={AlertTriangle}
          title={t('fundingLoadFailed')}
          action={{ label: t('retry'), onClick: () => void funding.refetch() }}
          className="text-destructive"
        />
      </section>
    );
  }

  const target = data.target;
  const paidInTarget = num(data.paidSoFar.inTargetCurrency);
  const pct = target && num(target.amount) > 0 ? Math.floor((paidInTarget / num(target.amount)) * 100) : null;
  const locked = data.closed || !!data.fundingLock;
  const lockText = data.closed
    ? t('closed', { status: codeLabel('cycleStatus', data.status) })
    : data.fundingLock
      ? tc('fundingLocked', { reason: codeLabel('fundingLock', data.fundingLock) })
      : null;

  const total = typedTotal ?? (num(data.stillToContributeEgp) > 0 ? data.stillToContributeEgp : '');
  const { shares } = splitAcrossPartners(num(total), 0, data.partners.length);
  const rows = data.partners.map((p, i) => {
    const share = shares[i] ?? 0;
    // Against what this cycle can draw, never his whole account: an advance
    // for another cycle is not this cycle's money (owner 2026-10-26).
    const after = Math.round((num(p.availableEgp) - share) * 100) / 100;
    return { ...p, share, after };
  });
  const someoneShort = rows.some((r) => r.after < 0);
  const canSubmit = num(total) > 0 && rows.length > 0 && !someoneShort && !locked && !contribute.isPending;

  return (
    <section data-testid="account-funding" className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('fundingTitle')}
        </h2>
        <span data-testid="funding-target" className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          {target ? (
            <>
              {t.rich('target', { amount: () => <Money value={target.amount} currency={target.currency} /> })}
              {target.currency !== 'EGP' && (
                <span className="text-xs">
                  {t.rich('targetEgp', { rate: Number(target.fxRateToEgp), egp: () => <Money value={target.amountEgp} /> })}
                </span>
              )}
            </>
          ) : (
            t('noTarget')
          )}
          {canTarget && !locked && (
            <button
              type="button"
              onClick={() => setTargeting(true)}
              data-testid="edit-funding-target"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <PencilLine className="h-3.5 w-3.5" /> {target ? t('changeTarget') : t('setTarget')}
            </button>
          )}
        </span>
      </div>

      {target ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p data-testid="paid-of-target" className="text-base font-semibold text-foreground">
              {t.rich('paidOfTarget', {
                paid: () => <Money value={paidInTarget} currency={target.currency} />,
                target: () => <Money value={target.amount} currency={target.currency} />,
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {pct !== null && pct >= 100
                ? t('targetReached', { pct })
                : t.rich('stillToPay', {
                    amount: () => <Money value={Math.max(num(target.amount) - paidInTarget, 0)} currency={target.currency} />,
                    pct: pct ?? 0,
                  })}
            </p>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.min(pct ?? 0, 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-primary-600" style={{ width: `${Math.min(pct ?? 0, 100)}%` }} />
          </div>
        </div>
      ) : (
        <p data-testid="paid-so-far" className="text-base font-semibold text-foreground">
          {t.rich('paidSoFar', { paid: () => <Money value={data.paidSoFar.totalEgp} /> })}
        </p>
      )}

      <h3 className="mt-5 mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('byWhom')}</h3>
      {data.paidSoFar.byPartner.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t('nothingPaid')}</p>
      ) : (
        <div className="divide-y divide-border">
          {data.paidSoFar.byPartner.flatMap((p) =>
            p.advances.map((a, i) => (
              <div key={a.id} data-testid="paid-by" className="grid grid-cols-2 items-center gap-2 py-2 sm:grid-cols-4">
                <span className="font-medium text-foreground">{i === 0 ? p.name : ''}</span>
                <span className="text-sm tabular-nums"><Money value={a.amount} currency={a.currency} /></span>
                <span className="text-xs text-muted-foreground">
                  {a.currency !== 'EGP' && <><Money value={a.amountEgp} /> · </>}
                  {formatDate(a.occurredOn)}
                  {a.currency !== 'EGP' && <> <bdi dir="ltr">@ {Number(a.fxRateToEgp)}</bdi></>}
                </span>
                <bdi className="truncate text-xs text-muted-foreground">{a.note ?? ''}</bdi>
              </div>
            )),
          )}
        </div>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{t('paidHint')}</p>
      {canAdvance && !locked && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setAdvancing(true)}
            data-testid="record-advance"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            <Plus className="h-4 w-4" /> {t('recordPayment')}
          </button>
        </div>
      )}

      {canContribute && (
        <div data-testid="contribute-from-accounts" className="mt-5 rounded-lg border border-border p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Scale className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {t('contributeTitle')}
            </h3>
            <span className="text-xs text-muted-foreground">
              {t.rich('contributeHint', { amount: () => <Money value={data.stillToContributeEgp} /> })}
            </span>
          </div>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noPartners')}</p>
          ) : (
            <>
              <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor="contribute-total" className="mb-1 block text-sm font-medium text-foreground">
                    {t('totalToContribute')}
                  </label>
                  <MoneyInput
                    id="contribute-total"
                    name="totalEgp"
                    value={total}
                    onChange={setTypedTotal}
                    disabled={locked}
                    className="w-full rounded-lg border border-border px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              </div>
              <div className="mt-3 divide-y divide-border">
                <div className="hidden grid-cols-4 items-center gap-2 py-2 text-xs text-muted-foreground sm:grid">
                  <span>{t('colPartner')}</span>
                  <span>{t('colAvailable')}</span>
                  <span>{t('colShare')}</span>
                  <span>{t('colAfter')}</span>
                </div>
                {rows.map((r) => (
                  <div key={r.partnerUserId} data-testid="contribute-row" className="grid grid-cols-2 items-center gap-2 py-2 sm:grid-cols-4">
                    <span className="font-medium text-foreground">
                      {r.name}
                      {num(r.fromAccountEgp) > 0 && (
                        <span className="block text-[11px] font-normal text-muted-foreground">
                          {t.rich('fromAccounts', { amount: () => <Money value={r.fromAccountEgp} /> })}
                        </span>
                      )}
                    </span>
                    <span data-testid="contribute-available" className="text-sm tabular-nums">
                      <Money value={r.availableEgp} />
                      {num(r.elsewhereEgp) > 0 && (
                        <span data-testid="held-elsewhere" className="block text-[11px] font-normal text-muted-foreground">
                          {t.rich('heldElsewhere', { amount: () => <Money value={r.elsewhereEgp} /> })}
                        </span>
                      )}
                    </span>
                    <span data-testid="contribute-share" className="text-sm tabular-nums"><Money value={r.share} /></span>
                    {r.after < 0 ? (
                      <span data-testid="contribute-short" className="text-xs text-destructive">
                        {t.rich('short', { amount: () => <Money value={-r.after} /> })}
                      </span>
                    ) : (
                      <span className="text-sm tabular-nums text-success"><Money value={r.after} /></span>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t('noNegative')}</p>
              {lockText && <p data-testid="account-funding-locked" className="mt-2 text-xs text-muted-foreground">{lockText}</p>}
              {someoneShort && !locked && <p className="mt-2 text-xs text-destructive">{t('someoneShort')}</p>}
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => contribute.mutate(num(total))}
                  disabled={!canSubmit}
                  data-testid="contribute-submit"
                  className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-700 disabled:opacity-50"
                >
                  {contribute.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('contribute')} {num(total) > 0 && <Money value={num(total)} />}
                </button>
              </div>
            </>
          )}
        </div>
      )}

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
    </section>
  );
}
