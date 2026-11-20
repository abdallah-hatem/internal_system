// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; freight in EGP must not become a float
import { Prisma } from '@prisma/client';
import { loadShipment, type LoadedShipment } from './shipment-load';
import { positionDay, type ShipmentPosition } from './shipment-position';

/**
 * A UAE leg in handovers (BUSINESS_LOGIC §1, §2 — owner 2026-11-20).
 *
 * From the UAE to Egypt the goods go in lots. A lot is handed to the
 * forwarder with its own freight, often without anyone knowing which products
 * are in it and sometimes not even how many; it then arrives in batches over
 * about a month, and only then is each batch counted product by product.
 *
 * How it sits on the existing shipment (rule 11 — one model, not two):
 * - a **handover** is a departure (`handover = true`) carrying the freight,
 *   the piece count when known, the forwarder and who paid;
 * - an **arrival** is a delivery naming its handover (`departureId`); when it
 *   is recorded the handover's departure lines grow by what arrived, so the
 *   goods left and arrived together and every count that reads departures and
 *   deliveries (goods cards, in UAE / on the way / in Egypt, the timeline, the
 *   status walk L3) keeps working unchanged;
 * - **All arrived** closes it; pieces counted at the handover that never came
 *   are losses naming it, at full landed unit cost (§2), their products said
 *   by the partner.
 *
 * This file is the arithmetic, and pure: what a leg's handovers add up to and
 * what its freight per piece is. The service loads, locks and writes.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);
const ZERO = new Prisma.Decimal(0);
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
const milli = (q: Prisma.Decimal.Value | null | undefined) =>
  Math.round(Number(D(q).toString()) * 1000);
const units = (m: number) => m / 1000;

type Leg = LoadedShipment['shippingLegs'][number];

export interface HandoverSummary {
  id: string;
  /** 1, 2, 3 … in the order they were handed over. */
  number: number;
  handedOverOn: string;
  pieces: number | null;
  freightAmount: string;
  freightCurrency: string;
  freightRateToEgp: string;
  freightAmountEgp: string;
  providerId: string | null;
  paidByUserId: string | null;
  /** Pieces that arrived from it so far. */
  arrived: number;
  /** Pieces of its count that never came, marked lost at All arrived. */
  lost: number;
  /**
   * What its freight is spread over now (§2 estimate): its count when known,
   * otherwise what has arrived from it so far.
   */
  covered: number;
  /** Its count less what arrived and was lost: still with the forwarder. Null when no count was given. */
  toCome: number | null;
  allArrivedOn: string | null;
  open: boolean;
  arrivals: {
    id: string;
    arrivedOn: string;
    lines: { purchaseOrderItemId: string; qty: number }[];
    total: number;
  }[];
  lossIds: string[];
}

export interface LegHandovers {
  legId: string;
  handovers: HandoverSummary[];
  /** Freight paid on every handover, in pounds at each one's rate. */
  freightEgp: string;
  /** Freight per currency, when the handovers were paid in more than one. */
  freightByCurrency: { currency: string; amount: string }[];
  /** Every handover's `covered`, summed. */
  covered: number;
  /** The pieces the leg will carry in the end: everything the cycle ordered. */
  pieces: number;
  /**
   * The leg's cost the costing spreads over every piece (§2, estimate while
   * any handover is open): the freight paid so far × pieces ÷ pieces covered,
   * so every piece carries freight paid ÷ covered, whichever batch brought it.
   * Exactly the freight paid once everything is covered; the freight paid
   * while nothing is covered yet (no count given, nothing arrived).
   */
  legCostEgp: string;
  /** Freight a piece, in pounds: freight paid ÷ covered. Null while nothing is covered. */
  perPieceEgp: string | null;
  /** The same in the handovers' currency, when they share one. */
  perPiece: { amount: string; currency: string } | null;
  /** Every handover All arrived and every piece accounted for: the cost will not move again. */
  final: boolean;
  /** Still in the UAE, not handed over to anyone with a known count. */
  stillInUae: number;
  /** With the forwarder, from handovers with a count. */
  withForwarder: number;
  /** Open handovers with no count: an unknown number more is with the forwarder. */
  withForwarderUnknown: number;
  /** Arrived in Egypt on this leg. */
  arrived: number;
}

/** The handover rows of a leg, in the order they were handed over. */
export function handoverRows(leg: Leg) {
  return leg.departures
    .filter((d) => d.handover)
    .sort(
      (a, b) =>
        positionDay(a.departedOn).localeCompare(positionDay(b.departedOn)) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : 1),
    );
}

/** What a UAE leg's handovers add up to. Null for a leg recorded the old way. */
export function legHandovers(
  cycle: LoadedShipment,
  position: ShipmentPosition,
  legId: string,
): LegHandovers | null {
  const leg = cycle.shippingLegs.find((l) => l.id === legId);
  const legPos = position.legs.find((l) => l.legId === legId);
  if (!leg || !legPos || !leg.usesHandovers) return null;

  const rows = handoverRows(leg);
  const handovers: HandoverSummary[] = rows.map((h, i) => {
    const arrivals = leg.deliveries
      .filter((d) => d.departureId === h.id)
      .sort((a, b) =>
        positionDay(a.arrivedOn).localeCompare(positionDay(b.arrivedOn)),
      )
      .map((d) => {
        const lines = d.lines.map((l) => ({
          purchaseOrderItemId: l.purchaseOrderItemId,
          qty: units(milli(l.qty)),
        }));
        return {
          id: d.id,
          arrivedOn: positionDay(d.arrivedOn),
          lines,
          total: units(lines.reduce((s, l) => s + milli(l.qty), 0)),
        };
      });
    const arrived = arrivals.reduce((s, a) => s + milli(a.total), 0);
    const losses = leg.losses.filter((x) => x.departureId === h.id);
    const lost = losses.reduce((s, x) => s + milli(x.qty), 0);
    const counted = h.pieces === null ? null : h.pieces * 1000;
    return {
      id: h.id,
      number: i + 1,
      handedOverOn: positionDay(h.departedOn),
      pieces: h.pieces,
      freightAmount: D(h.freightAmount).toFixed(2),
      freightCurrency: h.freightCurrency ?? 'EGP',
      freightRateToEgp: D(h.freightRateToEgp ?? 1).toFixed(4),
      freightAmountEgp: D(h.freightAmountEgp).toFixed(2),
      providerId: h.providerId,
      paidByUserId: h.paidByUserId,
      arrived: units(arrived),
      lost: units(lost),
      covered: units(counted ?? arrived),
      toCome:
        counted === null ? null : units(Math.max(0, counted - arrived - lost)),
      allArrivedOn: h.allArrivedOn ? positionDay(h.allArrivedOn) : null,
      open: h.allArrivedOn === null,
      arrivals,
      lossIds: losses.map((x) => x.id),
    };
  });

  const freight = rows.reduce((s, h) => s.add(D(h.freightAmountEgp)), ZERO);
  const byCurrency = new Map<string, Prisma.Decimal>();
  for (const h of rows) {
    const c = h.freightCurrency ?? 'EGP';
    byCurrency.set(c, (byCurrency.get(c) ?? ZERO).add(D(h.freightAmount)));
  }
  const covered = handovers.reduce((s, h) => s + milli(h.covered), 0);
  const pieces = milli(position.totals.ordered);
  const legCost =
    covered === 0 || covered >= pieces
      ? money(freight)
      : money(freight.mul(pieces).div(covered));
  const perPieceEgp =
    covered === 0 ? null : freight.mul(1000).div(covered).toFixed(2);
  const single = byCurrency.size === 1 ? [...byCurrency.entries()][0] : null;
  const perPiece =
    covered === 0 || !single
      ? null
      : {
          amount: single[1].mul(1000).div(covered).toFixed(2),
          currency: single[0],
        };

  const withForwarder = handovers
    .filter((h) => h.open && h.toCome !== null)
    .reduce((s, h) => s + milli(h.toCome), 0);
  const withForwarderUnknown = handovers.filter(
    (h) => h.open && h.pieces === null,
  ).length;
  const arrived = handovers.reduce((s, h) => s + milli(h.arrived), 0);

  return {
    legId,
    handovers,
    freightEgp: freight.toFixed(2),
    freightByCurrency: [...byCurrency.entries()].map(([currency, a]) => ({
      currency,
      amount: a.toFixed(2),
    })),
    covered: units(covered),
    pieces: units(pieces),
    legCostEgp: legCost.toFixed(2),
    perPieceEgp,
    perPiece,
    final:
      handovers.length > 0 &&
      handovers.every((h) => !h.open) &&
      covered >= pieces,
    stillInUae: units(Math.max(0, milli(legPos.atOrigin) - withForwarder)),
    withForwarder: units(withForwarder),
    withForwarderUnknown,
    arrived: units(arrived),
  };
}

/**
 * The most pieces a new handover (or one being corrected) can say it holds
 * (§1, GUESS 2026-11-20): what still waits in the UAE for this leg, less
 * what open handovers with a count still have to bring — those pieces are
 * already with the forwarder. Handovers with no count take nothing: nobody
 * knows how many they hold.
 */
export function handoverPiecesCap(
  handovers: readonly HandoverSummary[],
  atOrigin: number,
  excluding?: string,
): number {
  const others = handovers
    .filter((h) => h.id !== excluding && h.open && h.toCome !== null)
    .reduce((s, h) => s + milli(h.toCome), 0);
  return units(Math.max(0, milli(atOrigin) - others));
}

/** Whether any of a cycle's legs is in handovers and its freight is not final yet. */
export function freightIsEstimate(
  cycle: LoadedShipment,
  position: ShipmentPosition,
): boolean {
  return cycle.shippingLegs.some((l) => {
    if (!l.usesHandovers) return false;
    const s = legHandovers(cycle, position, l.id);
    return !s || !s.final;
  });
}

/**
 * Whether a cycle's profit is an estimate because a leg's freight is (§2,
 * GUESS 2026-11-20): the flag the cycle's Profit card, Take money and the
 * settlement preview carry. Cycles with no leg in handovers are read with
 * one cheap count.
 */
export async function cycleFreightIsEstimate(
  db: Pick<Prisma.TransactionClient, 'importCycle'>,
  cycleId: string,
): Promise<boolean> {
  const legs = await db.importCycle.findUnique({
    where: { id: cycleId },
    select: { shippingLegs: { select: { usesHandovers: true } } },
  });
  if (!legs?.shippingLegs?.some((l) => l.usesHandovers)) return false;
  const loaded = await loadShipment(db, cycleId);
  return loaded ? freightIsEstimate(loaded.cycle, loaded.position) : false;
}
