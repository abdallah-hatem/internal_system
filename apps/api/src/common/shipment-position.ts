/**
 * Where every ordered unit of a cycle is (BUSINESS_LOGIC §1, §3, §8 — 2026-10-10).
 *
 * Goods leave in one shipment and arrive in deliveries, weeks apart. For each
 * order line and each leg this works out what entered the leg, what it has
 * delivered, what was marked lost on it and what is still on the way — and on
 * the last leg, what has been received into stock and what was delivered but
 * is still waiting to be received.
 *
 * This is the ONE place that arithmetic lives (CLAUDE.md rule 11). Every
 * screen, guard, check and tool reads it; none re-derives it. It is pure: the
 * caller loads the rows, this reads them. No database, no clock.
 *
 * The rules it encodes:
 * - Leg 1's entered is what was ordered. A later leg's entered is what the leg
 *   before it delivered — not what was ordered (§1).
 * - On the way = entered − delivered − lost, never below zero.
 * - On the last leg, a loss is taken from what is on the way first and then
 *   from what was delivered but not received ("waiting"). Received less than a
 *   delivery said is waiting, not on the way (§3, spec amendment 1).
 * - A line is accounted when received + every loss on every leg = ordered (§8).
 *   A cycle is accounted when every line is; a cycle with nothing ordered is
 *   accounted (amendment 5).
 * - A leg reads PENDING, IN_TRANSIT, PARTLY_ARRIVED or ARRIVED from what was
 *   recorded, never from a field someone set (§1).
 *
 * Quantities are Decimal(18,3) in the database. They are summed here in whole
 * thousandths so 0.1 + 0.2 never turns a full delivery into "0.0000001 on the
 * way".
 */

export const LEG_STATUSES = [
  'PENDING',
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
}

export interface PositionLegInput {
  id: string;
  sequence: number;
  departedOn?: Date | string | null;
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
  deliveries: PositionDeliveryInput[];
  losses: PositionLossInput[];
  batches: PositionBatchInput[];
}

export interface LegLinePosition {
  purchaseOrderItemId: string;
  entered: number;
  delivered: number;
  lost: number;
  onTheWay: number;
  /** Last leg only; null on the others. */
  received: number | null;
  /** Last leg only: delivered but not yet received or lost. */
  waiting: number | null;
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
  /** The day of the delivery that completed the leg; null while anything is on the way. */
  arrivedOn: string | null;
  entered: number;
  delivered: number;
  lost: number;
  onTheWay: number;
  received: number | null;
  waiting: number | null;
  lines: LegLinePosition[];
  deliveries: DeliveryPosition[];
}

export interface LinePosition {
  purchaseOrderItemId: string;
  productId?: string;
  productName?: string;
  ordered: number;
  received: number;
  /** Every loss on every leg. */
  lost: number;
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
    onTheWay: number;
    waiting: number;
  };
  lines: LinePosition[];
  legs: LegPosition[];
}

const SCALE = 1000;
const milli = (q: Qty | null | undefined): number =>
  q === null || q === undefined ? 0 : Math.round(Number(q.toString()) * SCALE);
const out = (m: number): number => m / SCALE;

/** A calendar day as YYYY-MM-DD. Date columns come back at UTC midnight. */
function day(value: Date | string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  return new Date(value).toISOString().slice(0, 10);
}

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
  const onTheWayByLine = new Map<string, number>();
  const waitingByLine = new Map<string, number>();

  const legPositions: LegPosition[] = legs.map((leg) => {
    const isLast = leg.id === lastLegId;
    const deliveries = input.deliveries
      .filter((d) => d.legId === leg.id)
      .sort((a, b) => day(a.arrivedOn).localeCompare(day(b.arrivedOn)));
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

    const lines: LegLinePosition[] = input.lines.map((line) => {
      const entered = enteredByLine.get(line.id) ?? 0;
      const d = delivered.get(line.id) ?? 0;
      const lo = lost.get(line.id) ?? 0;
      const onTheWay = Math.max(0, entered - d - lo);
      let received: number | null = null;
      let waiting: number | null = null;
      if (isLast) {
        const r = receivedByLine.get(line.id) ?? 0;
        received = out(r);
        // What is neither received, lost nor on the way was delivered and is
        // waiting on a shelf to be counted in.
        waiting = out(Math.max(0, entered - r - lo - onTheWay));
        waitingByLine.set(line.id, milli(waiting));
      }
      lostByLine.set(line.id, (lostByLine.get(line.id) ?? 0) + lo);
      onTheWayByLine.set(
        line.id,
        (onTheWayByLine.get(line.id) ?? 0) + onTheWay,
      );
      return {
        purchaseOrderItemId: line.id,
        entered: out(entered),
        delivered: out(d),
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

    const total = (pick: (l: LegLinePosition) => number | null) =>
      out(lines.reduce((s, l) => s + milli(pick(l) ?? 0), 0));
    const enteredTotal = total((l) => l.entered);
    const onTheWayTotal = total((l) => l.onTheWay);
    const hasDelivery = deliveries.length > 0;

    let status: LegStatus;
    if (
      enteredTotal > 0 &&
      onTheWayTotal === 0 &&
      (hasDelivery || total((l) => l.lost) > 0)
    ) {
      status = 'ARRIVED';
    } else if (hasDelivery) {
      status = 'PARTLY_ARRIVED';
    } else if (leg.departedOn) {
      status = 'IN_TRANSIT';
    } else {
      status = 'PENDING';
    }

    return {
      legId: leg.id,
      sequence: leg.sequence,
      isLast,
      status,
      arrivedOn:
        status === 'ARRIVED' && hasDelivery
          ? day(deliveries[deliveries.length - 1].arrivedOn)
          : null,
      entered: enteredTotal,
      delivered: total((l) => l.delivered),
      lost: total((l) => l.lost),
      onTheWay: onTheWayTotal,
      received: isLast ? total((l) => l.received) : null,
      waiting: isLast ? total((l) => l.waiting) : null,
      lines,
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
      ordered: out(ordered),
      received: out(received),
      lost: out(lost),
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
      onTheWay: sum((l) => l.onTheWay),
      waiting: sum((l) => l.waiting),
    },
    lines: linePositions,
    legs: legPositions,
  };
}
