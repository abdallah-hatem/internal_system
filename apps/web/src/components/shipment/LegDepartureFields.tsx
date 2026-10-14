'use client';

import { useCallback, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { localName } from '@/lib/localized-name';
import { Link } from '@/i18n/navigation';
import { useShipment } from './ShipmentPanel';
import { DepartedOnField, DepartureQtyFields, departureRowIds } from './RecordDepartureDialog';
import { atOriginByLine, departureLinesFrom, nextLegWaitingByLine } from './shipment-model';

/**
 * A leg form's departure (L8, BUSINESS_LOGIC §1, 2026-10-12): the Shipments
 * page's create and edit forms record a leg's FIRST departure the way Record
 * departure does — a day, and per product how many left, each starting at
 * everything waiting at the leg's origin. Later departures, and undoing one,
 * are on the cycle page.
 *
 * What waits is the server's figure: for a leg being created, `nextLeg` (what a
 * leg after the last recorded one would find); for an existing leg, its
 * `atOrigin`. The form holds what was typed; a refetch never replaces it.
 */
export function useLegDeparture(cycleId: string | undefined, legId?: string) {
  const { data: shipment } = useShipment(cycleId || undefined);
  const leg = legId ? shipment?.legs?.find((l) => l.legId === legId) : undefined;
  const waiting = useMemo(
    () => (legId ? (leg ? atOriginByLine(leg) : {}) : nextLegWaitingByLine(shipment)),
    [legId, leg, shipment],
  );
  const locale = useLocale();
  const productNames = useMemo(
    () => Object.fromEntries((shipment?.lines ?? []).map((l) => [l.purchaseOrderItemId, localName({ name: l.productName, nameAr: l.productNameAr }, locale) || '—'])),
    [shipment, locale],
  );
  const [departedOn, setDepartedOn] = useState('');
  const [typed, setTyped] = useState<Record<string, string>>({});
  /** Every way into and out of the form clears it (§13). */
  const reset = useCallback(() => {
    setDepartedOn('');
    setTyped({});
  }, []);
  /**
   * What to send: nothing when no day was picked; the lines when one was. A
   * leg that has already left sends no lines (its date may only move).
   */
  const read = () => {
    if (!departedOn) return { departureLines: undefined, invalid: null as string | null };
    if ((leg?.departures ?? []).length > 0) return { departureLines: undefined, invalid: null };
    const { lines, invalid } = departureLinesFrom(typed, waiting, departureRowIds(waiting, typed));
    return { departureLines: lines.length ? lines : undefined, invalid };
  };
  return {
    shipmentLoaded: !!shipment,
    leg,
    waiting,
    productNames,
    departedOn,
    setDepartedOn,
    typed,
    setTyped,
    reset,
    read,
  };
}

export function LegDepartureFields({
  state,
  cycleId,
  label,
  defaultDepartedOn,
  linkToCycle = true,
}: {
  state: ReturnType<typeof useLegDeparture>;
  cycleId?: string;
  label: string;
  /** The leg's first departure, on the edit form. */
  defaultDepartedOn?: string | null;
  /** False on the cycle's own page, where a link to it goes nowhere new. */
  linkToCycle?: boolean;
}) {
  const t = useTranslations('shipments');
  const left = (state.leg?.departures ?? []).length > 0;
  const day = state.departedOn || (defaultDepartedOn ? defaultDepartedOn.slice(0, 10) : '');
  return (
    <div data-testid="leg-departure-fields" className="space-y-3">
      <DepartedOnField
        label={label}
        value={day}
        onChange={(v) => state.setDepartedOn(v)}
        hint={left ? undefined : t('firstDepartureHint')}
      />
      {left ? (
        <p className="text-xs text-muted-foreground">
          {t('departuresOnCyclePage')}{' '}
          {cycleId && linkToCycle && (
            <Link href={`/cycles/${cycleId}/details`} className="cursor-pointer font-medium text-primary hover:underline">
              {t('openShipmentPanel')}
            </Link>
          )}
        </p>
      ) : !cycleId ? (
        <p className="text-xs text-muted-foreground">{t('departurePickCycle')}</p>
      ) : (
        state.departedOn &&
        state.shipmentLoaded && (
          <DepartureQtyFields
            waiting={state.waiting}
            productNames={state.productNames}
            typed={state.typed}
            onType={(id, value) => state.setTyped((prev) => ({ ...prev, [id]: value }))}
          />
        )
      )}
    </div>
  );
}
