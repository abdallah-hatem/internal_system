'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { PackageCheck, PackageX, Plus, Trash2, Undo2, HandCoins, Truck, MapPin } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCodeLabel } from '@/lib/labels';
import { useDateFormat } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { Money } from '@/components/ui/money';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { statusesToWalk } from '@/components/cycles/wizard-walk';
import { useRefreshShipment } from './ShipmentDialog';
import { RecordDeliveryDialog } from './RecordDeliveryDialog';
import { ReceiveDeliveryDialog } from './ReceiveDeliveryDialog';
import { MarkLostDialog } from './MarkLostDialog';
import { RecordRefundDialog, type RefundPayer } from './RecordRefundDialog';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import {
  FROZEN_STATUSES,
  RECEIVING_STATUSES,
  isWaiting,
  legLineProgress,
  losableByLine,
  lossRecovery,
  num,
  type Shipment,
  type ShipmentLeg,
} from './shipment-model';

/** The cycle as `GET /cycles/:id` returns it — only what the panel reads. */
export interface PanelCycle {
  id: string;
  status: string;
  originType: string;
  shippingLegs?: { id: string; providerId?: string | null; provider?: string | null }[];
  purchaseOrders?: {
    supplierId?: string | null;
    supplier?: { id: string; name: string } | null;
    items?: { id: string }[];
  }[];
}

/** Which dialog is open. One value, so every way of closing clears all of it. */
type Open =
  | { kind: 'delivery'; legId: string }
  | { kind: 'lost'; legId: string }
  | { kind: 'receive'; legId: string; deliveryId: string }
  | { kind: 'deleteDelivery'; deliveryId: string }
  | { kind: 'refund'; legId: string; lossId: string }
  | { kind: 'takeBack'; lossId: string }
  | null;

/** The cycle's shipment, one cache entry per cycle — the inventory list reads the same one. */
export function useShipment(cycleId: string | undefined) {
  return useQuery<Shipment>({
    queryKey: ['shipment', cycleId],
    queryFn: () => api.get(`/cycles/${cycleId}/shipment`).then((r) => r.data.data ?? r.data),
    enabled: !!cycleId,
  });
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

  const productNames = useMemo(
    () => Object.fromEntries((shipment?.lines ?? []).map((l) => [l.purchaseOrderItemId, l.productName ?? '—'])),
    [shipment],
  );
  const ordered = useMemo(
    () => new Map((shipment?.lines ?? []).map((l) => [l.purchaseOrderItemId, l.ordered])),
    [shipment],
  );

  if (isLoading) {
    return <div className="h-40 animate-pulse rounded-xl border border-border bg-muted" aria-hidden="true" />;
  }
  if (isError || !shipment) {
    return <p className="rounded-xl border border-border p-5 text-sm text-muted-foreground">{t('loadFailed')}</p>;
  }

  const status = shipment.status ?? cycle.status;
  const frozen = FROZEN_STATUSES.includes(status);
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
  const canWalkToEgypt = !canReceive && walk.includes('ARRIVED_EGYPT');

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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Truck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('title')}
        </h2>
        <p data-testid="shipment-totals" className="text-xs text-muted-foreground">
          {t('totals', {
            ordered: shipment.totals.ordered,
            received: shipment.totals.received,
            waiting: shipment.totals.waiting,
            lost: shipment.totals.lost,
            onTheWay: shipment.totals.onTheWay,
          })}
        </p>
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
        <EmptyState title={t('noLegs')} description={t('noLegsHint')} icon={Truck} />
      ) : shipment.lines.length === 0 ? (
        <EmptyState title={t('nothingOrdered')} icon={Truck} />
      ) : (
        <div className="space-y-6">
          {legs.map((leg) => (
            <LegBlock
              key={leg.legId}
              leg={leg}
              productNames={productNames}
              ordered={ordered}
              frozen={frozen}
              canReceive={canReceive}
              onOpen={setOpen}
            />
          ))}
        </div>
      )}

      {/* Dialogs portal to <body>; the ids are looked up again so they always show the latest figures. */}
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
  productNames,
  ordered,
  frozen,
  canReceive,
  onOpen,
}: {
  leg: ShipmentLeg;
  productNames: Record<string, string>;
  ordered: Map<string, number>;
  frozen: boolean;
  canReceive: boolean;
  onOpen: (open: Open) => void;
}) {
  const t = useTranslations('shipment');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const losable = Object.values(losableByLine(leg)).some((q) => q > 0);
  const route = [leg.origin, leg.destination].filter(Boolean).join(' → ');
  const losses = leg.losses ?? [];

  return (
    <div data-testid="shipment-leg" data-leg-sequence={leg.sequence} className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {t('legHeading', { leg: leg.sequence })}
            {route && <span className="ms-2 font-normal text-muted-foreground">{route}</span>}
          </h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span data-testid="leg-status" className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">
              {codeLabel('legStatus', leg.status)}
            </span>
            <span>{leg.departedOn ? t('departedOn', { date: formatDate(leg.departedOn) }) : t('notDeparted')}</span>
            {leg.arrivedOn && <span>{t('arrivedOn', { date: formatDate(leg.arrivedOn) })}</span>}
          </p>
        </div>
        {!frozen && (
          <div className="flex flex-wrap gap-2">
            {leg.onTheWay > 0 && leg.departedOn && (
              <button
                type="button"
                data-testid="record-delivery"
                onClick={() => onOpen({ kind: 'delivery', legId: leg.legId })}
                className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-0"
              >
                <Plus className="h-4 w-4" aria-hidden="true" /> {t('recordDelivery')}
              </button>
            )}
            {losable && (
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
      </div>

      {/* Desktop: a table. Phone: a card per product. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="py-2 text-start font-medium">{t('product')}</th>
              <th className="py-2 text-end font-medium">{t('ordered')}</th>
              <th className="py-2 text-end font-medium">{t('delivered')}</th>
              <th className="py-2 text-end font-medium">{t('receivedCol')}</th>
              <th className="py-2 text-end font-medium">{t('waiting')}</th>
              <th className="py-2 text-end font-medium">{t('lost')}</th>
              <th className="py-2 text-end font-medium">{t('onTheWay')}</th>
              <th className="w-28 py-2 ps-4 text-start font-medium">{t('progress')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {leg.lines.map((line) => (
              <tr
                key={line.purchaseOrderItemId}
                data-testid="shipment-line"
                data-product={productNames[line.purchaseOrderItemId]}
              >
                <td className="max-w-56 truncate py-2 font-medium text-foreground">
                  {productNames[line.purchaseOrderItemId]}
                </td>
                <Cell id="line-ordered" value={ordered.get(line.purchaseOrderItemId) ?? 0} />
                <Cell id="line-delivered" value={line.delivered} />
                <Cell id="line-received" value={line.received} />
                <Cell id="line-waiting" value={line.waiting} />
                <Cell id="line-lost" value={line.lost} />
                <Cell id="line-on-the-way" value={line.onTheWay} />
                <td className="py-2 ps-4">
                  <Progress value={legLineProgress(line)} label={t('progressLabel')} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
              <Stat id="line-delivered" label={t('delivered')} value={line.delivered} />
              <Stat id="line-on-the-way" label={t('onTheWay')} value={line.onTheWay} />
              {leg.isLast && <Stat id="line-received" label={t('receivedCol')} value={line.received} />}
              {leg.isLast && <Stat id="line-waiting" label={t('waiting')} value={line.waiting} />}
              <Stat id="line-lost" label={t('lost')} value={line.lost} />
            </dl>
            <Progress className="mt-2" value={legLineProgress(line)} label={t('progressLabel')} />
          </li>
        ))}
      </ul>

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
                    <p className="text-xs text-muted-foreground">
                      {d.lines
                        .map((l) =>
                          leg.isLast
                            ? t('deliveryLineLast', { product: productNames[l.purchaseOrderItemId] ?? '—', qty: l.qty, received: l.received })
                            : t('deliveryLine', { product: productNames[l.purchaseOrderItemId] ?? '—', qty: l.qty }),
                        )
                        .join(' · ')}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {waiting && canReceive && (
                      <button
                        type="button"
                        data-testid="receive-delivery"
                        onClick={() => onOpen({ kind: 'receive', legId: leg.legId, deliveryId: d.id })}
                        className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-0"
                      >
                        <PackageCheck className="h-4 w-4" aria-hidden="true" /> {t('receiveIntoStock')}
                      </button>
                    )}
                    {!frozen && (
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
                      {t('lossLine', { product: productNames[loss.purchaseOrderItemId] ?? '—', qty: num(loss.qty) })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(loss.createdAt)} · {t('lossCost')} <Money value={cost} /> · {t('refundedSoFar')}{' '}
                      <Money value={refunded} /> · {t('unrecovered')}{' '}
                      <span data-testid="loss-unrecovered"><Money value={unrecovered} /></span>
                    </p>
                    {loss.reason && <p className="text-xs text-muted-foreground">{loss.reason}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {unrecovered > 0 && (
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
                    {!frozen && !hasRefunds && (
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
  );
}

function Cell({ id, value }: { id: string; value: number | null }) {
  return (
    <td data-testid={id} className="py-2 text-end tabular-nums text-foreground">
      {value === null ? '—' : value.toLocaleString()}
    </td>
  );
}

function Stat({ id, label, value }: { id: string; label: string; value: number | null }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-testid={id} className="font-medium tabular-nums text-foreground">
        {value === null ? '—' : value.toLocaleString()}
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
