'use client';
import { LatinText } from '@/components/ui/latin-text';

import { useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { localName } from '@/lib/localized-name';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, PackageCheck, PackageX, Plus, Send, Trash2, Undo2, HandCoins, Truck, MapPin, Edit } from 'lucide-react';
import { nextLegToAdd } from '@/components/cycles/leg-plan';
import { LegCreateForm, LegEditForm, type LegRow } from './LegForm';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { useCodeLabel } from '@/lib/labels';
import { useDateFormat } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { Money } from '@/components/ui/money';
import { useNumberFormat } from '@/lib/numbers';
import { LegRoute } from './LegRoute';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/ui/data-table';
import { useToast } from '@/components/ui/toast';
import { statusesToWalk } from '@/components/cycles/wizard-walk';
import { useRefreshShipment } from './ShipmentDialog';
import { RecordDeliveryDialog } from './RecordDeliveryDialog';
import { RecordDepartureDialog } from './RecordDepartureDialog';
import { ReceiveDeliveryDialog } from './ReceiveDeliveryDialog';
import { MarkLostDialog } from './MarkLostDialog';
import { RecordRefundDialog, type RefundPayer } from './RecordRefundDialog';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { UndoRefundDialog } from './UndoRefundDialog';
import {
  FROZEN_STATUSES,
  RECEIVING_STATUSES,
  hasWaitingToLeave,
  isWaiting,
  legCounts,
  legLineProgress,
  legNeedsAttention,
  losableByLine,
  lossRecovery,
  num,
  refundStands,
  shipmentProgress,
  type LegCount,
  type Shipment,
  type ShipmentLeg,
} from './shipment-model';

/** The cycle as `GET /cycles/:id` returns it — only what the panel reads. */
export interface PanelCycle {
  id: string;
  status: string;
  originType: string;
  /** The leg rows `GET /cycles/:id` returns — the edit form starts from them. */
  shippingLegs?: (Partial<LegRow> & {
    id: string;
    providerId?: string | null;
    provider?: string | null;
    /** The leg's cost in EGP, shown in its header. */
    amountEgp?: number | string | null;
    /** The cost as entered, in its own currency — shown first when it is not pounds. */
    amount?: number | string | null;
    currency?: string;
  })[];
  purchaseOrders?: {
    supplierId?: string | null;
    supplier?: { id: string; name: string } | null;
    items?: { id: string }[];
  }[];
}

/** Which dialog is open. One value, so every way of closing clears all of it. */
type Open =
  | { kind: 'addLeg' }
  | { kind: 'editLeg'; legId: string }
  | { kind: 'departure'; legId: string }
  | { kind: 'undoDeparture'; departureId: string }
  | { kind: 'delivery'; legId: string }
  | { kind: 'lost'; legId: string }
  | { kind: 'receive'; legId: string; deliveryId: string }
  | { kind: 'deleteDelivery'; deliveryId: string }
  | { kind: 'refund'; legId: string; lossId: string }
  | { kind: 'takeBack'; lossId: string }
  | { kind: 'undoRefund'; legId: string; lossId: string; refundId: string }
  | null;

/**
 * What the signed-in person may do in the panel, one flag per button, each from
 * the endpoint's own `@Roles` (lib/permissions.ts). An investor reads the
 * shipment — every count, delivery, loss and refund — and is offered nothing
 * the server would refuse (R1b).
 */
type ShipmentPermissions = ReturnType<typeof useShipmentPermissions>;
function useShipmentPermissions() {
  return {
    transition: useCan('cycle.transition'),
    // POST /shipping/legs/:id/departures and DELETE /shipping/departures/:id (L8).
    recordDeparture: useCan('shipment.recordDeparture'),
    undoDeparture: useCan('shipment.undoDeparture'),
    createLeg: useCan('shippingLeg.create'),
    // PUT /shipping/legs/:id — the Shipments page's edit form, here too.
    editLeg: useCan('shippingLeg.edit'),
    recordDelivery: useCan('shipment.recordDelivery'),
    deleteDelivery: useCan('shipment.deleteDelivery'),
    markLost: useCan('shipment.markLost'),
    takeBack: useCan('shipment.takeBack'),
    recordRefund: useCan('shipment.recordRefund'),
    undoRefund: useCan('shipment.undoRefund'),
    receive: useCan('inventory.receive'),
  };
}

/** The cycle's shipment, one cache entry per cycle — the inventory list reads the same one. */
export function useShipment(cycleId: string | undefined) {
  return useQuery<Shipment>({
    queryKey: ['shipment', cycleId],
    queryFn: () => api.get(`/cycles/${cycleId}/shipment`).then((r) => r.data.data ?? r.data),
    enabled: !!cycleId,
  });
}

/** How many product lines the placeholder leg shows. */
const SKELETON_LINES = 2;

type LegLine = ShipmentLeg['lines'][number];

/**
 * A leg's product table (components/ui/data-table.tsx), shared by the panel
 * and its placeholder: the product — which takes what is left and wraps to
 * two lines — then a count per stage and the progress bar. Each count column
 * fits its title in English and Arabic ("بانتظار الاستلام" sets Waiting's).
 */
function useLegColumns(
  productNames: Record<string, string>,
  ordered: Map<string, number>,
  /** The counts this leg shows (`legCounts`); every one when absent — the placeholder. */
  counts?: LegCount[],
): Column<LegLine>[] {
  const t = useTranslations('shipment');
  const { formatNumber } = useNumberFormat();
  const count = (key: string, id: string, header: string, width: string, value: (l: LegLine) => number | null): Column<LegLine> => ({
    key, header, width, kind: 'value', align: 'end', className: 'text-foreground',
    cellProps: () => ({ 'data-testid': id }), skeleton: { kind: 'text', share: 'w-1/4' },
    cell: (line) => {
      const v = value(line);
      return v === null ? '—' : formatNumber(v, { maximumFractionDigits: 3 });
    },
  });
  const columns: Column<LegLine>[] = [
    {
      key: 'product', header: t('product'), width: 'auto', kind: 'name', className: 'font-medium text-foreground',
      title: (line) => productNames[line.purchaseOrderItemId], skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (line) => <LatinText>{productNames[line.purchaseOrderItemId]}</LatinText>,
    },
    count('ordered', 'line-ordered', t('ordered'), '5.5rem', (l) => ordered.get(l.purchaseOrderItemId) ?? 0),
    count('atOrigin', 'line-at-origin', t('atOriginCol'), '5rem', (l) => num(l.atOrigin)),
    count('delivered', 'line-delivered', t('delivered'), '5.5rem', (l) => l.delivered),
    count('received', 'line-received', t('receivedCol'), '5.5rem', (l) => l.received),
    count('waiting', 'line-waiting', t('waiting'), '6rem', (l) => l.waiting),
    count('lost', 'line-lost', t('lost'), '4.5rem', (l) => l.lost),
    count('onTheWay', 'line-on-the-way', t('onTheWay'), '5.5rem', (l) => l.onTheWay),
    {
      key: 'progress', header: t('progress'), width: '8rem', headerClassName: 'ps-4', className: 'ps-4',
      skeleton: { kind: 'custom', render: () => <Skeleton className="h-1.5 w-full rounded-full" /> },
      cell: (line) => <Progress value={legLineProgress(line)} label={t('progressLabel')} />,
    },
  ];
  return counts ? columns.filter((c) => c.key === 'product' || c.key === 'progress' || counts.includes(c.key as LegCount)) : columns;
}

/**
 * The panel before the shipment arrives, traced from the panel and one
 * `LegBlock`: the title and totals, the leg heading over its status badge,
 * the product table (cards on a phone), and the departures heading.
 */
function PlainFrame({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={className}>{children}</div>;
}

export function ShipmentPanelSkeleton({ inside = false }: { inside?: boolean }) {
  // Inside another skeleton (the cycle page's), that one already says "Loading".
  const Frame = inside ? PlainFrame : SkeletonRegion;
  // The table's real titles: they need no data.
  const columns = useLegColumns({}, new Map());
  return (
    <Frame className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SkeletonText className="w-24" />
        <SkeletonText size="xs" className="w-64 max-w-full" />
      </div>
      <div className="space-y-3">
        <div className="min-w-0">
          <SkeletonText className="w-40" />
          <div className="mt-0.5 flex items-center gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <SkeletonText size="xs" className="w-24" />
          </div>
        </div>
        <DataTable
          className="hidden md:block"
          frame="none"
          density="compact"
          autoMin="10rem"
          isLoading
          skeletonRows={SKELETON_LINES}
          rows={[]}
          rowKey={(l) => l.purchaseOrderItemId}
          columns={columns}
        />
        <div className="space-y-2 md:hidden">
          {repeat(SKELETON_LINES, (i) => (
            <div key={i} data-testid="skeleton-row" className="rounded-lg border border-border p-3">
              <SkeletonText className="w-40" />
              <div className="mt-2 grid grid-cols-3 gap-2">
                {repeat(7, (j) => (
                  <div key={j}>
                    <SkeletonText size="xs" className="w-14" />
                    <SkeletonText size="xs" className="w-6" />
                  </div>
                ))}
              </div>
              <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
            </div>
          ))}
        </div>
        <div>
          <SkeletonText size="xs" lineClassName="mb-1" className="w-20" />
          <SkeletonText className="w-36" />
        </div>
      </div>
    </Frame>
  );
}

/**
 * The cycle page's Shipment panel (BUSINESS_LOGIC §1, §2, §3, §6 — 2026-10-10).
 *
 * One block per leg. In each, a row per product: ordered, delivered,
 * received and waiting (on the last leg), lost, on the way, with a bar for how
 * much of what entered the leg is accounted for. Then the leg's deliveries and
 * losses, each with what can be done to it. Every number is the server's
 * `shipmentPosition`; the panel adds nothing up.
 */
export function ShipmentPanel({ cycle }: { cycle: PanelCycle }) {
  const t = useTranslations('shipment');
  const apiError = useApiError();
  const toast = useToast();
  const refresh = useRefreshShipment();
  const { data: shipment, isLoading, isError } = useShipment(cycle.id);
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const [walking, setWalking] = useState(false);
  const walkingRef = useRef(false);
  const may = useShipmentPermissions();

  const locale = useLocale();
  const productNames = useMemo(
    () => Object.fromEntries((shipment?.lines ?? []).map((l) => [l.purchaseOrderItemId, localName({ name: l.productName, nameAr: l.productNameAr }, locale) || '—'])),
    [shipment, locale],
  );
  const ordered = useMemo(
    () => new Map((shipment?.lines ?? []).map((l) => [l.purchaseOrderItemId, l.ordered])),
    [shipment],
  );

  if (isLoading) {
    return <ShipmentPanelSkeleton />;
  }
  if (isError || !shipment) {
    return <p className="rounded-xl border border-border p-5 text-sm text-muted-foreground">{t('loadFailed')}</p>;
  }

  const status = shipment.status ?? cycle.status;
  const frozen = FROZEN_STATUSES.includes(status);
  // The route's first leg not recorded yet — a China cycle's Dubai → Egypt
  // leg, added once leg 1 has left, or any leg never added. The same create
  // form as the Shipments page (§13), for this cycle.
  const nextLeg = nextLegToAdd(cycle.originType, (shipment.legs ?? []).map((l) => l.sequence));
  const canAddLeg = may.createLeg && !frozen && !!nextLeg;
  const canReceive = RECEIVING_STATUSES.includes(status);
  const legs = shipment.legs ?? [];
  const legById = (id: string) => legs.find((l) => l.legId === id);

  // A last-leg delivery the cycle has not caught up with yet: receiving opens at
  // Arrived Egypt, so offer the walk there, through the same steps the wizard
  // takes (one definition, `statusesToWalk`), each checked again by the server.
  const walk = frozen
    ? []
    : statusesToWalk(
        cycle.originType,
        status,
        legs.map((l) => ({ sequence: l.sequence, departedOn: l.departedOn ?? null, status: l.status })),
      );
  const canWalkToEgypt = may.transition && !canReceive && walk.includes('ARRIVED_EGYPT');

  const walkToEgypt = async () => {
    if (walkingRef.current) return;
    walkingRef.current = true;
    setWalking(true);
    try {
      for (const next of walk) {
        await api.post(`/cycles/${cycle.id}/transition`, { status: next });
        if (next === 'ARRIVED_EGYPT') break;
      }
      toast.success(t('arrivedEgyptDone'));
    } catch (err) {
      toast.error(apiError(err, t('arrivedEgyptFailed')));
    } finally {
      refresh();
      walkingRef.current = false;
      setWalking(false);
    }
  };

  const payersFor = (legId: string, purchaseOrderItemId: string): RefundPayer[] => {
    const payers: RefundPayer[] = [];
    const legRow = cycle.shippingLegs?.find((l) => l.id === legId);
    if (legRow?.providerId) {
      payers.push({ type: 'SHIPPING_PROVIDER', id: legRow.providerId, name: legRow.provider ?? '—' });
    }
    const order = cycle.purchaseOrders?.find((po) => po.items?.some((i) => i.id === purchaseOrderItemId));
    const supplierId = order?.supplier?.id ?? order?.supplierId;
    if (supplierId) {
      payers.push({ type: 'SUPPLIER', id: supplierId, name: order?.supplier?.name ?? '—' });
    }
    return payers;
  };

  return (
    <section data-testid="shipment-panel" className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Truck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('title')}
        </h2>
        <div className="flex flex-wrap items-center gap-3">
        {legs.length > 0 && (
          <p data-testid="shipping-total" className="text-xs text-muted-foreground">
            {t('shippingTotal')}{' '}
            <span className="font-semibold text-foreground">
              <Money value={(cycle.shippingLegs ?? []).reduce((sum, l) => sum + num(l.amountEgp), 0)} />
            </span>
          </p>
        )}
        {canAddLeg && legs.length > 0 && (
          <button
            type="button"
            data-testid="add-next-leg"
            onClick={() => setOpen({ kind: 'addLeg' })}
            className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted sm:min-h-0"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> {t('addLeg', { leg: nextLeg!.sequence })}
          </button>
        )}
        </div>
      </div>
      {/* One bar and one line for the whole order: how much is in stock, and
          only the counts that are not settled — the old line listed six. */}
      {shipment.totals.ordered > 0 && (
        <>
          <Progress className="h-2" value={shipmentProgress(shipment.totals)} label={t('progressLabel')} />
          <p data-testid="shipment-totals" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t.rich('inStock', {
                received: shipment.totals.received,
                ordered: shipment.totals.ordered,
                b: (chunks) => <span className="font-semibold text-foreground">{chunks}</span>,
              })}
            </span>
            {(shipment.totals.atOrigin ?? 0) > 0 && <span>{t('notLeftCount', { count: shipment.totals.atOrigin ?? 0 })}</span>}
            <span>{t('onTheWayCount', { count: shipment.totals.onTheWay })}</span>
            {shipment.totals.waiting > 0 && <span>{t('toReceiveCount', { count: shipment.totals.waiting })}</span>}
            <span>{t('lostCount', { count: shipment.totals.lost })}</span>
          </p>
        </>
      )}
      </div>

      {canWalkToEgypt && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2 text-sm">
          <span className="text-foreground">{t('arrivedEgyptPrompt')}</span>
          <button
            type="button"
            data-testid="walk-to-egypt"
            onClick={() => void walkToEgypt()}
            disabled={walking}
            className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
          >
            <MapPin className="h-4 w-4" aria-hidden="true" />
            {t('arrivedEgypt')}
          </button>
        </div>
      )}

      {legs.length === 0 ? (
        <EmptyState
          title={t('noLegs')}
          description={t('noLegsHint')}
          icon={Truck}
          // Added here, with the same form as the Shipments page (§13).
          action={canAddLeg ? { label: t('addLeg', { leg: nextLeg!.sequence }), onClick: () => setOpen({ kind: 'addLeg' }) } : undefined}
        />
      ) : shipment.lines.length === 0 ? (
        <EmptyState title={t('nothingOrdered')} icon={Truck} />
      ) : (
        <div className="space-y-3">
          {legs.map((leg) => (
            <LegBlock
              key={leg.legId}
              leg={leg}
              meta={cycle.shippingLegs?.find((l) => l.id === leg.legId)}
              productNames={productNames}
              ordered={ordered}
              frozen={frozen}
              canReceive={canReceive}
              may={may}
              onOpen={setOpen}
            />
          ))}
        </div>
      )}

      {/* Dialogs portal to <body>; the ids are looked up again so they always show the latest figures. */}
      {open?.kind === 'addLeg' && nextLeg && (
        <LegCreateForm
          title={t('addLeg', { leg: nextLeg.sequence })}
          testId="add-leg"
          fixedCycleId={cycle.id}
          defaults={nextLeg}
          onDone={close}
        />
      )}
      {open?.kind === 'editLeg' && (() => {
        const row = cycle.shippingLegs?.find((l) => l.id === open.legId);
        const position = legById(open.legId);
        if (!row || !position) return null;
        const leg: LegRow = {
          ...row,
          cycleId: cycle.id,
          sequence: position.sequence,
          origin: position.origin ?? row.origin ?? '',
          destination: position.destination ?? row.destination ?? '',
          status: position.status,
          departedOn: position.departedOn ?? null,
          arrivedOn: position.arrivedOn,
        };
        return (
          <LegEditForm
            title={t('editLegTitle', { leg: position.sequence })}
            testId="edit-leg"
            leg={leg}
            onDone={close}
            onCyclePage
          />
        );
      })()}
      {open?.kind === 'departure' && legById(open.legId) && (
        <RecordDepartureDialog leg={legById(open.legId)!} productNames={productNames} onClose={close} />
      )}
      {open?.kind === 'undoDeparture' && (
        <ConfirmActionDialog
          testId="undo-departure"
          title={t('undoDepartureTitle')}
          message={t('undoDepartureConfirm')}
          confirmLabel={t('undoDeparture')}
          successMessage={t('departureUndone')}
          failMessage={t('undoDepartureFailed')}
          action={() => api.delete(`/shipping/departures/${open.departureId}`)}
          onClose={close}
        />
      )}
      {open?.kind === 'delivery' && legById(open.legId) && (
        <RecordDeliveryDialog leg={legById(open.legId)!} productNames={productNames} onClose={close} />
      )}
      {open?.kind === 'lost' && legById(open.legId) && (
        <MarkLostDialog cycleId={cycle.id} leg={legById(open.legId)!} productNames={productNames} onClose={close} />
      )}
      {open?.kind === 'receive' && (() => {
        const leg = legById(open.legId);
        const delivery = leg?.deliveries.find((d) => d.id === open.deliveryId);
        return leg && delivery ? (
          <ReceiveDeliveryDialog
            cycleId={cycle.id}
            leg={leg}
            delivery={delivery}
            productNames={productNames}
            onClose={close}
          />
        ) : null;
      })()}
      {open?.kind === 'deleteDelivery' && (
        <ConfirmActionDialog
          testId="delete-delivery"
          title={t('deleteDeliveryTitle')}
          message={t('deleteDeliveryConfirm')}
          confirmLabel={t('deleteDelivery')}
          successMessage={t('deliveryDeleted')}
          failMessage={t('deleteDeliveryFailed')}
          action={() => api.delete(`/shipping/deliveries/${open.deliveryId}`)}
          onClose={close}
        />
      )}
      {open?.kind === 'takeBack' && (
        <ConfirmActionDialog
          testId="take-back-loss"
          title={t('takeBackTitle')}
          message={t('takeBackConfirm')}
          confirmLabel={t('takeBack')}
          successMessage={t('lossTakenBack')}
          failMessage={t('takeBackFailed')}
          action={() => api.delete(`/shipping/losses/${open.lossId}`)}
          onClose={close}
        />
      )}
      {open?.kind === 'undoRefund' && (() => {
        const refund = legById(open.legId)
          ?.losses?.find((l) => l.id === open.lossId)
          ?.refunds?.find((r) => r.id === open.refundId);
        return refund ? <UndoRefundDialog refund={refund} onClose={close} /> : null;
      })()}
      {open?.kind === 'refund' && (() => {
        const loss = legById(open.legId)?.losses?.find((l) => l.id === open.lossId);
        return loss ? (
          <RecordRefundDialog
            loss={loss}
            productName={productNames[loss.purchaseOrderItemId] ?? '—'}
            payers={payersFor(open.legId, loss.purchaseOrderItemId)}
            onClose={close}
          />
        ) : null;
      })()}
    </section>
  );
}

function LegBlock({
  leg,
  meta,
  productNames,
  ordered,
  frozen,
  canReceive,
  may,
  onOpen,
}: {
  leg: ShipmentLeg;
  /** The leg row from the cycle: who carries it and what it costs. */
  meta?: NonNullable<PanelCycle['shippingLegs']>[number];
  productNames: Record<string, string>;
  ordered: Map<string, number>;
  frozen: boolean;
  canReceive: boolean;
  may: ShipmentPermissions;
  onOpen: (open: Open) => void;
}) {
  const t = useTranslations('shipment');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const losable = Object.values(losableByLine(leg)).some((q) => q > 0);
  const losses = leg.losses ?? [];
  const counts = legCounts(leg);
  const shows = (c: LegCount) => counts.includes(c);
  const columns = useLegColumns(productNames, ordered, counts);
  // A leg still asking for something opens; a finished one is one line until asked.
  const [expanded, setExpanded] = useState(() => legNeedsAttention(leg));
  const detailsId = `leg-details-${leg.legId}`;
  const amountEgp = num(meta?.amountEgp);
  const ownCurrency = meta?.currency && meta.currency !== 'EGP' && meta.amount != null ? meta.currency : null;

  return (
    <div
      data-testid="shipment-leg"
      data-leg-id={leg.legId}
      data-leg-sequence={leg.sequence}
      data-expanded={expanded}
      className="rounded-lg border border-border"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 p-3">
        <div className="min-w-0">
          {/* The leg number and the route are separate flex items, so a Latin
              route cannot run into the number in Arabic (UI audit #11). */}
          {/* The status sits on the title's line as a coloured dot and word
              (owner 2026-10-17: a grey pill under the title read oddly). */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold text-foreground">
              <span className="whitespace-nowrap">{t('legHeading', { leg: leg.sequence })}</span>
              <LegRoute origin={leg.origin} destination={leg.destination} className="font-normal text-muted-foreground" />
            </h3>
            <LegStatusMark testId="leg-status" status={leg.status} label={codeLabel('legStatus', leg.status)} />
            {/* Partly arrived and partly departed at once: the status says
                the furthest thing that happened, this says the rest (L8). */}
            {leg.status === 'PARTLY_ARRIVED' && hasWaitingToLeave(leg) && (
              <LegStatusMark testId="leg-partly-departed" status="PARTLY_DEPARTED" label={t('partlyDeparted')} />
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {/* A leg that has not left is said once, by the badge — the date
                slot only appears with a date in it. */}
            {leg.departedOn && (
              <span data-testid="leg-departure">{t('departedOn', { date: formatDate(leg.departedOn) })}</span>
            )}
            {leg.arrivedOn && <span>{t('arrivedOn', { date: formatDate(leg.arrivedOn) })}</span>}
            {/* Who carries it — the old Shipping card's column (I3). */}
            {meta?.provider && (
              <span data-testid="leg-provider">
                <LatinText>{meta.provider}</LatinText>
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
        {/* What it cost, where the eye lands: a cost of nothing on a leg
            that carried goods is a bill still to come, and says so. */}
        {meta && (
          <div data-testid="leg-cost" className="text-end">
            {amountEgp === 0 ? (
              <p data-testid="leg-no-cost" className="text-sm font-semibold text-accent-600">{t('noCostYet')}</p>
            ) : ownCurrency ? (
              <p className="text-sm font-semibold text-foreground"><Money value={num(meta.amount)} currency={ownCurrency} /></p>
            ) : null}
            <p className={cn(amountEgp === 0 || ownCurrency ? 'text-xs text-muted-foreground' : 'text-sm font-semibold text-foreground')}>
              <Money value={amountEgp} />
            </p>
          </div>
        )}
        {!frozen && (
          <div className="flex flex-wrap gap-2">
            {/* While anything waits at the leg's origin, another departure
                (L8); while anything is on the way, a delivery. Both at once
                when goods left in parts. */}
            {may.recordDeparture && hasWaitingToLeave(leg) && (
              <button
                type="button"
                data-testid="record-departure"
                onClick={() => onOpen({ kind: 'departure', legId: leg.legId })}
                className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-0"
              >
                <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" /> {t('recordDeparture')}
              </button>
            )}
            {may.recordDelivery && leg.onTheWay > 0 && (
              <button
                type="button"
                data-testid="record-delivery"
                onClick={() => onOpen({ kind: 'delivery', legId: leg.legId })}
                className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-0"
              >
                <Plus className="h-4 w-4" aria-hidden="true" /> {t('recordDelivery')}
              </button>
            )}
            {may.editLeg && (
              <button
                type="button"
                data-testid="edit-leg"
                onClick={() => onOpen({ kind: 'editLeg', legId: leg.legId })}
                className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted sm:min-h-0"
              >
                <Edit className="h-4 w-4" aria-hidden="true" /> {t('editLeg')}
              </button>
            )}
            {may.markLost && losable && (
              <button
                type="button"
                data-testid="mark-lost"
                onClick={() => onOpen({ kind: 'lost', legId: leg.legId })}
                className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted sm:min-h-0"
              >
                <PackageX className="h-4 w-4" aria-hidden="true" /> {t('markLost')}
              </button>
            )}
          </div>
        )}
        <button
          type="button"
          data-testid="leg-toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={expanded ? t('hideDetails') : t('showDetails')}
          title={expanded ? t('hideDetails') : t('showDetails')}
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground sm:min-h-9 sm:min-w-9"
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
        </button>
        </div>
      </div>

      {expanded && (
      <div id={detailsId} data-testid="leg-details" className="space-y-3 border-t border-border p-3">
      {/* Desktop: a table. Phone: a card per product. */}
      <DataTable
        className="hidden md:block"
        frame="none"
        density="compact"
        autoMin="10rem"
        rows={leg.lines}
        rowKey={(line) => line.purchaseOrderItemId}
        rowProps={(line) => ({ 'data-testid': 'shipment-line', 'data-product': productNames[line.purchaseOrderItemId] })}
        columns={columns}
      />
      <ul className="space-y-2 md:hidden">
        {leg.lines.map((line) => (
          <li
            key={line.purchaseOrderItemId}
            data-testid="shipment-line"
            data-product={productNames[line.purchaseOrderItemId]}
            className="rounded-lg border border-border p-3"
          >
            <p className="break-words text-sm font-medium text-foreground">{productNames[line.purchaseOrderItemId]}</p>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <Stat id="line-ordered" label={t('ordered')} value={ordered.get(line.purchaseOrderItemId) ?? 0} />
              {shows('atOrigin') && <Stat id="line-at-origin" label={t('atOriginCol')} value={num(line.atOrigin)} />}
              <Stat id="line-delivered" label={t('delivered')} value={line.delivered} />
              {shows('onTheWay') && <Stat id="line-on-the-way" label={t('onTheWay')} value={line.onTheWay} />}
              {shows('received') && <Stat id="line-received" label={t('receivedCol')} value={line.received} />}
              {shows('waiting') && <Stat id="line-waiting" label={t('waiting')} value={line.waiting} />}
              {shows('lost') && <Stat id="line-lost" label={t('lost')} value={line.lost} />}
            </dl>
            <Progress className="mt-2" value={legLineProgress(line)} label={t('progressLabel')} />
          </li>
        ))}
      </ul>

      {/* Departures (L8): each day goods left, with Undo where the server allows it. */}
      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('departures')}</h4>
        {(leg.departures ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noDepartures')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {(leg.departures ?? []).map((d) => (
              <li key={d.id} data-testid="shipment-departure" className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{formatDate(d.departedOn)}</p>
                  <ul data-testid="departure-summary" className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {d.lines.map((l) => (
                      <li key={l.purchaseOrderItemId}>
                        {t.rich('departureLine', {
                          product: productNames[l.purchaseOrderItemId] ?? '—',
                          qty: l.qty,
                          name: (chunks) => <LatinText>{chunks}</LatinText>,
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
                {may.undoDeparture && !frozen && d.undoable && (
                  <button
                    type="button"
                    data-testid="undo-departure"
                    onClick={() => onOpen({ kind: 'undoDeparture', departureId: d.id })}
                    className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground sm:min-h-0"
                  >
                    <Undo2 className="h-4 w-4" aria-hidden="true" /> {t('undoDeparture')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Deliveries */}
      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('deliveries')}</h4>
        {leg.deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noDeliveries')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {leg.deliveries.map((d) => {
              const waiting = isWaiting(d, leg);
              return (
                <li key={d.id} data-testid="shipment-delivery" className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{formatDate(d.arrivedOn)}</p>
                    {/* One item per product, each name isolated: joined into one
                        string, a Latin name dragged the quantities and the
                        separators to the wrong side in Arabic (UI audit #12). */}
                    <ul data-testid="delivery-summary" className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      {d.lines.map((l) => {
                        const values = {
                          product: productNames[l.purchaseOrderItemId] ?? '—',
                          qty: l.qty,
                          received: l.received,
                        };
                        return (
                          <li key={l.purchaseOrderItemId}>
                            {t.rich(leg.isLast ? 'deliveryLineLast' : 'deliveryLine', {
                              ...values,
                              name: (chunks) => <LatinText>{chunks}</LatinText>,
                            })}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {may.receive && waiting && canReceive && (
                      <button
                        type="button"
                        data-testid="receive-delivery"
                        onClick={() => onOpen({ kind: 'receive', legId: leg.legId, deliveryId: d.id })}
                        className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-0"
                      >
                        <PackageCheck className="h-4 w-4" aria-hidden="true" /> {t('receiveIntoStock')}
                      </button>
                    )}
                    {may.deleteDelivery && !frozen && (
                      <button
                        type="button"
                        data-testid="delete-delivery"
                        onClick={() => onOpen({ kind: 'deleteDelivery', deliveryId: d.id })}
                        aria-label={t('deleteDelivery')}
                        className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-destructive sm:min-h-8 sm:min-w-8"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Losses */}
      {losses.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('losses')}</h4>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {losses.map((loss) => {
              const { cost, refunded, unrecovered, hasRefunds } = lossRecovery(loss);
              return (
                <li key={loss.id} data-testid="shipment-loss" className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">
                      {t.rich('lossLine', {
                        product: productNames[loss.purchaseOrderItemId] ?? '—',
                        qty: num(loss.qty),
                        name: (chunks) => <LatinText>{chunks}</LatinText>,
                      })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(loss.createdAt)} · {t('lossCost')} <Money value={cost} /> · {t('refundedSoFar')}{' '}
                      <Money value={refunded} /> · {t('unrecovered')}{' '}
                      <span data-testid="loss-unrecovered"><Money value={unrecovered} /></span>
                    </p>
                    {loss.reason && <p className="text-xs text-muted-foreground">{loss.reason}</p>}
                    {(loss.refunds?.length ?? 0) > 0 && (
                      <ul aria-label={t('refundsOnLoss')} className="mt-1 space-y-1">
                        {loss.refunds!.map((r) => (
                          <li
                            key={r.id}
                            data-testid="loss-refund"
                            data-reversed={r.reversedAt ? 'true' : undefined}
                            className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                          >
                            {/* The amount is `Money`, like every other amount on the
                                panel — the string used to carry its own "ج.م" (#24). */}
                            <span data-testid="loss-refund-line" className={cn(!refundStands(r) && 'line-through')}>
                              {t.rich('refundLine', {
                                amount: () => <Money value={r.amountEgp} />,
                                payer: r.payerName ?? '—',
                                date: formatDate(r.recordedOn),
                                name: (chunks) => <LatinText>{chunks}</LatinText>,
                              })}
                            </span>
                            {refundStands(r) ? (may.undoRefund && (
                              <button
                                type="button"
                                data-testid="undo-refund"
                                onClick={() =>
                                  onOpen({ kind: 'undoRefund', legId: leg.legId, lossId: loss.id, refundId: r.id })
                                }
                                className="inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 font-medium text-muted-foreground hover:bg-muted hover:text-destructive sm:min-h-0"
                              >
                                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" /> {t('undoRefund')}
                              </button>
                            )) : (
                              <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
                                {t('refundUndoneBadge')}
                                {r.reversalReason ? ` · ${r.reversalReason}` : ''}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {may.recordRefund && unrecovered > 0 && (
                      <button
                        type="button"
                        data-testid="record-refund"
                        onClick={() => onOpen({ kind: 'refund', legId: leg.legId, lossId: loss.id })}
                        className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted sm:min-h-0"
                      >
                        <HandCoins className="h-4 w-4" aria-hidden="true" /> {t('recordRefund')}
                      </button>
                    )}
                    {/* A refunded loss cannot be taken back (§6): the goods would be paid for twice. */}
                    {may.takeBack && !frozen && !hasRefunds && (
                      <button
                        type="button"
                        data-testid="take-back-loss"
                        onClick={() => onOpen({ kind: 'takeBack', lossId: loss.id })}
                        className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground sm:min-h-0"
                      >
                        <Undo2 className="h-4 w-4" aria-hidden="true" /> {t('takeBack')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      </div>
      )}
    </div>
  );
}

/** A leg's status: what happened, by colour — arrived green, moving blue, half-way orange, not left grey. */
const STATUS_TONE: Record<string, { dot: string; text: string }> = {
  ARRIVED: { dot: 'bg-success', text: 'text-success' },
  IN_TRANSIT: { dot: 'bg-primary', text: 'text-primary' },
  PARTLY_ARRIVED: { dot: 'bg-accent-600', text: 'text-accent-600' },
  PARTLY_DEPARTED: { dot: 'bg-accent-600', text: 'text-accent-600' },
  PENDING: { dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
};

function LegStatusMark({ status, label, testId }: { status: string; label: string; testId: string }) {
  const tone = STATUS_TONE[status] ?? STATUS_TONE.PENDING;
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold', tone.text)}>
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', tone.dot)} />
      <span data-testid={testId} data-status={status}>{label}</span>
    </span>
  );
}

function Stat({ id, label, value }: { id: string; label: string; value: number | null }) {
  const { formatNumber } = useNumberFormat();
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-testid={id} className="font-medium tabular-nums text-foreground">
        {value === null ? '—' : formatNumber(value, { maximumFractionDigits: 3 })}
      </dd>
    </div>
  );
}

function Progress({ value, label, className }: { value: number; label: string; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div className="h-full rounded-full bg-primary" style={{ width: `${value}%` }} />
    </div>
  );
}
