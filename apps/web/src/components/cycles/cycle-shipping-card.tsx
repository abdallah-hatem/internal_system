'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Send, Truck } from 'lucide-react';
import { LegRoute } from '@/components/shipment/LegRoute';
import { RecordDeliveryDialog } from '@/components/shipment/RecordDeliveryDialog';
import { RecordDepartureDialog } from '@/components/shipment/RecordDepartureDialog';
import { FROZEN_STATUSES, num, type Shipment, type ShipmentLeg } from '@/components/shipment/shipment-model';
import { EmptyState } from '@/components/ui/empty-state';
import { LatinText } from '@/components/ui/latin-text';
import { Money } from '@/components/ui/money';
import { useCan } from '@/lib/can';
import { useDateFormat } from '@/lib/dates';
import { useCodeLabel } from '@/lib/labels';

/** The cycle as `GET /cycles/:id` returns it — only what the card reads. */
export interface ShippingCardCycle {
  status: string;
  shippingLegs?: {
    id: string;
    sequence?: number;
    origin: string;
    destination: string;
    provider?: string | null;
    departedOn?: string | null;
    status?: string;
    amountEgp?: number | string | null;
  }[];
}

/** Which dialog is open. One value, so every way of closing clears all of it (CLAUDE.md §13). */
type Open = { kind: 'departure' | 'delivery'; legId: string } | null;

/**
 * The details page's Shipping card: each leg, its status and deliveries, and
 * the two things that move it on — Record departure and Record delivery (I3,
 * owner 2026-10-11). Until then both lived elsewhere: the departure in the
 * Shipments page's edit form or the wizard, and the delivery in the Shipment
 * panel further down.
 *
 * Each button is the existing dialog, not a copy: the departure is
 * `RecordDepartureDialog` (the field the Shipments page renders too), the
 * delivery is `RecordDeliveryDialog`. Each follows its endpoint's roles
 * (`lib/permissions.ts`) and neither shows on a cycle being settled, closed or
 * cancelled — the server refuses both there. After a save the shipment, the
 * cycle and its status are refetched, so the leg, the location cards and the
 * Change status button all read the new state.
 */
export function CycleShippingCard({
  cycle,
  shipment,
  emptyAction,
}: {
  cycle: ShippingCardCycle;
  shipment: Shipment | undefined;
  /** What the empty state offers (the details page links to Shipments). */
  emptyAction?: { label: string; href: string };
}) {
  const t = useTranslations('cycles');
  const ts = useTranslations('shipment');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const may = {
    depart: useCan('shippingLeg.edit'),
    deliver: useCan('shipment.recordDelivery'),
  };
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);

  const legs = cycle.shippingLegs ?? [];
  const frozen = FROZEN_STATUSES.includes(shipment?.status ?? cycle.status);
  const positionOf = (legId: string): ShipmentLeg | undefined => shipment?.legs?.find((p) => p.legId === legId);
  const productNames = useMemo(
    () => Object.fromEntries((shipment?.lines ?? []).map((l) => [l.purchaseOrderItemId, l.productName ?? '—'])),
    [shipment],
  );

  const button =
    'inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium touch-manipulation sm:min-h-0';

  return (
    <div data-testid="shipping-card" className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Truck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        {t('shipping')}
      </h2>
      {legs.length === 0 ? (
        <EmptyState
          size="compact"
          icon={Truck}
          title={t('noLegsTitle')}
          description={t('noLegsHint')}
          action={emptyAction}
        />
      ) : (
        <div className="divide-y divide-border">
          {legs.map((l) => {
            const position = positionOf(l.id);
            const deliveries = position?.deliveries ?? [];
            const departed = !!(position?.departedOn ?? l.departedOn);
            const showDepart = may.depart && !frozen && !departed;
            const showDeliver = may.deliver && !frozen && departed && !!position && position.onTheWay > 0;
            return (
              <div key={l.id} data-testid="shipping-card-leg" data-leg-id={l.id} className="space-y-1 py-2">
                <div className="grid grid-cols-2 items-center gap-2 sm:grid-cols-5">
                  <LegRoute className="text-sm" origin={l.origin} destination={l.destination} />
                  <span className="text-xs text-muted-foreground"><LatinText>{l.provider ?? '—'}</LatinText></span>
                  <span className="text-xs text-muted-foreground">
                    {l.departedOn ? t('legDeparted', { date: formatDate(l.departedOn) }) : t('legNotDeparted')}
                  </span>
                  <span data-testid="shipping-card-status" className="text-xs font-medium text-foreground">
                    {codeLabel('legStatus', position?.status ?? l.status ?? 'PENDING')}
                  </span>
                  <span className="text-sm"><Money value={num(l.amountEgp)} /></span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {deliveries.length === 0
                    ? t('legNoDeliveries')
                    : deliveries
                        .map((d) =>
                          t('legDelivery', {
                            date: formatDate(d.arrivedOn),
                            units: d.lines.reduce((sum, line) => sum + num(line.qty), 0),
                          }),
                        )
                        .join(' · ')}
                </p>
                {(showDepart || showDeliver) && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {showDepart && (
                      <button
                        type="button"
                        data-testid="leg-record-departure"
                        onClick={() => setOpen({ kind: 'departure', legId: l.id })}
                        className={`${button} border border-border text-foreground hover:bg-muted`}
                      >
                        <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" /> {ts('recordDeparture')}
                      </button>
                    )}
                    {showDeliver && (
                      <button
                        type="button"
                        data-testid="leg-record-delivery"
                        onClick={() => setOpen({ kind: 'delivery', legId: l.id })}
                        className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" /> {ts('recordDelivery')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Both dialogs portal to <body>. The leg is looked up again on every
          render so the delivery form starts from the latest figures. */}
      {open?.kind === 'departure' && (() => {
        const l = legs.find((x) => x.id === open.legId);
        return l ? (
          <RecordDepartureDialog
            leg={{ legId: l.id, sequence: l.sequence ?? positionOf(l.id)?.sequence ?? legs.indexOf(l) + 1, origin: l.origin, destination: l.destination }}
            onClose={close}
          />
        ) : null;
      })()}
      {open?.kind === 'delivery' && positionOf(open.legId) && (
        <RecordDeliveryDialog leg={positionOf(open.legId)!} productNames={productNames} onClose={close} />
      )}
    </div>
  );
}
