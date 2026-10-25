'use client';
import { GoodsLocationCards, GoodsLocationSkeleton } from '@/components/cycles/goods-location-cards';
import { CycleTransfersSection, MoveLeftoversButton, useCycleTransfers } from '@/components/cycles/cycle-transfers';
import { LatinText } from '@/components/ui/latin-text';
import { useAllRecords } from '@/lib/list-all';

/**
 * Everything a cycle contains, at any point in its life.
 *
 * The list gave a cycle two fates: one still in the wizard opened the wizard,
 * and one past it opened a drawer of counts — "participants: 0", "purchases:
 * 1" — with no way to see what those were. A closed cycle, the one you most
 * want to look back at, showed the least.
 *
 * This page is readable in every status, and is where participants are added,
 * which nothing could do before: the API and the settlement maths both expected
 * them, and no screen ever created one. Every cycle therefore had none, and
 * settling reported "No participants found for this cycle".
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { localName } from '@/lib/localized-name';
import { useRef, useState } from 'react';
import { api } from '../../../../../lib/api';
import { Money } from '../../../../../components/ui/money';
import { Select } from '../../../../../components/ui/select';
import { useToast } from '../../../../../components/ui/toast';
import { selectOnFocus } from '../../../../../lib/select-on-focus';
import { MoneyInput } from '../../../../../components/ui/money-input';
import {
  Loader2, Users, ShoppingCart, Boxes, Plus, Scale, TrendingUp, PencilLine,
} from '@/components/ui/icons';

import { useApiError } from '../../../../../lib/api-error';
import { BackLink } from '../../../../../components/ui/back-link';
import { ContinueSetupLink } from '@/components/cycles/continue-setup';
import { CycleStatusButton } from '@/components/cycles/cycle-status-button';
import { useCodeLabel } from '../../../../../lib/labels';
import { useDateFormat } from '../../../../../lib/dates';
import { ShipmentPanel, ShipmentPanelSkeleton, useShipment } from '../../../../../components/shipment/ShipmentPanel';
import { ValidatedForm } from '@/components/ui/validated-form';
import { useCan } from '@/lib/can';
import { EmptyState } from '@/components/ui/empty-state';
import { useNumberFormat } from '@/lib/numbers';
import { PaidByFriend } from '@/components/lenders/paid-by-friend';
import { Skeleton, SkeletonRegion, SkeletonText, repeat, type SkeletonTextSize } from '@/components/ui/skeleton';
import { splitAcrossPartners } from '@/lib/funding-split';
import { viewPath } from '@/lib/page-views';
import { FundingNote, lenderList } from '@/components/cycles/funding-note';
import { AmountsForm } from '@/components/cycles/amounts-form';
import { AccountFundingPanel } from '@/components/cycles/account-funding-panel';
import type { FinancingView } from '@/components/lenders/lender-dialogs';

/**
 * One cycle's line from the analytics profitability figure — the same one the
 * cycle list and the Analytics page read, so profit is defined once (rule 11).
 * A cycle with nothing received yet has no line.
 */
interface CycleProfit {
  cycleCode: string;
  profit: number;
  totalRevenue: number;
  totalCost: number;
  lossesEgp?: number;
  supplierRefundsEgp?: number;
  /** Expenses charged to the cycle, already off profit (L6). */
  expensesEgp?: number;
  /** Other income credited to the cycle, already in profit (L6). */
  otherIncomeEgp?: number;
  roiPct: number | null;
}
const num = (v: unknown) => Number(v ?? 0);

/** A participant as the cycle reads it: the person is a User, named by its partner record. */
interface ParticipantRow {
  id: string;
  participantType: string;
  contributionAmount: unknown;
  partner?: { email?: string; partner?: { displayName?: string } | null } | null;
  investor?: { email?: string; partner?: { displayName?: string } | null } | null;
}

/** `partner` here is the User; the display name hangs off their partner record. */
const participantName = (p: ParticipantRow): string =>
  p.partner?.partner?.displayName ??
  p.investor?.partner?.displayName ??
  p.partner?.email ??
  p.investor?.email ??
  '—';

export default function CycleDetailsPage() {
  const apiError = useApiError();
  const t = useTranslations('cycles');
  const tc = useTranslations('common');
  const { cycleId: id, locale } = useParams<{ cycleId: string; locale: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [adding, setAdding] = useState(false);
  // The funding note's two ways in (owner 2026-10-18): the contributions,
  // edited in place on the Participants card, and a friend's payment.
  const [editingAmounts, setEditingAmounts] = useState(false);
  const [financingOpen, setFinancingOpen] = useState(false);
  const [financingPrefill, setFinancingPrefill] = useState(false);
  const participantsRef = useRef<HTMLDivElement>(null);
  const financingRef = useRef<HTMLDivElement>(null);
  const scrollTo = (el: HTMLElement | null) =>
    // After the render that opens it, so it lands on the open form.
    window.setTimeout(() => el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 0);
  // An investor reads their own cycle and acts on nothing (R1b). The people
  // list only feeds the add-participant picker, and GET /users refuses an
  // investor, so it is not asked for unless that picker can be offered.
  const canAddParticipant = useCan('cycle.addParticipant');
  const canEditParticipant = useCan('cycle.editParticipant');
  const canListUsers = useCan('users.list');
  const canAddPurchase = useCan('purchase.create');
  const canFinance = useCan('lender.finance');
  const { formatNumber } = useNumberFormat();

  const { data: cycle, isLoading } = useQuery<any>({
    queryKey: ['cycle', id],
    queryFn: () => api.get(`/cycles/${id}`).then((r) => r.data.data ?? r.data),
  });

  const { items: users } = useAllRecords(['users'], '/users', undefined, {
    enabled: canListUsers && canAddParticipant,
  });

  const codeLabel = useCodeLabel();
  const { formatDate: formatLocalDate } = useDateFormat();
  const { data: shipment } = useShipment(id);
  // Leftovers moved out of and into this cycle (§8, L5): the cards and the Transfers section.
  const { data: transfers } = useCycleTransfers(id);
  const { data: profitability = [] } = useQuery<CycleProfit[]>({
    queryKey: ['analytics', 'cycle-profitability'],
    queryFn: () => api.get('/analytics/cycle-profitability').then((r) => r.data.data ?? r.data),
  });

  const { data: costing } = useQuery<any>({
    queryKey: ['landedCost', id],
    queryFn: () => api.get(`/costing/cycles/${id}/landed-cost`).then((r) => r.data),
    retry: false,
  });

  // Who paid the supplier for us (§18): the same query, and cache, as the
  // "Paid by a friend" section below. The funding note and the participants
  // card name him, because the partners repay him (owner 2026-10-19).
  const { data: financing } = useQuery<{ financings: FinancingView[] }>({
    queryKey: ['financing', 'cycle', id],
    queryFn: () => api.get(`/cycles/${id}/financing`).then((r) => r.data.data ?? r.data),
  });
  const lenderNames = (financing?.financings ?? []).map((f) => f.lender?.name).filter(Boolean) as string[];

  const addParticipant = useMutation({
    mutationFn: (body: any) => api.post(`/cycles/${id}/participants`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cycle', id] });
      queryClient.invalidateQueries({ queryKey: ['cycles'] });
      setAdding(false);
      addToast(t('participantAdded'), 'success');
    },
    onError: (e: any) =>
      addToast(
        apiError(e, tc('error')),
        'error',
      ),
  });

  /**
   * Give each partner an equal share of what the cycle actually cost — on a
   * cycle a friend paid for, an equal share of repaying him (§18, owner
   * 2026-10-19): his payment is not taken off.
   *
   * The three of them fund a cycle equally by default, but the amount is not
   * known until the goods and shipping are recorded — so this is the moment it
   * can be filled in rather than guessed at creation.
   *
   * Split to the piastre: thirds of 75,645.50 do not divide evenly, so the
   * last partner absorbs the residual and the parts re-sum to the total
   * exactly. Left uneven, capital returned at settlement would not match
   * capital put in.
   *
   * Temporary investors are untouched — they put in a specific amount that is
   * theirs, not a share of the whole.
   */
  const splitEqually = useMutation({
    mutationFn: async () => {
      const partners = participants.filter((p) => p.participantType === 'CORE_PARTNER');
      if (partners.length === 0) throw new Error('no partners on this cycle');

      const investors = participants
        .filter((p) => p.participantType !== 'CORE_PARTNER')
        .reduce((sum, p) => sum + num(p.contributionAmount), 0);

      // What the partners are funding: the cycle's cost — goods, shipping and
      // the expenses charged to it, plus leftovers moved in (the server's
      // `toFundEgp`) — less whatever an investor already put in. What a
      // friend paid is not taken off: they repay him (§18, 2026-10-19).
      const toFund = num(costing?.totals?.toFundEgp ?? costing?.totals?.landedEgp);
      const { total, shares } = splitAcrossPartners(toFund, investors, partners.length);

      for (let i = 0; i < partners.length; i++) {
        await api.put(`/cycles/participants/${partners[i].id}`, {
          contributionAmount: shares[i],
        });
      }
      return total;
    },
    onSuccess: (total) => {
      refreshFunding();
      addToast(t('splitDone', { total: formatNumber(total, { maximumFractionDigits: 2 }) }), 'success');
    },
    // A coded refusal — funding locked after the settlement (2026-10-18) —
    // said in the reader's language, never the raw English (rule 9).
    onError: (e: unknown) => {
      refreshFunding();
      addToast(apiError(e, tc('error')), 'error');
    },
  });

  /**
   * Every contribution that differs from what is recorded, written one by one
   * — the edit the wizard's Funding step made before it was removed
   * (2026-10-18), now on the cycle's own page.
   */
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
      setEditingAmounts(false);
      addToast(t('amountsSaved'), 'success');
    },
    onError: (e: unknown) => {
      refreshFunding();
      addToast(apiError(e, t('amountsFailed')), 'error');
    },
  });

  /** The cycle and its costing, which says whether funding is still needed. */
  function refreshFunding() {
    void queryClient.invalidateQueries({ queryKey: ['cycle', id] });
    void queryClient.invalidateQueries({ queryKey: ['cycles'] });
    void queryClient.invalidateQueries({ queryKey: ['landedCost', id] });
    void queryClient.invalidateQueries({ queryKey: ['account-funding', id] });
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <BackLink onClick={() => router.push(`/${locale}/cycles`)} />
        {/* The list the person came from already knows the route: a China cycle's six places, or a UAE one's four. */}
        <CycleDetailSkeleton
          direct={queryClient.getQueryData<{ items: { id: string; originType?: string }[] }>(['cycles'])?.items.find((c) => c.id === id)?.originType === 'UAE_DIRECT'}
        />
      </div>
    );
  }
  if (!cycle) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white">
        <EmptyState
          title={t('notFoundTitle')}
          description={t('notFoundHint')}
          action={{ label: t('backToCycles'), href: '/cycles' }}
        />
      </div>
    );
  }

  const participants: any[] = cycle.participants ?? [];
  const orders: any[] = cycle.purchaseOrders ?? [];
  const batches: any[] = cycle.inventoryBatches ?? [];
  const invested = participants.reduce((s, p) => s + num(p.contributionAmount), 0);
  const isClosed = cycle.status === 'CLOSED';
  // Why the funding can no longer change, from the server (§8, 2026-10-18):
  // the controls stay in sight, switched off, with this beside them.
  const fundingLock: string | null = cycle.fundingLock ?? null;
  const lockReason = fundingLock
    ? t('fundingLocked', { reason: codeLabel('fundingLock', fundingLock) })
    : undefined;
  const canSplit =
    participants.some((p) => p.participantType === 'CORE_PARTNER') &&
    num(costing?.totals?.cycleCostEgp ?? costing?.totals?.landedEgp) +
      num(costing?.totals?.transferredInEgp) >
      0;
  // A friend paid towards it and the partners have entered their shares:
  // say that those shares are what each repays him (owner 2026-10-19).
  const lenderPaid = num(costing?.totals?.lenderFinancedEgp);
  const corePartners = participants.filter((p) => p.participantType === 'CORE_PARTNER');
  const coreTotal = corePartners.reduce((s, p) => s + num(p.contributionAmount), 0);
  const fullyLent =
    lenderPaid >= num(costing?.totals?.cycleCostEgp ?? costing?.totals?.landedEgp) + num(costing?.totals?.transferredInEgp);
  // Friends already paid the whole cost: the server would refuse another
  // friend's payment (FINANCING_EXCEEDS_CYCLE_COST), so none is offered.
  const fullyPaidByFriends = lenderPaid > 0 && fullyLent;
  const financingClosed =
    ['SETTLEMENT', 'CLOSED', 'CANCELLED'].includes(cycle.status) || !!fundingLock;

  return (
    <div className="space-y-6">
      <BackLink onClick={() => router.push(`/${locale}/cycles`)} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl font-bold text-gray-900">{cycle.code}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {cycle.originType === 'CHINA' ? t('china') : t('uaeDirect')} · {cycle.currency} ·{' '}
            <span data-testid="cycle-status">{codeLabel('cycleStatus', cycle.status)}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ContinueSetupLink
            cycleId={cycle.id}
            status={cycle.status}
            className="inline-flex items-center gap-1 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-700 touch-manipulation"
          />
          <CycleStatusButton cycleId={cycle.id} status={cycle.status} />
          <MoveLeftoversButton cycleId={cycle.id} cycleCode={cycle.code} status={cycle.status} />
          <button
            type="button"
            onClick={() => router.push(`/${locale}${viewPath('settlements', { cycle: cycle.id })}`)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Scale className="h-4 w-4" /> {t('settlement')}
          </button>
        </div>
      </div>

      {/* Funding not entered yet (owner 2026-10-18): shown while settling
          would be refused for want of it, with the three ways to enter it. */}
      <FundingNote
        cycle={cycle}
        totals={costing?.totals}
        lenders={lenderNames}
        canSplit={canSplit}
        splitting={splitEqually.isPending}
        canEdit={canEditParticipant && participants.length > 0}
        canFinance={canFinance && orders.length > 0 && !financingClosed && !fullyPaidByFriends}
        onSplit={() => splitEqually.mutate()}
        onEnterAmounts={() => {
          setAdding(false);
          setEditingAmounts(true);
          scrollTo(participantsRef.current);
        }}
        onPaidByLender={() => {
          setFinancingPrefill(true);
          setFinancingOpen(true);
          scrollTo(financingRef.current);
        }}
      />

      {/* Funding from the partners' running accounts (§8, owner 2026-10-25):
          the target, who has paid the supplier so far, and contributing. */}
      <AccountFundingPanel cycleId={cycle.id} />

      {/* Where the goods are — layout A, chosen by the owner (I3). */}
      <GoodsLocationCards originType={cycle.originType} shipment={shipment} batches={batches} transfers={transfers} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Tile label={t('participants')} value={String(participants.length)} />
        <Tile label={t('invested')} value={<Money value={invested} />} />
        <Tile label={t('purchases')} value={String(orders.length)} />
        <Tile
          label={t('landedCost')}
          value={<Money value={num(costing?.totals?.landedEgp)} />}
          // Leftovers moved in from another cycle at their cost (§8, L5): the partners fund them too.
          note={
            num(costing?.totals?.transferredInEgp) > 0 ? (
              <span data-testid="landed-moved-in">
                {t('movedInAtCost')} <Money value={num(costing?.totals?.transferredInEgp)} />
              </span>
            ) : undefined
          }
        />
      </div>

      <ProfitCard figure={(Array.isArray(profitability) ? profitability : []).find((p) => p.cycleCode === cycle.code)} />

      {/* Leftovers moved to or from another cycle at their cost (§8, L5). */}
      <CycleTransfersSection cycleId={cycle.id} />

      <ShipmentPanel cycle={cycle} />

      {/* ── Participants ─────────────────────────────────────────────── */}
      <div ref={participantsRef} data-testid="participants-card" className="scroll-mt-4">
      <Card title={t('participants')} icon={<Users className="h-4 w-4 text-gray-400" />}>
        {participants.length === 0 && !adding && (
          <p className="pb-3 text-sm text-amber-700">
            {t('noParticipantsYet')}
          </p>
        )}

        {participants.length > 0 && !(editingAmounts && !fundingLock) && (
          <Rows>
            {participants.map((p) => (
              <Row key={p.id}>
                <span className="font-medium text-gray-900">
                  {participantName(p)}
                </span>
                <span className="text-xs text-gray-500">{codeLabel('role', p.participantType)}</span>
                <span className="text-sm"><Money value={num(p.contributionAmount)} /></span>
                <span className="text-xs text-gray-500">
                  {p.customProfitPct != null ? `${p.customProfitPct}%` : t('byContribution')}
                </span>
                <span className="text-xs text-gray-400">
                  {p.investorFeePct ? `${t('fee')} ${p.investorFeePct}%` : ''}
                </span>
              </Row>
            ))}
          </Rows>
        )}

        {participants.length > 0 && !(editingAmounts && !fundingLock) && lenderPaid > 0 && coreTotal > 0 && (
          <div data-testid="repay-shares" className="mt-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">
              {t(fullyLent ? 'repayShares' : 'repaySharesPartial', {
                lenders: lenderList(lenderNames, locale) || t('fundingNoteSomeLender'),
              })}
            </p>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
              {corePartners.map((p) => (
                <li key={p.id} data-testid={`repay-share-${p.id}`}>
                  <bdi>{participantName(p)}</bdi> <Money value={num(p.contributionAmount)} />{' '}
                  <span dir="ltr">({formatNumber((num(p.contributionAmount) / coreTotal) * 100, { maximumFractionDigits: 2 })}%)</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {participants.length > 0 && editingAmounts && !fundingLock && (
          <AmountsForm
            participants={participants}
            toFund={num(costing?.totals?.toFundEgp ?? costing?.totals?.landedEgp)}
            nameOf={participantName}
            roleOf={(p: ParticipantRow) => codeLabel('role', p.participantType)}
            pending={saveAmounts.isPending}
            onCancel={() => setEditingAmounts(false)}
            onSubmit={(amounts) => saveAmounts.mutate(amounts)}
          />
        )}

        {/* Locked once the settlement is approved (§8, 2026-10-18): the
            controls stay, switched off, and say why. */}
        {lockReason && canAddParticipant && (
          <p data-testid="funding-locked" className="mt-3 text-xs text-muted-foreground">
            {lockReason}
          </p>
        )}

        {canAddParticipant && !(editingAmounts && !fundingLock) && (
          adding && !fundingLock ? (
            <AddParticipantForm
              users={users}
              pending={addParticipant.isPending}
              onCancel={() => setAdding(false)}
              onSubmit={(body) => addParticipant.mutate(body)}
            />
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => setAdding(true)}
                disabled={!!fundingLock}
                title={lockReason}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="h-4 w-4" /> {t('addParticipant')}
              </button>
              {canEditParticipant && participants.length > 0 && (
                <button
                  type="button"
                  onClick={() => setEditingAmounts(true)}
                  disabled={!!fundingLock}
                  title={lockReason}
                  data-testid="edit-amounts"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <PencilLine className="h-4 w-4" /> {t('editAmounts')}
                </button>
              )}
              {canEditParticipant && canSplit && (
                <button
                  type="button"
                  onClick={() => splitEqually.mutate()}
                  disabled={splitEqually.isPending || !!fundingLock}
                  title={lockReason}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {splitEqually.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Scale className="h-4 w-4" />
                  )}
                  {t('splitEqually')}
                </button>
              )}
            </div>
          )
        )}
      </Card>
      </div>

      {/* A friend who paid a supplier for us (§18): who, how much, still owed. */}
      {orders.length > 0 && (
        <div ref={financingRef} className="scroll-mt-4 rounded-xl border border-border bg-card p-4 sm:p-5">
          <PaidByFriend
            cycleId={cycle.id}
            orders={orders.map((o) => ({
              id: o.id,
              reference: o.reference,
              currency: o.currency,
              fxRateToEgp: o.fxRateToEgp,
            }))}
            closed={financingClosed}
            fullyPaid={fullyPaidByFriends}
            lockedReason={lockReason}
            open={financingOpen}
            onOpenChange={(open) => {
              setFinancingOpen(open);
              if (!open) setFinancingPrefill(false);
            }}
            prefillRemaining={financingPrefill}
          />
        </div>
      )}

      <Card title={t('purchases')} icon={<ShoppingCart className="h-4 w-4 text-gray-400" />}>
        {orders.length === 0 ? (
          <EmptyState
            size="compact"
            icon={ShoppingCart}
            title={t('noPurchasesTitle')}
            description={t('noPurchasesHint')}
            action={canAddPurchase && !isClosed ? { label: t('goToPurchases'), href: viewPath('purchases') } : undefined}
          />
        ) : (
          <Rows>
            {orders.map((o) => (
              <Row key={o.id}>
                <span className="font-mono text-xs text-gray-500">{o.reference}</span>
                <span className="text-sm"><LatinText>{o.supplier?.name ?? '—'}</LatinText></span>
                <span className="text-xs text-gray-400">{formatLocalDate(o.orderedOn)}</span>
                <span className="text-sm"><bdi dir="ltr">{o.currency} @ {num(o.fxRateToEgp)}</bdi></span>
                <span className="text-xs text-gray-500">{(o.items ?? []).length} {t('items')}</span>
              </Row>
            ))}
          </Rows>
        )}
      </Card>

      <Card title={t('inventory')} icon={<Boxes className="h-4 w-4 text-gray-400" />}>
        {batches.length === 0 ? (
          <EmptyState size="compact" icon={Boxes} title={t('noBatchesTitle')} description={t('noBatchesHint')} />
        ) : (
          <Rows>
            {batches.map((b) => (
              <Row key={b.id}>
                <span className="text-sm">{localName(b.product, locale) || '—'}</span>
                <span className="text-xs text-gray-500">{t('received')} {num(b.receivedQty)}</span>
                <span className="text-xs text-gray-500">{t('remaining')} {num(b.remainingQty)}</span>
                <span className="text-sm"><Money value={num(b.landedUnitCostEgp)} /></span>
                <span className="text-xs text-gray-400">{codeLabel('verificationStatus', b.verificationStatus)}</span>
              </Row>
            ))}
          </Rows>
        )}
      </Card>
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────
// The page below, traced while the cycle loads: the code and its line, the
// actions, the four tiles, the profit card and the three lists — with their
// real titles, which need no data. Each row skeleton gives every value the
// text size its real cell has, so the rows are the real rows' height. Change
// a section, change its tracing here.

/** Rows a list section shows while the cycle loads. */
const SECTION_SKELETON_ROWS = 3;

/** One `Row`, a value per cell at the size that cell's text is. */
function DetailRowSkeleton({ sizes }: { sizes: SkeletonTextSize[] }) {
  return (
    <div data-testid="skeleton-row" className="grid grid-cols-2 items-center gap-2 py-2 sm:grid-cols-5">
      {sizes.map((size, i) => (
        <SkeletonText key={i} size={size} className={i % 2 ? 'w-16' : 'w-24'} />
      ))}
    </div>
  );
}

function SectionSkeleton({ title, icon, sizes }: { title: string; icon: React.ReactNode; sizes: SkeletonTextSize[] }) {
  return (
    <Card title={title} icon={icon}>
      <div className="divide-y divide-muted">
        {repeat(SECTION_SKELETON_ROWS, (i) => <DetailRowSkeleton key={i} sizes={sizes} />)}
      </div>
    </Card>
  );
}

function CycleDetailSkeleton({ direct }: { direct: boolean }) {
  const t = useTranslations('cycles');
  return (
    <SkeletonRegion className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SkeletonText size="2xl" className="w-48" />
          <SkeletonText className="w-44" lineClassName="mt-1" />
        </div>
        {/* Change status, Move leftovers, Settlement: bordered text-sm buttons, 38px. */}
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9.5 w-36 rounded-lg" />
          <Skeleton className="h-9.5 w-36 rounded-lg" />
          <Skeleton className="h-9.5 w-32 rounded-lg" />
        </div>
      </div>

      <GoodsLocationSkeleton direct={direct} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        {[t('participants'), t('invested'), t('purchases'), t('landedCost')].map((label) => (
          <div key={label} className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <SkeletonText size="lg" className="w-24" lineClassName="mt-1" />
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
          <TrendingUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('profit')}
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {repeat(6, (i) => (
            <div key={i}>
              <SkeletonText size="xs" className="w-16" />
              <SkeletonText size={i < 2 ? 'lg' : 'sm'} className="w-24" />
            </div>
          ))}
        </div>
      </div>

      <ShipmentPanelSkeleton inside />

      <SectionSkeleton
        title={t('participants')}
        icon={<Users className="h-4 w-4 text-muted-foreground" />}
        sizes={['base', 'xs', 'sm', 'xs', 'xs']}
      />
      <SectionSkeleton
        title={t('purchases')}
        icon={<ShoppingCart className="h-4 w-4 text-muted-foreground" />}
        sizes={['xs', 'sm', 'xs', 'sm', 'xs']}
      />
      <SectionSkeleton
        title={t('inventory')}
        icon={<Boxes className="h-4 w-4 text-muted-foreground" />}
        sizes={['sm', 'xs', 'xs', 'sm', 'xs']}
      />
    </SkeletonRegion>
  );
}

function AddParticipantForm({
  users,
  pending,
  onCancel,
  onSubmit,
}: {
  users: any[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: any) => void;
}) {
  const t = useTranslations('cycles');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const [type, setType] = useState('CORE_PARTNER');

  return (
    <ValidatedForm
      className="mt-4 space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const userId = String(fd.get('userId') || '');
        const fee = String(fd.get('investorFeePct') || '');
        const custom = String(fd.get('customProfitPct') || '');
        onSubmit({
          participantType: type,
          // The field the server reads depends on the kind of participant.
          ...(type === 'TEMP_INVESTOR' ? { investorUserId: userId } : { partnerUserId: userId }),
          contributionAmount: Number(fd.get('contributionAmount') || 0),
          ...(custom ? { customProfitPct: Number(custom) } : {}),
          ...(type === 'TEMP_INVESTOR' && fee ? { investorFeePct: Number(fee) } : {}),
        });
      }}
    >
      <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('participantType')}</label>
          <Select
            name="participantType"
            value={type}
            placeholder={tph('chooseParticipantType')}
            onChange={setType}
            options={[
              { value: 'CORE_PARTNER', label: t('corePartner') },
              { value: 'TEMP_INVESTOR', label: t('tempInvestor') },
            ]}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('person')}</label>
          <Select
            name="userId"
            required
            placeholder={tph('choosePerson')}
            searchPlaceholder={tph('searchPeople')}
            /* Only people who can actually hold a share.
             *
             * This listed every user, including the storefront logins, and
             * picking one put a shop owner on a cycle — a share of the
             * partners' profit at settlement and every cycle notification
             * with everyone's figures in it. The server refuses it now; the
             * form should not have offered it in the first place.
             *
             * Same rule as `assertCanParticipate`, stated where the choice is
             * made rather than only where it is rejected. */
            options={users
              .filter(
                (u) =>
                  u.status === 'ACTIVE' &&
                  (u.role === 'CORE_PARTNER' || u.role === 'TEMP_INVESTOR'),
              )
              .map((u) => ({
                value: u.id,
                label: u.partner?.displayName ?? u.email,
                hint: u.email,
              }))}
          />
        </div>
      </div>

      <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('contribution')}</label>
          <MoneyInput
            name="contributionAmount" required placeholder={tph('money')}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            {t('customProfitPct')} <span className="text-xs font-normal text-gray-400">({tc('optional')})</span>
          </label>
          <input
            name="customProfitPct" type="number" step="0.01" min="0" max="100"
            placeholder={tph('percent')} {...selectOnFocus}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">{t('byContributionHint')}</p>
        </div>
        {type === 'TEMP_INVESTOR' && (
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              {t('investorFeePct')} <span className="text-xs font-normal text-gray-400">({tc('optional')})</span>
            </label>
            <input
              name="investorFeePct" type="number" step="0.01" min="0" max="100"
              placeholder={tph('percent')} {...selectOnFocus}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <p className="mt-1 text-[10px] text-gray-400">{t('feeFromProfit')}</p>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3">
        <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">
          {tc('cancel')}
        </button>
        <button
          type="submit" disabled={pending}
          className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {tc('save')}
        </button>
      </div>
    </ValidatedForm>
  );
}

/** Profit as the analytics figure states it — revenue less cost of goods sold, plus refunds, less losses, less expenses charged to the cycle, plus its other income. */
function ProfitCard({ figure }: { figure?: CycleProfit }) {
  const t = useTranslations('cycles');
  return (
    <div data-testid="cycle-profit-card" className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        <TrendingUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        {t('profit')}
      </h2>
      {!figure ? (
        <p className="text-sm text-muted-foreground">{t('profitNotYet')}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <dt className="text-xs text-muted-foreground">{t('profit')}</dt>
            <dd data-testid="cycle-profit-value" className={`text-lg font-bold ${figure.profit > 0 ? 'text-success' : figure.profit < 0 ? 'text-destructive' : 'text-foreground'}`}>
              <Money value={figure.profit} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('roi')}</dt>
            <dd className="text-lg font-bold text-foreground">
              {figure.roiPct === null ? '—' : <span dir="ltr">{figure.roiPct}%</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('profitRevenue')}</dt>
            <dd className="text-sm text-foreground"><Money value={figure.totalRevenue} /></dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('profitCost')}</dt>
            <dd className="text-sm text-foreground"><Money value={figure.totalCost} /></dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('profitLosses')}</dt>
            <dd data-testid="cycle-profit-losses" className="text-sm text-foreground"><Money value={figure.lossesEgp ?? 0} /></dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('profitExpenses')}</dt>
            <dd data-testid="cycle-profit-expenses" className="text-sm text-foreground"><Money value={figure.expensesEgp ?? 0} /></dd>
          </div>
          {!!figure.otherIncomeEgp && (
            <div>
              <dt className="text-xs text-muted-foreground">{t('profitOtherIncome')}</dt>
              <dd data-testid="cycle-profit-other-income" className="text-sm text-foreground"><Money value={figure.otherIncomeEgp} /></dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-bold text-gray-900">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">{icon}{title}</h2>
      {children}
    </div>
  );
}

const Rows = ({ children }: { children: React.ReactNode }) => (
  <div className="divide-y divide-gray-100">{children}</div>
);
const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-2 items-center gap-2 py-2 sm:grid-cols-5">{children}</div>
);
