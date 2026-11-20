// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; freight in EGP must not become a float
import { Prisma } from '@prisma/client';
import { badRequest } from './api-error';
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
 * A handover's freight is paid in parts (§2, owner 2026-11-20): its total
 * (`freightAmount`, in its currency) and the payments made of it, each at
 * the rate actually got. What is not paid yet is counted at the rate stored
 * on the handover (`freightRateToEgp`) — the Exchange rates page's at the
 * last change to the leg's freight — and makes the leg's cost an estimate
 * until it is paid.
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
type HandoverRow = Leg['departures'][number];

/** One payment of a handover's freight, as a screen and the service read it. */
export interface FreightPaymentSummary {
  id: string;
  paidOn: string;
  /** In the handover's currency. */
  amount: string;
  rateToEgp: string;
  amountEgp: string;
  /** Null: the business. */
  paidByUserId: string | null;
  note: string | null;
}

/**
 * What a handover's freight comes to (§2, 2026-11-20): what was paid, at the
 * rates got, and what is still to pay, at the rate the rest is counted at.
 * The pounds are each payment's own plus the rest × that rate, half up.
 */
export function handoverFreight(
  h: Pick<
    HandoverRow,
    'freightAmount' | 'freightCurrency' | 'freightRateToEgp' | 'freightPayments'
  >,
) {
  const total = D(h.freightAmount);
  const paid = h.freightPayments.reduce((s, p) => s.add(D(p.amount)), ZERO);
  const paidEgp = h.freightPayments.reduce(
    (s, p) => s.add(D(p.amountEgp)),
    ZERO,
  );
  const rest = total.sub(paid);
  const toPay = rest.gt(0) ? rest : ZERO;
  const currency = h.freightCurrency ?? 'EGP';
  const rate = currency === 'EGP' ? D(1) : D(h.freightRateToEgp ?? 1);
  const toPayEgp = toPay.gt(0) ? money(toPay.mul(rate)) : ZERO;
  return {
    total,
    currency,
    paid,
    paidEgp,
    toPay,
    toPayRate: rate,
    toPayEgp,
    egp: paidEgp.add(toPayEgp),
  };
}

export interface HandoverSummary {
  id: string;
  /** 1, 2, 3 … in the order they were handed over. */
  number: number;
  handedOverOn: string;
  pieces: number | null;
  /** The lot's freight in full, in its currency. */
  freightAmount: string;
  freightCurrency: string;
  /** The rate the part still to pay is counted at (§2, 2026-11-20). */
  freightRateToEgp: string;
  /** The freight in pounds as costed: paid + still to pay at that rate. */
  freightAmountEgp: string;
  /** Paid so far, in its currency and in pounds at the rates got. */
  freightPaid: string;
  freightPaidEgp: string;
  /** Still to pay, in its currency, and ≈ in pounds at `freightRateToEgp`. */
  freightToPay: string;
  freightToPayEgp: string;
  /** Its payments, oldest first. */
  payments: FreightPaymentSummary[];
  providerId: string | null;
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
  /**
   * The handovers' freight in pounds: what was paid at the rates got, and
   * what is still to pay at the rate it is counted at (§2, 2026-11-20).
   */
  freightEgp: string;
  /** Freight per currency, in full, when the handovers were paid in more than one. */
  freightByCurrency: { currency: string; amount: string }[];
  /** Paid so far, per currency. */
  paidByCurrency: { currency: string; amount: string }[];
  /**
   * Still to pay, per currency, the rate it is counted at and ≈ pounds.
   * Empty once every handover's freight is paid.
   */
  toPayByCurrency: {
    currency: string;
    amount: string;
    rateToEgp: string;
    amountEgp: string;
  }[];
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
  /**
   * Every handover All arrived, every piece accounted for and every freight
   * paid: the cost will not move again.
   */
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
    const f = handoverFreight(h);
    return {
      id: h.id,
      number: i + 1,
      handedOverOn: positionDay(h.departedOn),
      pieces: h.pieces,
      freightAmount: f.total.toFixed(2),
      freightCurrency: f.currency,
      freightRateToEgp: f.toPayRate.toFixed(4),
      freightAmountEgp: f.egp.toFixed(2),
      freightPaid: f.paid.toFixed(2),
      freightPaidEgp: f.paidEgp.toFixed(2),
      freightToPay: f.toPay.toFixed(2),
      freightToPayEgp: f.toPayEgp.toFixed(2),
      payments: h.freightPayments.map((p) => ({
        id: p.id,
        paidOn: positionDay(p.paidOn),
        amount: D(p.amount).toFixed(2),
        rateToEgp: D(p.rateToEgp).toFixed(4),
        amountEgp: D(p.amountEgp).toFixed(2),
        paidByUserId: p.paidByUserId,
        note: p.note,
      })),
      providerId: h.providerId,
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

  const freights = rows.map(handoverFreight);
  const freight = freights.reduce((s, f) => s.add(f.egp), ZERO);
  const byCurrency = new Map<string, Prisma.Decimal>();
  const paidBy = new Map<string, Prisma.Decimal>();
  const toPayBy = new Map<
    string,
    { amount: Prisma.Decimal; rate: Prisma.Decimal; egp: Prisma.Decimal }
  >();
  for (const f of freights) {
    const c = f.currency;
    byCurrency.set(c, (byCurrency.get(c) ?? ZERO).add(f.total));
    if (f.paid.gt(0)) {
      paidBy.set(c, (paidBy.get(c) ?? ZERO).add(f.paid));
    }
    if (f.toPay.gt(0)) {
      const was = toPayBy.get(c);
      toPayBy.set(c, {
        amount: (was?.amount ?? ZERO).add(f.toPay),
        // One leg's handovers are counted together, at one rate per currency.
        rate: was?.rate ?? f.toPayRate,
        egp: (was?.egp ?? ZERO).add(f.toPayEgp),
      });
    }
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
    paidByCurrency: [...paidBy.entries()].map(([currency, a]) => ({
      currency,
      amount: a.toFixed(2),
    })),
    toPayByCurrency: [...toPayBy.entries()].map(([currency, x]) => ({
      currency,
      amount: x.amount.toFixed(2),
      rateToEgp: x.rate.toFixed(4),
      amountEgp: x.egp.toFixed(2),
    })),
    covered: units(covered),
    pieces: units(pieces),
    legCostEgp: legCost.toFixed(2),
    perPieceEgp,
    perPiece,
    final:
      handovers.length > 0 &&
      handovers.every((h) => !h.open) &&
      covered >= pieces &&
      toPayBy.size === 0,
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

/**
 * Where the goods of a cycle's handover legs are, in the leg card's own words
 * (§1, owner 2026-11-20: "fix wording"). A handover writes no departure lines
 * — its goods leave and arrive together, on its arrivals — so the shipment's
 * position reads every piece handed over and not yet arrived as still
 * waiting at the UAE (`atOrigin`). They are not: they are with the
 * forwarder, on the way to Egypt. This is the one place that says so; the
 * shipment's totals line, the goods cards and the timeline read it.
 *
 * - `withForwarder`: the pieces open handovers with a count still have to
 *   bring (their `toCome`, summed);
 * - `withForwarderUnknown`: open handovers given no count — an unknown number
 *   more is with the forwarder ("+ not known", as the leg card says);
 * - `notLeft`: what the shipment calls waiting at a leg's origin, less the
 *   pieces with the forwarder — goods nobody has handed over.
 *
 * Per product nothing changes: a handover has no products, so which ones are
 * with the forwarder is known only as they arrive.
 */
export interface HandedOver {
  withForwarder: number;
  withForwarderUnknown: number;
  notLeft: number;
  /** Per handover leg: its pieces still in the UAE (`stillInUae`) and the two above. */
  legs: {
    legId: string;
    stillInUae: number;
    withForwarder: number;
    withForwarderUnknown: number;
  }[];
}

export function handedOver(
  cycle: LoadedShipment,
  position: ShipmentPosition,
): HandedOver {
  const legs = cycle.shippingLegs
    .map((l) => legHandovers(cycle, position, l.id))
    .filter((s) => s !== null)
    .map((s) => ({
      legId: s.legId,
      stillInUae: s.stillInUae,
      withForwarder: s.withForwarder,
      withForwarderUnknown: s.withForwarderUnknown,
    }));
  const withForwarder = legs.reduce((s, l) => s + milli(l.withForwarder), 0);
  return {
    withForwarder: units(withForwarder),
    withForwarderUnknown: legs.reduce((s, l) => s + l.withForwarderUnknown, 0),
    notLeft: units(
      Math.max(0, milli(position.totals.atOrigin) - withForwarder),
    ),
    legs,
  };
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

/**
 * Refuse settling a cycle while any handover's freight is still to pay (§8,
 * GUESS 2026-11-20): the rest is costed at a rate nobody has paid yet, so the
 * profit being split is an estimate. Pay it (Record payment) first. The same
 * helper the settlement's approval and the transition to Settlement call.
 */
export async function assertHandoverFreightPaid(
  db: Pick<Prisma.TransactionClient, 'importCycle'>,
  cycleId: string,
  code: string,
) {
  const legs = await db.importCycle.findUnique({
    where: { id: cycleId },
    select: { shippingLegs: { select: { usesHandovers: true } } },
  });
  if (!legs?.shippingLegs?.some((l) => l.usesHandovers)) return;
  const loaded = await loadShipment(db, cycleId);
  if (!loaded) return;
  for (const leg of loaded.cycle.shippingLegs) {
    const s = legHandovers(loaded.cycle, loaded.position, leg.id);
    const owed = s?.toPayByCurrency[0];
    if (owed) {
      throw badRequest(
        'HANDOVER_FREIGHT_UNPAID',
        `${code} still has ${owed.amount} ${owed.currency} of handover freight to pay; record that payment before settling.`,
        { cycle: code, amount: owed.amount, currency: owed.currency },
      );
    }
  }
}
