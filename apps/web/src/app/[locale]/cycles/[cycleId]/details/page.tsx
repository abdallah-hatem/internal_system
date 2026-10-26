'use client';
import { GoodsLocationCards, GoodsLocationSkeleton } from '@/components/cycles/goods-location-cards';
import { CycleTransfersSection, MoveLeftoversButton, useCycleTransfers } from '@/components/cycles/cycle-transfers';
import { LatinText } from '@/components/ui/latin-text';

/**
 * Everything a cycle contains, at any point in its life.
 *
 * The list gave a cycle two fates: one still in the wizard opened the wizard,
 * and one past it opened a drawer of counts — "participants: 0", "purchases:
 * 1" — with no way to see what those were. A closed cycle, the one you most
 * want to look back at, showed the least.
 *
 * This page is readable in every status. Its money in — the target, what
 * each partner paid, the contributions, the profit split and who is on the
 * cycle — is one Funding card (owner 2026-10-26, `funding-card.tsx`).
 */

import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { localName } from '@/lib/localized-name';
import { useRef, useState } from 'react';
import { api } from '../../../../../lib/api';
import { Money } from '../../../../../components/ui/money';
import { ShoppingCart, Boxes, Scale, TrendingUp } from '@/components/ui/icons';
import { BackLink } from '../../../../../components/ui/back-link';
import { ContinueSetupLink } from '@/components/cycles/continue-setup';
import { CycleStatusButton } from '@/components/cycles/cycle-status-button';
import { useCodeLabel } from '../../../../../lib/labels';
import { useDateFormat } from '../../../../../lib/dates';
import { ShipmentPanel, ShipmentPanelSkeleton, useShipment } from '../../../../../components/shipment/ShipmentPanel';
import { useCan } from '@/lib/can';
import { EmptyState } from '@/components/ui/empty-state';
import { PaidByFriend } from '@/components/lenders/paid-by-friend';
import { SkeletonRegion, Skeleton, SkeletonText, repeat, type SkeletonTextSize } from '@/components/ui/skeleton';
import { viewPath } from '@/lib/page-views';
import { FundingCard, FundingCardSkeleton } from '@/components/cycles/funding-card';
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

export default function CycleDetailsPage() {
  const t = useTranslations('cycles');
  const { cycleId: id, locale } = useParams<{ cycleId: string; locale: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  // The funding note's way to a friend's payment (owner 2026-10-18), now a
  // line at the top of the Funding card.
  const [financingOpen, setFinancingOpen] = useState(false);
  const [financingPrefill, setFinancingPrefill] = useState(false);
  const financingRef = useRef<HTMLDivElement>(null);
  const scrollTo = (el: HTMLElement | null) =>
    // After the render that opens it, so it lands on the open form.
    window.setTimeout(() => el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 0);
  const canAddPurchase = useCan('purchase.create');
  const canFinance = useCan('lender.finance');

  const { data: cycle, isLoading } = useQuery<any>({
    queryKey: ['cycle', id],
    queryFn: () => api.get(`/cycles/${id}`).then((r) => r.data.data ?? r.data),
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
  const lenderPaid = num(costing?.totals?.lenderFinancedEgp);
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

      {/* The money in, in one card (owner 2026-10-26): the target and paid so
          far, the contributions, the profit split and who is on the cycle. */}
      <FundingCard
        cycle={cycle}
        totals={costing?.totals}
        lenderNames={lenderNames}
        canFinance={canFinance && orders.length > 0 && !financingClosed && !fullyPaidByFriends}
        onPaidByLender={() => {
          setFinancingPrefill(true);
          setFinancingOpen(true);
          scrollTo(financingRef.current);
        }}
      />

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

      <FundingCardSkeleton />

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
