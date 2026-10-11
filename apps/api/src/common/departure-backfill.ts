import { businessDay } from './dates';
import type { Qty } from './shipment-position';

/**
 * The L8 backfill (BUSINESS_LOGIC §1, 2026-10-12), as a pure function.
 *
 * Before L8 a leg had one departure date and no lines: "everything that
 * entered it left on that day". The migration
 * `20261012120000_shipment_departures` turns each such leg into one departure
 * row on that day (its Cairo calendar day), carrying everything that had
 * entered the leg — what was ordered, for the cycle's first leg; what the leg
 * before it delivered, for a later leg. That SQL is the one that runs; this is
 * the same rule written once more so it can be tested without a database, and
 * so the fixtures and the demo seed build old-shaped legs exactly as the
 * migration would have left them.
 *
 * - A leg with no departure date gets nothing.
 * - A leg that already has a departure row is left alone, so running it twice
 *   adds nothing.
 * - Lines of zero are left out (the table refuses them). A later leg whose
 *   previous leg delivered nothing gets a departure with no lines: the date
 *   still says it left, so its status and the cycle's do not move.
 */

export interface DepartureBackfillInput {
  legs: { id: string; sequence: number; departedOn: Date | string | null }[];
  lines: { id: string; orderedQty: Qty }[];
  deliveries: {
    legId: string;
    lines: { purchaseOrderItemId: string; qty: Qty }[];
  }[];
  /** Departure rows already there, by leg. */
  departures: { legId: string }[];
}

export interface PlannedDeparture {
  legId: string;
  departedOn: string;
  lines: { purchaseOrderItemId: string; qty: string }[];
}

const milli = (q: Qty) => Math.round(Number(q.toString()) * 1000);
const qty = (m: number) => (m / 1000).toFixed(3);

export function planDepartureBackfill(
  input: DepartureBackfillInput,
): PlannedDeparture[] {
  const legs = [...input.legs].sort((a, b) => a.sequence - b.sequence);
  const planned: PlannedDeparture[] = [];
  legs.forEach((leg, i) => {
    if (!leg.departedOn) return;
    if (input.departures.some((d) => d.legId === leg.id)) return;
    let lines: { purchaseOrderItemId: string; qty: string }[];
    if (i === 0) {
      lines = input.lines
        .filter((l) => milli(l.orderedQty) > 0)
        .map((l) => ({
          purchaseOrderItemId: l.id,
          qty: qty(milli(l.orderedQty)),
        }));
    } else {
      const previous = legs[i - 1].id;
      const byLine = new Map<string, number>();
      for (const d of input.deliveries.filter((x) => x.legId === previous)) {
        for (const l of d.lines) {
          byLine.set(
            l.purchaseOrderItemId,
            (byLine.get(l.purchaseOrderItemId) ?? 0) + milli(l.qty),
          );
        }
      }
      lines = [...byLine]
        .filter(([, m]) => m > 0)
        .map(([purchaseOrderItemId, m]) => ({
          purchaseOrderItemId,
          qty: qty(m),
        }));
    }
    planned.push({
      legId: leg.id,
      departedOn: businessDay(leg.departedOn),
      lines,
    });
  });
  return planned;
}
