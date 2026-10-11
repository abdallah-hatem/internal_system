import { badRequest, notFound } from '../../common/api-error';
import { assertNotFuture, businessDay } from '../../common/dates';
import {
  legsThatMustHaveDeparted,
  type LoadedShipment,
} from '../../common/shipment-load';
import {
  positionDay,
  type ShipmentPosition,
} from '../../common/shipment-position';

/**
 * L8 — goods can leave in parts (BUSINESS_LOGIC §1, owner 2026-10-12).
 *
 * The rules a departure is checked against, read from the loaded shipment and
 * its position — nothing worked out here that `shipmentPosition` already
 * knows (rule 11). Pure: the deliveries service loads the rows under the
 * cycle's lock, calls these, and writes.
 *
 * What can leave on a departure is what waits at the leg's origin (`atOrigin`).
 * And it cannot leave before it could have been there:
 * - on the cycle's first leg, not before the day the goods were ordered;
 * - on a later leg, not before the delivery of the leg before brought them —
 *   on day D, only what that leg had delivered by D, less what already left.
 */

export interface DepartureLineInput {
  purchaseOrderItemId: string;
  qty: number;
}

const milli = (q: number | string | { toString(): string }) =>
  Math.round(Number(q.toString()) * 1000);
const units = (m: number) => m / 1000;

const where = (leg: { origin: string; destination: string }) =>
  `${leg.origin} → ${leg.destination}`;

/** The day of a departure: a real date, in Cairo, not in the future. */
export function departureDay(value: string | undefined | null): string {
  if (!value || Number.isNaN(new Date(value).getTime())) {
    throw badRequest('VALIDATION_FAILED', 'departedOn must be a date.', {
      fields: 'departedOn',
    });
  }
  assertNotFuture(value, 'DEPARTURE');
  return businessDay(value);
}

/**
 * The lines a departure on `day` writes, every check made.
 *
 * `lines` left out means "everything waiting here that could have left by
 * that day" — what a departure date on the old leg form, the wizard, the
 * fixtures and the assistant's `add_shipping_leg` mean. Given, each line is
 * checked as asked and nothing is trimmed: more than waits is refused.
 */
export function departureLines(
  cycle: LoadedShipment,
  position: ShipmentPosition,
  legId: string,
  day: string,
  lines?: DepartureLineInput[],
  /** A departure being moved to `day`: its own goods count as still waiting. */
  moving?: string,
): DepartureLineInput[] {
  const legRow = cycle.shippingLegs.find((l) => l.id === legId);
  const legPos = position.legs.find((l) => l.legId === legId);
  if (!legRow || !legPos) throw notFound('shippingLeg');
  const index = position.legs.indexOf(legPos);
  const own = legPos.departures.find((d) => d.id === moving);
  const ownQty = (poi: string) =>
    (own?.lines ?? [])
      .filter((l) => l.purchaseOrderItemId === poi)
      .reduce((s, l) => s + milli(l.qty), 0);
  /** Waiting at origin, counting a departure being moved as not yet gone. */
  const waitingHere = (poi: string) =>
    milli(legPos.lines.find((l) => l.purchaseOrderItemId === poi)!.atOrigin) +
    ownQty(poi);
  const previous = index > 0 ? position.legs[index - 1] : null;

  const names = new Map<string, string>();
  const orderedOn = new Map<string, string>();
  for (const po of cycle.purchaseOrders) {
    for (const i of po.items) {
      names.set(i.id, i.product.name);
      if (po.orderedOn) orderedOn.set(i.id, positionDay(po.orderedOn));
    }
  }

  /** On day D, at most what had reached this leg's origin by then, less what already left. */
  const couldHaveLeft = (poi: string) => {
    const line = legPos.lines.find((l) => l.purchaseOrderItemId === poi)!;
    if (!previous) {
      const ordered = orderedOn.get(poi);
      return ordered && day < ordered ? 0 : waitingHere(poi);
    }
    const arrivedBy = previous.deliveries
      .filter((d) => d.arrivedOn <= day)
      .flatMap((d) => d.lines)
      .filter((l) => l.purchaseOrderItemId === poi)
      .reduce((s, l) => s + milli(l.qty), 0);
    return Math.max(
      0,
      Math.min(
        waitingHere(poi),
        arrivedBy - (milli(line.departed) - ownQty(poi)),
      ),
    );
  };

  const tooEarly = (poi: string, asked: number) => {
    const name = names.get(poi)!;
    if (!previous) {
      const ordered = orderedOn.get(poi)!;
      return badRequest(
        'DEPARTURE_BEFORE_ORDER',
        `${name} was ordered on ${ordered}, so it cannot have left ${where(legRow)} on ${day}.`,
        { line: name, day, orderedOn: ordered, leg: where(legRow) },
      );
    }
    return badRequest(
      'DEPARTURE_BEFORE_ARRIVAL',
      `Only ${units(couldHaveLeft(poi))} of ${name} had reached ${legRow.origin} and not left by ${day}, so ${asked} cannot have left that day.`,
      {
        line: name,
        day,
        available: units(couldHaveLeft(poi)),
        asked,
        leg: where(legRow),
      },
    );
  };

  if (!lines) {
    const waiting = legPos.lines.filter((l) => milli(l.atOrigin) > 0);
    if (waiting.length === 0) {
      throw badRequest(
        'DEPARTURE_NOTHING_WAITING',
        `Nothing is waiting to leave ${where(legRow)}.`,
        { leg: where(legRow), legId },
      );
    }
    const out = waiting
      .map((l) => ({
        purchaseOrderItemId: l.purchaseOrderItemId,
        qty: units(couldHaveLeft(l.purchaseOrderItemId)),
      }))
      .filter((l) => milli(l.qty) > 0);
    if (out.length === 0) {
      throw tooEarly(waiting[0].purchaseOrderItemId, waiting[0].atOrigin);
    }
    return out;
  }

  for (const line of lines) {
    // A line of another cycle is "no such line" here, never a departure of
    // someone else's order.
    if (!names.has(line.purchaseOrderItemId))
      throw notFound('purchaseOrderItem');
    const atOrigin = units(waitingHere(line.purchaseOrderItemId));
    if (milli(line.qty) > milli(atOrigin)) {
      throw badRequest(
        'DEPARTURE_EXCEEDS_WAITING',
        `Only ${atOrigin} of ${names.get(line.purchaseOrderItemId)} are waiting at ${legRow.origin}, so a departure of ${line.qty} cannot be recorded.`,
        {
          line: names.get(line.purchaseOrderItemId)!,
          waiting: atOrigin,
          asked: Number(line.qty),
          leg: where(legRow),
        },
      );
    }
    if (milli(line.qty) > couldHaveLeft(line.purchaseOrderItemId)) {
      throw tooEarly(line.purchaseOrderItemId, Number(line.qty));
    }
  }
  return lines;
}

/**
 * Why a departure cannot be undone, or null when it can (L8). Mirrors deleting
 * a delivery: refused once anything depends on it.
 * - `used` — something it carried has been delivered or marked lost (the
 *   position matches departures to what came off the way, first in, first out).
 * - `status` — it is the leg's only departure and the cycle's status says the
 *   leg has left (§1, L3): undoing it would leave the cycle somewhere its goods
 *   never got to. The cycle is not moved back by itself.
 */
export function departureUndoBlock(
  cycle: LoadedShipment,
  position: ShipmentPosition,
  departureId: string,
): { why: 'used' | 'status'; english: string } | null {
  const legPos = position.legs.find((l) =>
    l.departures.some((d) => d.id === departureId),
  );
  if (!legPos) return null;
  const departure = legPos.departures.find((d) => d.id === departureId)!;
  if (departure.inUse) {
    return {
      why: 'used',
      english:
        'Goods from this departure have been delivered or marked lost, so it cannot be undone.',
    };
  }
  const legs = position.legs;
  const isFirst = legs[0]?.legId === legPos.legId;
  const isLast = legs[legs.length - 1]?.legId === legPos.legId;
  const need = legsThatMustHaveDeparted(cycle.originType, cycle.status);
  if (
    legPos.departures.length === 1 &&
    ((isFirst && need.includes('first')) || (isLast && need.includes('last')))
  ) {
    return {
      why: 'status',
      english: `Cycle ${cycle.code} is ${cycle.status} because this leg has left, so its only departure cannot be undone. Move the cycle back first.`,
    };
  }
  return null;
}
