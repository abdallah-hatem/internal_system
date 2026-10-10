import { businessToday } from './dates';
import type { Qty } from './shipment-position';

/**
 * Turns a cycle recorded the old way — one arrival date per leg, one batch per
 * order line — into deliveries (spec 2026-10-10, "Migration", amendment 10).
 *
 * Pure: given what is stored for one cycle, it returns the rows to write. The
 * script `prisma/backfill-shipment-deliveries.ts` loads and writes them. It is
 * a TypeScript function rather than SQL inside the migration so every rule
 * below has a unit test (`shipment-backfill.spec.ts`); the migration itself is
 * additive only.
 *
 * The rules:
 * 1. Every leg with an `arrivedOn` and no delivery yet gets one delivery on
 *    that day, carrying each order line's full ordered quantity — the old model
 *    said "everything arrived on this date". Keyed on the leg: a leg that
 *    already has any delivery is left alone, so running it twice adds nothing.
 *    A dated leg with no departure is backfilled anyway: it is history.
 * 2. The last leg with no `arrivedOn` and no delivery, on a cycle that has
 *    batches, gets a delivery dated the first batch's receipt day in Cairo, and
 *    the leg itself is marked ARRIVED on that day — stock could not have been
 *    received from goods that had not arrived (§14). An earlier leg in the same
 *    state gets the same (a guess, recorded in the B1 build log).
 * 3. Every batch not yet linked is linked to the last-leg delivery line of its
 *    order line, and takes that delivery's date as its `arrivedOn`.
 * 4. A line received short (its batches total less than ordered) gets the
 *    shortfall as a loss on the last leg at cost 0, reason ABSORBED_REASON. The
 *    old costing spread the line's whole cost over what came, so the missing
 *    units are already inside the batch cost; charging them again as a loss
 *    would count them twice (§2). A line with no batch at all is not short, it
 *    is waiting to be received.
 *
 * Not handled, by design: a cycle with batches but no legs (there is no leg to
 * hang a delivery on); its batches stay unlinked and still count as received.
 */

export const ABSORBED_REASON = 'absorbed into the batch cost before 2026-10-10';
export const BACKFILL_NOTE =
  'Recorded from the leg arrival date (2026-10-10 backfill)';
export const BACKFILL_FROM_BATCH_NOTE =
  'Recorded from the first stock receipt (2026-10-10 backfill)';

export interface BackfillCycle {
  legs: {
    id: string;
    sequence: number;
    arrivedOn: Date | null;
  }[];
  items: { id: string; orderedQty: Qty }[];
  batches: {
    id: string;
    sourcePoItemId: string | null;
    sourceDeliveryLineId: string | null;
    receivedQty: Qty;
    createdAt: Date;
  }[];
  deliveries: {
    id: string;
    legId: string;
    arrivedOn: Date | string;
    lines: { id: string; purchaseOrderItemId: string }[];
  }[];
  losses: {
    legId: string;
    purchaseOrderItemId: string;
    reason: string | null;
  }[];
}

export interface BackfillPlan {
  deliveries: {
    id: string;
    legId: string;
    arrivedOn: string;
    note: string;
    lines: { id: string; purchaseOrderItemId: string; qty: string }[];
  }[];
  legUpdates: { legId: string; arrivedOn: string; status: 'ARRIVED' }[];
  batchLinks: {
    batchId: string;
    sourceDeliveryLineId: string;
    arrivedOn: string;
  }[];
  losses: {
    legId: string;
    purchaseOrderItemId: string;
    qty: string;
    unitCostEgp: '0';
    costEgp: '0';
    reason: string;
  }[];
}

const SCALE = 1000;
const milli = (q: Qty) => Math.round(Number(q.toString()) * SCALE);
const qtyString = (m: number) => (m / SCALE).toFixed(3);

/** The calendar day an instant fell on in Cairo. */
const cairoDay = (d: Date) => businessToday(d);
const asDay = (d: Date | string) =>
  typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
    ? d
    : cairoDay(new Date(d));

export function planShipmentBackfill(
  cycle: BackfillCycle,
  newId: () => string,
): BackfillPlan {
  const plan: BackfillPlan = {
    deliveries: [],
    legUpdates: [],
    batchLinks: [],
    losses: [],
  };
  if (cycle.legs.length === 0) return plan;

  const legs = [...cycle.legs].sort((a, b) => a.sequence - b.sequence);
  const lastLeg = legs[legs.length - 1];
  const hasDelivery = new Set(cycle.deliveries.map((d) => d.legId));
  const items = cycle.items.filter((i) => milli(i.orderedQty) > 0);

  const fullDelivery = (legId: string, arrivedOn: string, note: string) => {
    const delivery = {
      id: newId(),
      legId,
      arrivedOn,
      note,
      lines: items.map((i) => ({
        id: newId(),
        purchaseOrderItemId: i.id,
        qty: qtyString(milli(i.orderedQty)),
      })),
    };
    if (delivery.lines.length) plan.deliveries.push(delivery);
  };

  // Rule 1.
  for (const leg of legs) {
    if (leg.arrivedOn && !hasDelivery.has(leg.id)) {
      fullDelivery(leg.id, cairoDay(leg.arrivedOn), BACKFILL_NOTE);
    }
  }

  // Rule 2. An earlier leg left undated is given the same day: goods cannot
  // reach Egypt without first leaving the leg before, and a later leg can only
  // carry what the one before delivered.
  if (
    !lastLeg.arrivedOn &&
    !hasDelivery.has(lastLeg.id) &&
    cycle.batches.length
  ) {
    const first = cycle.batches.reduce((a, b) =>
      b.createdAt < a.createdAt ? b : a,
    );
    const arrivedOn = cairoDay(first.createdAt);
    for (const leg of legs) {
      if (leg.arrivedOn || hasDelivery.has(leg.id)) continue;
      fullDelivery(leg.id, arrivedOn, BACKFILL_FROM_BATCH_NOTE);
      plan.legUpdates.push({ legId: leg.id, arrivedOn, status: 'ARRIVED' });
    }
  }

  // Rule 3: the last leg's delivery line for each order line, existing or new.
  const lastLegLine = new Map<string, { id: string; arrivedOn: string }>();
  const lastLegDeliveries = [
    ...cycle.deliveries
      .filter((d) => d.legId === lastLeg.id)
      .map((d) => ({ arrivedOn: asDay(d.arrivedOn), lines: d.lines })),
    ...plan.deliveries.filter((d) => d.legId === lastLeg.id),
  ].sort((a, b) => a.arrivedOn.localeCompare(b.arrivedOn));
  for (const d of lastLegDeliveries) {
    for (const l of d.lines) {
      if (!lastLegLine.has(l.purchaseOrderItemId)) {
        lastLegLine.set(l.purchaseOrderItemId, {
          id: l.id,
          arrivedOn: d.arrivedOn,
        });
      }
    }
  }
  for (const b of cycle.batches) {
    if (b.sourceDeliveryLineId || !b.sourcePoItemId) continue;
    const line = lastLegLine.get(b.sourcePoItemId);
    if (!line) continue;
    plan.batchLinks.push({
      batchId: b.id,
      sourceDeliveryLineId: line.id,
      arrivedOn: line.arrivedOn,
    });
  }

  // Rule 4.
  const alreadyAbsorbed = new Set(
    cycle.losses
      .filter((l) => l.legId === lastLeg.id && l.reason === ABSORBED_REASON)
      .map((l) => l.purchaseOrderItemId),
  );
  for (const item of items) {
    const batches = cycle.batches.filter((b) => b.sourcePoItemId === item.id);
    if (!batches.length || alreadyAbsorbed.has(item.id)) continue;
    const short =
      milli(item.orderedQty) -
      batches.reduce((s, b) => s + milli(b.receivedQty), 0);
    if (short <= 0) continue;
    plan.losses.push({
      legId: lastLeg.id,
      purchaseOrderItemId: item.id,
      qty: qtyString(short),
      unitCostEgp: '0',
      costEgp: '0',
      reason: ABSORBED_REASON,
    });
  }

  return plan;
}
