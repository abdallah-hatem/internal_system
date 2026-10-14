/**
 * Where every ordered unit of a cycle is (BUSINESS_LOGIC §1, §3, §8 — 2026-10-10,
 * and L8, 2026-10-12: goods leave in parts too).
 *
 * Goods leave a leg's origin in departures and arrive at its end in
 * deliveries, each in pieces, weeks apart. For each order line and each leg
 * this works out what entered the leg, what has left its origin, what is still
 * waiting there, what it has delivered, what was marked lost on it and what is
 * still on the way — and on the last leg, what has been received into stock
 * and what was delivered but is still waiting to be received.
 *
 * This is the ONE place that arithmetic lives (CLAUDE.md rule 11). Every
 * screen, guard, check and tool reads it; none re-derives it. It is pure: the
 * caller loads the rows, this reads them. No database, no clock.
 *
 * The rules it encodes:
 * - Leg 1's entered is what was ordered. A later leg's entered is what the leg
 *   before it delivered — not what was ordered (§1).
 * - Departed is what the leg's departures carried. Waiting at origin
 *   (`atOrigin`) = entered − departed: goods that have not left (L8).
 * - On the way = departed − delivered − lost, never below zero. A delivery or a
 *   loss can only come from what has left (L8).
 * - A loss is taken from what is on the way first; on the last leg, then from
 *   what was delivered but not received ("waiting"). A loss beyond both — only
 *   possible in data recorded before L8, when a loss did not need the leg to
 *   have left — is taken from what waits at origin.
 * - Received less than a delivery said is waiting, not on the way (§3).
 * - A line is accounted when received + every loss on every leg = ordered (§8).
 *   A cycle is accounted when every line is; a cycle with nothing ordered is
 *   accounted (amendment 5).
 * - A leg reads PENDING, PARTLY_DEPARTED, IN_TRANSIT, PARTLY_ARRIVED or
 *   ARRIVED from what was recorded, never from a field someone set (§1). A leg
 *   that has had a delivery and still has goods waiting at origin reads
 *   PARTLY_ARRIVED, and says the rest with `atOrigin` (the screens show both).
 * - Departures are matched to what came off the way — delivered or lost — in
 *   the order they left (first in, first out). A departure nothing has yet been
 *   matched to can be undone (`inUse` false).
 *
 * Quantities are Decimal(18,3) in the database. They are summed here in whole
 * thousandths so 0.1 + 0.2 never turns a full delivery into "0.0000001 on the
 * way".
 */

export const LEG_STATUSES = [
  'PENDING',
  'PARTLY_DEPARTED',
  'IN_TRANSIT',
  'PARTLY_ARRIVED',
  'ARRIVED',
] as const;
export type LegStatus = (typeof LEG_STATUSES)[number];

/** Anything a quantity arrives as: a number, a string, or a Prisma Decimal. */
export type Qty = number | string | { toString(): string };

export interface PositionLineInput {
  /** The purchase order item. */
  id: string;
  orderedQty: Qty;
  productId?: string;
  productName?: string;
  /** The Arabic name, when there is one (§3, 2026-10-14). */
  productNameAr?: string | null;
}

export interface PositionLegInput {
  id: string;
  sequence: number;
}

export interface PositionDepartureInput {
  id: string;
  legId: string;
  departedOn: Date | string;
  lines: { id?: string; purchaseOrderItemId: string; qty: Qty }[];
}

export interface PositionDeliveryInput {
  id: string;
  legId: string;
  arrivedOn: Date | string;
  lines: { id: string; purchaseOrderItemId: string; qty: Qty }[];
}

export interface PositionLossInput {
  legId: string;
  purchaseOrderItemId: string;
  qty: Qty;
}

export interface PositionBatchInput {
  sourcePoItemId: string | null;
  sourceDeliveryLineId?: string | null;
  receivedQty: Qty;
}

export interface ShipmentPositionInput {
  lines: PositionLineInput[];
  legs: PositionLegInput[];
  departures: PositionDepartureInput[];
  deliveries: PositionDeliveryInput[];
  losses: PositionLossInput[];
  batches: PositionBatchInput[];
}

export interface LegLinePosition {
  purchaseOrderItemId: string;
  entered: number;
  /** Left the leg's origin, on any of its departures. */
  departed: number;
  /** Entered and not yet left: waiting at the leg's origin. */
  atOrigin: number;
  delivered: number;
  lost: number;
  onTheWay: number;
  /** Last leg only; null on the others. */
  received: number | null;
  /** Last leg only: delivered but not yet received or lost. */
  waiting: number | null;
}

export interface DeparturePosition {
  id: string;
  departedOn: string;
  lines: {
    purchaseOrderItemId: string;
    qty: number;
    /** How much of this line has since been delivered or lost (first in, first out). */
    accountedFor: number;
  }[];
  /** Something it carried has been delivered or marked lost: it cannot be undone. */
  inUse: boolean;
}

export interface DeliveryPosition {
  id: string;
  arrivedOn: string;
  lines: {
    id: string;
    purchaseOrderItemId: string;
    qty: number;
    /** Received from this delivery line (last leg only; 0 elsewhere). */
    received: number;
  }[];
}

export interface LegPosition {
  legId: string;
  sequence: number;
  isLast: boolean;
  status: LegStatus;
  /** The day of the leg's first departure; null before anything left. */
  departedOn: string | null;
  /** The day of the delivery that completed the leg; null while anything is on the way. */
  arrivedOn: string | null;
  entered: number;
  departed: number;
  atOrigin: number;
  delivered: number;
  lost: number;
  onTheWay: number;
  received: number | null;
  waiting: number | null;
  lines: LegLinePosition[];
  departures: DeparturePosition[];
  deliveries: DeliveryPosition[];
}

export interface LinePosition {
  purchaseOrderItemId: string;
  productId?: string;
  productName?: string;
  productNameAr?: string | null;
  ordered: number;
  received: number;
  /** Every loss on every leg. */
  lost: number;
  /** Waiting at the origin of any leg: entered it, has not left. */
  atOrigin: number;
  /** On the way on any leg. */
  onTheWay: number;
  /** Delivered by the last leg, not yet received or lost. */
  waiting: number;
  accounted: boolean;
}

export interface ShipmentPosition {
  accounted: boolean;
  totals: {
    ordered: number;
    received: number;
    lost: number;
    atOrigin: number;
    onTheWay: number;
    waiting: number;
  };
  lines: LinePosition[];
  legs: LegPosition[];
  /**
   * Per order line, what a leg added after the last recorded one would find
   * waiting at its origin: what was ordered when no leg is recorded, otherwise
   * what the last leg delivered. The Shipments page's create form starts its
   * departure from this.
   */
  nextLeg: { purchaseOrderItemId: string; waiting: number }[];
}

const SCALE = 1000;
const milli = (q: Qty | null | undefined): number =>
  q === null || q === undefined ? 0 : Math.round(Number(q.toString()) * SCALE);
const out = (m: number): number => m / SCALE;

/** A calendar day as YYYY-MM-DD. Date columns come back at UTC midnight. */
export function positionDay(value: Date | string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  return new Date(value).toISOString().slice(0, 10);
}
const day = positionDay;

function sumBy<T>(
  rows: T[],
  key: (r: T) => string | null | undefined,
  qty: (r: T) => Qty,
) {
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    map.set(k, (map.get(k) ?? 0) + milli(qty(r)));
  }
  return map;
}

/** Departures in the order they left; same day keeps the order given. */
function inOrderLeft(departures: PositionDepartureInput[]) {
  return departures
    .map((d, i) => ({ d, i }))
    .sort(
      (a, b) =>
        day(a.d.departedOn).localeCompare(day(b.d.departedOn)) || a.i - b.i,
    )
    .map((x) => x.d);
}

export function shipmentPosition(
  input: ShipmentPositionInput,
): ShipmentPosition {
  const legs = [...input.legs].sort((a, b) => a.sequence - b.sequence);
  const lastLegId = legs.length ? legs[legs.length - 1].id : null;

  const receivedByLine = sumBy(
    input.batches,
    (b) => b.sourcePoItemId,
    (b) => b.receivedQty,
  );
  const receivedByDeliveryLine = sumBy(
    input.batches,
    (b) => b.sourceDeliveryLineId,
    (b) => b.receivedQty,
  );

  // Per line, what the previous leg delivered — leg 1 starts from the order.
  const enteredByLine = new Map<string, number>();
  for (const l of input.lines) enteredByLine.set(l.id, milli(l.orderedQty));

  const lostByLine = new Map<string, number>();
  const atOriginByLine = new Map<string, number>();
  const onTheWayByLine = new Map<string, number>();
  const waitingByLine = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) =>
    m.set(k, (m.get(k) ?? 0) + v);

  const legPositions: LegPosition[] = legs.map((leg) => {
    const isLast = leg.id === lastLegId;
    const departures = inOrderLeft(
      input.departures.filter((d) => d.legId === leg.id),
    );
    const deliveries = input.deliveries
      .filter((d) => d.legId === leg.id)
      .sort((a, b) => day(a.arrivedOn).localeCompare(day(b.arrivedOn)));
    const departed = sumBy(
      departures.flatMap((d) => d.lines),
      (l) => l.purchaseOrderItemId,
      (l) => l.qty,
    );
    const delivered = sumBy(
      deliveries.flatMap((d) => d.lines),
      (l) => l.purchaseOrderItemId,
      (l) => l.qty,
    );
    const lost = sumBy(
      input.losses.filter((x) => x.legId === leg.id),
      (x) => x.purchaseOrderItemId,
      (x) => x.qty,
    );

    // What came off the way on this leg, per line — for matching departures.
    const offTheWay = new Map<string, number>();

    const lines: LegLinePosition[] = input.lines.map((line) => {
      const entered = enteredByLine.get(line.id) ?? 0;
      const p = departed.get(line.id) ?? 0;
      const v = delivered.get(line.id) ?? 0;
      const lo = lost.get(line.id) ?? 0;

      // A loss comes off the way first, then (last leg) off what was
      // delivered and not received, then — old data only — off the origin.
      const wayBeforeLoss = Math.max(0, p - v);
      const lossOnWay = Math.min(lo, wayBeforeLoss);
      let rest = lo - lossOnWay;
      let received: number | null = null;
      let waiting: number | null = null;
      if (isLast) {
        const r = receivedByLine.get(line.id) ?? 0;
        const waitingBeforeLoss = Math.max(0, v - r);
        const lossWaiting = Math.min(rest, waitingBeforeLoss);
        rest -= lossWaiting;
        received = out(r);
        waiting = out(waitingBeforeLoss - lossWaiting);
        waitingByLine.set(line.id, waitingBeforeLoss - lossWaiting);
      }
      const onTheWay = wayBeforeLoss - lossOnWay;
      // What was delivered had left, whatever the departures say: a leg
      // backfilled with deliveries but no departure date (B1) has no
      // departure rows, and its goods are not back at the origin.
      const atOrigin = Math.max(0, entered - Math.max(p, v) - rest);
      offTheWay.set(line.id, Math.min(p, v + lossOnWay));

      add(lostByLine, line.id, lo);
      add(atOriginByLine, line.id, atOrigin);
      add(onTheWayByLine, line.id, onTheWay);
      return {
        purchaseOrderItemId: line.id,
        entered: out(entered),
        departed: out(p),
        atOrigin: out(atOrigin),
        delivered: out(v),
        lost: out(lo),
        onTheWay: out(onTheWay),
        received,
        waiting,
      };
    });

    // The next leg carries what this one delivered (§1).
    for (const line of input.lines) {
      enteredByLine.set(line.id, delivered.get(line.id) ?? 0);
    }

    // First in, first out: what came off the way is matched to the earliest
    // departures, so the latest ones are the ones still free to undo.
    const left = new Map(offTheWay);
    const departurePositions: DeparturePosition[] = departures.map((dep) => {
      const depLines = dep.lines.map((l) => {
        const qty = milli(l.qty);
        const take = Math.min(qty, left.get(l.purchaseOrderItemId) ?? 0);
        left.set(
          l.purchaseOrderItemId,
          (left.get(l.purchaseOrderItemId) ?? 0) - take,
        );
        return {
          purchaseOrderItemId: l.purchaseOrderItemId,
          qty: out(qty),
          accountedFor: out(take),
        };
      });
      return {
        id: dep.id,
        departedOn: day(dep.departedOn),
        lines: depLines,
        inUse: depLines.some((l) => l.accountedFor > 0),
      };
    });

    const total = (pick: (l: LegLinePosition) => number | null) =>
      out(lines.reduce((s, l) => s + milli(pick(l) ?? 0), 0));
    const enteredTotal = total((l) => l.entered);
    const atOriginTotal = total((l) => l.atOrigin);
    const onTheWayTotal = total((l) => l.onTheWay);
    const hasDeparture = departures.length > 0;
    const hasDelivery = deliveries.length > 0;

    let status: LegStatus;
    if (
      enteredTotal > 0 &&
      atOriginTotal === 0 &&
      onTheWayTotal === 0 &&
      (hasDelivery || total((l) => l.lost) > 0)
    ) {
      status = 'ARRIVED';
    } else if (hasDelivery) {
      status = 'PARTLY_ARRIVED';
    } else if (hasDeparture && atOriginTotal > 0) {
      status = 'PARTLY_DEPARTED';
    } else if (hasDeparture) {
      status = 'IN_TRANSIT';
    } else {
      status = 'PENDING';
    }

    return {
      legId: leg.id,
      sequence: leg.sequence,
      isLast,
      status,
      departedOn: departurePositions[0]?.departedOn ?? null,
      arrivedOn:
        status === 'ARRIVED' && hasDelivery
          ? day(deliveries[deliveries.length - 1].arrivedOn)
          : null,
      entered: enteredTotal,
      departed: total((l) => l.departed),
      atOrigin: atOriginTotal,
      delivered: total((l) => l.delivered),
      lost: total((l) => l.lost),
      onTheWay: onTheWayTotal,
      received: isLast ? total((l) => l.received) : null,
      waiting: isLast ? total((l) => l.waiting) : null,
      lines,
      departures: departurePositions,
      deliveries: deliveries.map((dl) => ({
        id: dl.id,
        arrivedOn: day(dl.arrivedOn),
        lines: dl.lines.map((l) => ({
          id: l.id,
          purchaseOrderItemId: l.purchaseOrderItemId,
          qty: out(milli(l.qty)),
          received: isLast ? out(receivedByDeliveryLine.get(l.id) ?? 0) : 0,
        })),
      })),
    };
  });

  const linePositions: LinePosition[] = input.lines.map((line) => {
    const ordered = milli(line.orderedQty);
    const received = receivedByLine.get(line.id) ?? 0;
    const lost = lostByLine.get(line.id) ?? 0;
    return {
      purchaseOrderItemId: line.id,
      ...(line.productId !== undefined ? { productId: line.productId } : {}),
      ...(line.productName !== undefined
        ? { productName: line.productName }
        : {}),
      ...(line.productNameAr !== undefined
        ? { productNameAr: line.productNameAr }
        : {}),
      ordered: out(ordered),
      received: out(received),
      lost: out(lost),
      atOrigin: out(atOriginByLine.get(line.id) ?? 0),
      onTheWay: out(onTheWayByLine.get(line.id) ?? 0),
      waiting: out(waitingByLine.get(line.id) ?? 0),
      // Exactly equal: more received than ordered is not "accounted", it is
      // a record the business could not have produced.
      accounted: received + lost === ordered,
    };
  });

  const sum = (pick: (l: LinePosition) => number) =>
    out(linePositions.reduce((s, l) => s + milli(pick(l)), 0));

  return {
    accounted: linePositions.every((l) => l.accounted),
    totals: {
      ordered: sum((l) => l.ordered),
      received: sum((l) => l.received),
      lost: sum((l) => l.lost),
      atOrigin: sum((l) => l.atOrigin),
      onTheWay: sum((l) => l.onTheWay),
      waiting: sum((l) => l.waiting),
    },
    lines: linePositions,
    legs: legPositions,
    nextLeg: input.lines.map((l) => ({
      purchaseOrderItemId: l.id,
      waiting: out(enteredByLine.get(l.id) ?? 0),
    })),
  };
}
