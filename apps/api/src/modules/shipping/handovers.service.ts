import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; freight in EGP must not become a float
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { badRequest, notFound } from '../../common/api-error';
import {
  assertNotFuture,
  businessDay,
  businessToday,
} from '../../common/dates';
import { isUuid } from '../../common/uuid';
import { parseCurrencyCode, parseRateToEgp } from '../../common/fx-rate';
import { legLeavesFrom } from '../../common/cycle-routes';
import { expensePayer } from '../../common/expense-paid-by';
import {
  loadShipment,
  lockCycle,
  syncLegStatuses,
  type LoadedShipment,
} from '../../common/shipment-load';
import {
  positionDay,
  type ShipmentPosition,
} from '../../common/shipment-position';
import {
  handoverFreight,
  handoverPiecesCap,
  legHandovers,
} from '../../common/leg-handovers';
import {
  recordPartnerFreightIn,
  removePartnerFreightIn,
} from '../../common/handover-financing';
import { planRecost, recost, refuseCostChange } from '../costing/leg-recost';
import {
  assertLossNotRefunded,
  assertOpen,
  checkLines,
  deliveryDay,
  DeliveriesService,
  type ShipmentLineInput,
} from './deliveries.service';
import {
  departureDay,
  departureLines,
  deliveryDeleteBlock,
  departureUndoBlock,
  undoReturnsToPreparing,
} from './departure-rules';

/**
 * A UAE leg in handovers (BUSINESS_LOGIC §1, §2, §18 — owner 2026-11-20).
 *
 * Hand over a lot (date, forwarder, freight, pieces when known, who paid),
 * record each batch that arrives from it product by product, and mark it All
 * arrived. The arithmetic is `common/leg-handovers.ts`; the rows are the
 * shipment's own departures, deliveries and losses (see there), so this
 * service writes through `DeliveriesService` (`deliverIn`, `lossIn`) and the
 * departure rules, never around them.
 *
 * Every write takes the cycle's lock, reads the shipment under it, writes,
 * then sets the leg's cost from its handovers (`syncFreight`): the freight
 * so far spread over the pieces it covers, re-costing the cycle through the
 * leg re-cost (§2, 2026-10-17) — the same function a leg edit uses — or
 * refusing with its LEG_COST_LOCKED_* code. Nothing is ever booked as an
 * expense instead.
 *
 * A handover's freight is paid in parts (§2, owner 2026-11-20): its total,
 * and payments of it — on the day, by the business, a core partner (owed to
 * him, §18) or an investor in the cycle (his contribution, a name only) —
 * each at the rate got. The rest is counted at the Exchange rates page's
 * rate, taken again on every change to the leg's freight (a handover, a
 * correction of its freight, a payment recorded, corrected or undone, or
 * "Count at today's rate").
 */

type Tx = Prisma.TransactionClient;
const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);
const milli = (q: Prisma.Decimal.Value | null | undefined) =>
  Math.round(Number(D(q).toString()) * 1000);
const units = (m: number) => m / 1000;
const where = (leg: { origin: string; destination: string }) =>
  `${leg.origin} → ${leg.destination}`;
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

export interface HandoverInput {
  handedOverOn: string;
  providerId?: string | null;
  /** The lot's freight in full. */
  freightAmount: number | string;
  freightCurrency?: string;
  /** The rate got for what is paid now; left out, the Exchange rates page's. */
  freightRateToEgp?: number | string;
  /**
   * Paid now, on the handover day (2026-11-20). Left out: all of it, as
   * before; 0: nothing yet. Less than the freight leaves the rest to pay.
   */
  paidAmount?: number | string | null;
  pieces?: number | null;
  /** Who paid what is paid now; left out, the business. */
  paidByUserId?: string | null;
  note?: string;
}

/** PUT /shipping/handovers/:id — its day, forwarder, freight in full, pieces. */
export interface HandoverUpdateInput {
  handedOverOn?: string;
  providerId?: string | null;
  freightAmount?: number | string;
  freightCurrency?: string;
  pieces?: number | null;
  note?: string;
}

/** A payment of a handover's freight (§2, 2026-11-20). */
export interface FreightPaymentInput {
  paidOn: string;
  /** In the handover's currency. */
  amount: number | string;
  /** The rate got; left out, the Exchange rates page's. */
  rateToEgp?: number | string;
  /** Left out or null: the business. */
  paidByUserId?: string | null;
  note?: string;
}

/** Who paid a payment: the business (null), a core partner, or an investor in the cycle. */
interface Payer {
  id: string;
  name: string;
  /** A partner is owed it (§18); an investor's is his contribution — no debt. */
  kind: 'PARTNER' | 'INVESTOR';
}

export interface ArrivalInput {
  handoverId?: string;
  arrivedOn: string;
  lines: ShipmentLineInput[];
  note?: string;
}

/** Freight as it will be stored: amount, currency, the day's rate and the pounds. */
interface Freight {
  amount: Prisma.Decimal;
  currency: string;
  rate: Prisma.Decimal;
  amountEgp: Prisma.Decimal;
}

@Injectable()
export class HandoversService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private costing: CostingService,
    private cycles: CyclesService,
    private deliveries: DeliveriesService,
  ) {}

  // ─── Checks that need no database ─────────────────────────────────────

  /** A piece count: left out (not known), or a whole number above zero. */
  private pieces(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      throw badRequest(
        'QTY_NOT_POSITIVE',
        'A quantity must be greater than zero.',
      );
    }
    if (!Number.isInteger(n)) {
      throw badRequest(
        'HANDOVER_PIECES_WHOLE',
        'Pieces handed over are counted whole.',
        { pieces: n },
      );
    }
    return n;
  }

  /**
   * The freight: zero or more (a free lot is allowed, GUESS), in a currency
   * the business keeps a rate for, at the rate on the day — given, or today's
   * from the Exchange rates page (§22), as a leg's cost is. The rate is what
   * is paid now; the rest is counted at the page's (`syncFreight`).
   */
  private async freight(
    db: Tx,
    input: Pick<
      HandoverInput,
      'freightAmount' | 'freightCurrency' | 'freightRateToEgp'
    >,
  ): Promise<Freight> {
    const amount = D(input.freightAmount);
    if (
      input.freightAmount === undefined ||
      input.freightAmount === null ||
      input.freightAmount === '' ||
      !amount.isFinite()
    ) {
      throw badRequest('VALIDATION_FAILED', 'freightAmount must be a number.', {
        fields: 'freightAmount',
      });
    }
    if (amount.isNegative()) {
      throw badRequest(
        'LEG_COST_NEGATIVE',
        "A shipping leg's freightAmount cannot be negative.",
        { field: 'freightAmount' },
      );
    }
    const currency = parseCurrencyCode(input.freightCurrency) ?? 'EGP';
    let rate = parseRateToEgp(input.freightRateToEgp);
    if (currency === 'EGP') {
      if (rate && !rate.eq(1)) {
        throw badRequest(
          'BASE_CURRENCY_RATE_FIXED',
          'EGP is the base currency — its rate is 1 by definition and cannot be changed.',
          { currency: 'EGP' },
        );
      }
      rate = D(1);
    } else if (!rate) {
      rate = await this.pageRate(db, currency);
    }
    return {
      amount: amount.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      currency,
      rate,
      amountEgp: amount
        .mul(rate)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
    };
  }

  /** Today's rate on the Exchange rates page (§22); EGP is 1. */
  private async pageRate(db: Tx, currency: string) {
    if (currency === 'EGP') return D(1);
    const known = await db.currencyRate.findUnique({
      where: { code: currency },
      select: { rateToEgp: true },
    });
    if (!known || known.rateToEgp === null) {
      throw badRequest(
        'NO_RATE_RECORDED',
        `No exchange rate has been recorded for ${currency}.`,
        { currency },
      );
    }
    return D(known.rateToEgp);
  }

  /**
   * Who paid a payment of the freight (§2, §18 — 2026-11-20): the business
   * (null); an active core partner, who is then owed it in its currency; or
   * an investor in this cycle — his money is his capital contribution,
   * already on the Funding card, so it is his name on the payment and no debt
   * (GUESS). Anyone else is refused, coded.
   */
  private async payer(
    db: Tx,
    cycleId: string,
    value: unknown,
    amount: Prisma.Decimal,
  ): Promise<Payer | null> {
    if (value === undefined || value === null || value === '') return null;
    const refuse = () =>
      badRequest(
        'FREIGHT_PAYER_NOT_ON_CYCLE',
        'Freight is paid by the business, a core partner, or an investor in this cycle; that is none of them.',
      );
    if (typeof value !== 'string' || !isUuid(value)) throw refuse();
    const user = await db.user.findUnique({
      where: { id: value },
      select: {
        id: true,
        role: true,
        email: true,
        partner: { select: { displayName: true } },
      },
    });
    if (!user) throw refuse();
    let payer: Payer;
    if (user.role === 'CORE_PARTNER') {
      payer = { ...(await expensePayer(db, value)), kind: 'PARTNER' };
    } else {
      const investor = await db.cycleParticipant.findFirst({
        where: { cycleId, investorUserId: value },
        select: { id: true },
      });
      if (!investor) throw refuse();
      payer = {
        id: user.id,
        name: user.partner?.displayName ?? user.email,
        kind: 'INVESTOR',
      };
    }
    if (!amount.gt(0)) {
      throw badRequest(
        'HANDOVER_PAID_BY_NOTHING_PAID',
        `No freight was paid on this handover, so ${payer.name} cannot have paid it.`,
        { partner: payer.name },
      );
    }
    return payer;
  }

  /** An amount of a payment: a number above zero, kept to the piastre. */
  private paymentAmount(value: unknown) {
    if (value === undefined || value === null || value === '') {
      throw badRequest('VALIDATION_FAILED', 'amount must be a number.', {
        fields: 'amount',
      });
    }
    const amount = D(
      typeof value === 'number' || typeof value === 'string' ? value : NaN,
    );
    if (!amount.isFinite()) {
      throw badRequest('VALIDATION_FAILED', 'amount must be a number.', {
        fields: 'amount',
      });
    }
    if (!amount.gt(0)) {
      throw badRequest(
        'AMOUNT_NOT_POSITIVE',
        'A payment must be more than zero.',
      );
    }
    return amount.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  /** A payment's day: a real day, not in the future, not before the handover. */
  private paymentDay(value: unknown, handedOverOn: string) {
    if (
      typeof value !== 'string' ||
      !value ||
      Number.isNaN(new Date(value).getTime())
    ) {
      throw badRequest('VALIDATION_FAILED', 'paidOn must be a date.', {
        fields: 'paidOn',
      });
    }
    assertNotFuture(value, 'FREIGHT_PAID');
    const day = businessDay(value);
    if (day < handedOverOn) {
      throw badRequest(
        'FREIGHT_PAYMENT_BEFORE_HANDOVER',
        `Freight paid on ${day} cannot be for goods handed over on ${handedOverOn}.`,
        { day, handedOverOn },
      );
    }
    return day;
  }

  /** The rate got for a payment: given (above zero), or the page's; EGP is 1. */
  private async paymentRate(db: Tx, currency: string, value: unknown) {
    const given = parseRateToEgp(value);
    if (currency === 'EGP') {
      if (given && !given.eq(1)) {
        throw badRequest(
          'BASE_CURRENCY_RATE_FIXED',
          'EGP is the base currency — its rate is 1 by definition and cannot be changed.',
          { currency: 'EGP' },
        );
      }
      return D(1);
    }
    return given ?? this.pageRate(db, currency);
  }

  /** More than is still to pay of a handover's freight is refused. */
  private assertNotOverpaid(
    toPay: Prisma.Decimal,
    amount: Prisma.Decimal,
    currency: string,
    handover: number,
  ) {
    if (amount.gt(toPay)) {
      throw badRequest(
        'FREIGHT_PAYMENT_EXCEEDS_UNPAID',
        `Only ${toPay.toFixed(2)} ${currency} of handover ${handover}'s freight is still to pay, so ${amount.toFixed(2)} cannot be paid on it.`,
        {
          toPay: toPay.toFixed(2),
          currency,
          asked: amount.toFixed(2),
          handover,
        },
      );
    }
  }

  private async provider(db: Tx, value: unknown) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !isUuid(value)) throw notFound('provider');
    const p = await db.provider.findUnique({
      where: { id: value },
      select: { id: true, name: true },
    });
    if (!p) throw notFound('provider');
    return p;
  }

  // ─── Reading what is locked ───────────────────────────────────────────

  private async loaded(tx: Tx, cycleId: string) {
    const loaded = await loadShipment(tx, cycleId);
    if (!loaded) throw notFound('cycle');
    return loaded;
  }

  /** The leg of a handover's own cycle, or 404: a leg not leaving the UAE takes none. */
  private legFor(cycle: LoadedShipment, legId: string) {
    const leg = cycle.shippingLegs.find((l) => l.id === legId);
    if (!leg) throw notFound('shippingLeg');
    return leg;
  }

  /** A handover by id within this cycle's legs; another cycle's is no such handover. */
  private handoverIn(cycle: LoadedShipment, id: string) {
    for (const leg of cycle.shippingLegs) {
      const h = leg.departures.find((d) => d.id === id && d.handover);
      if (h) return { leg, handover: h };
    }
    throw notFound('handover');
  }

  private summary(
    cycle: LoadedShipment,
    position: ShipmentPosition,
    legId: string,
  ) {
    return legHandovers(cycle, position, legId)!;
  }

  /** The cycle a leg, a handover or an arrival belongs to — read before the lock. */
  private async cycleOfLeg(legId: string) {
    if (!isUuid(legId)) throw notFound('shippingLeg');
    const leg = await this.prisma.shippingLeg.findUnique({
      where: { id: legId },
      select: { cycleId: true },
    });
    if (!leg) throw notFound('shippingLeg');
    return leg.cycleId;
  }

  private async cycleOfHandover(id: string) {
    if (!isUuid(id)) throw notFound('handover');
    const h = await this.prisma.shipmentDeparture.findUnique({
      where: { id },
      select: { handover: true, leg: { select: { cycleId: true } } },
    });
    if (!h || !h.handover) throw notFound('handover');
    return h.leg.cycleId;
  }

  private async cycleOfPayment(id: string) {
    if (!isUuid(id)) throw notFound('freightPayment');
    const p = await this.prisma.handoverFreightPayment.findUnique({
      where: { id },
      select: { handover: { select: { leg: { select: { cycleId: true } } } } },
    });
    if (!p) throw notFound('freightPayment');
    return p.handover.leg.cycleId;
  }

  /** A payment by id within this cycle's handovers. */
  private paymentIn(cycle: LoadedShipment, id: string) {
    for (const leg of cycle.shippingLegs) {
      for (const h of leg.departures) {
        const p = h.freightPayments.find((x) => x.id === id);
        if (h.handover && p) return { leg, handover: h, payment: p };
      }
    }
    throw notFound('freightPayment');
  }

  // ─── The leg's freight ────────────────────────────────────────────────

  /**
   * Set the leg's cost from its handovers (§2, 2026-11-20). In the caller's
   * transaction, after its writes. A change re-costs the cycle through the
   * leg re-cost — or is refused with its LEG_COST_LOCKED_* code, which rolls
   * the whole write back: nothing is booked as an expense instead.
   */
  private async syncFreight(
    tx: Tx,
    cycleId: string,
    legId: string,
    countRestAtPageRate = false,
  ) {
    await this.countRest(tx, legId, countRestAtPageRate);
    const { cycle, position } = await this.loaded(tx, cycleId);
    const s = this.summary(cycle, position, legId);
    const row = await tx.shippingLeg.findUniqueOrThrow({
      where: { id: legId },
    });
    const target = D(s.legCostEgp);
    if (
      row.costBasis === 'FLAT' &&
      row.currency === 'EGP' &&
      D(row.amountEgp).eq(target) &&
      D(row.amount).eq(target)
    ) {
      return null;
    }
    const before = D(row.amountEgp);
    const moves = !before.eq(target) || row.costBasis !== 'FLAT';
    const plan = moves
      ? await planRecost(tx, this.costing, cycle, position)
      : null;
    if (plan && !plan.state.editable) {
      refuseCostChange(plan.state.reason!, plan.state.params, where(row));
    }
    await tx.shippingLeg.update({
      where: { id: legId },
      data: {
        costBasis: 'FLAT',
        ratePerUnit: null,
        chargeablePieces: null,
        chargeableWeightKg: null,
        currency: 'EGP',
        fxRateToEgp: 1,
        amount: target,
        amountEgp: target,
      },
    });
    const recosted =
      plan?.state.recosts === true
        ? await recost(tx, this.costing, cycleId, plan)
        : [];
    return {
      oldAmountEgp: before.toFixed(2),
      newAmountEgp: target.toFixed(2),
      batches: recosted,
    };
  }

  /**
   * Each handover's freight in pounds as costed (§2, 2026-11-20): its
   * payments' pounds + what is still to pay × the rate it is counted at. On a
   * change to the leg's freight that rate is taken again from the Exchange
   * rates page, so the estimate follows the page then; otherwise it stays.
   */
  private async countRest(tx: Tx, legId: string, atPageRate: boolean) {
    const rows = await tx.shipmentDeparture.findMany({
      where: { legId, handover: true },
      select: {
        id: true,
        freightAmount: true,
        freightCurrency: true,
        freightRateToEgp: true,
        freightAmountEgp: true,
        freightPayments: {
          select: {
            id: true,
            paidOn: true,
            amount: true,
            rateToEgp: true,
            amountEgp: true,
            paidByUserId: true,
            note: true,
          },
        },
      },
    });
    const rates = new Map<string, Prisma.Decimal>();
    for (const h of rows) {
      let rate = D(h.freightRateToEgp ?? 1);
      if (atPageRate && handoverFreight(h).toPay.gt(0)) {
        const c = h.freightCurrency ?? 'EGP';
        if (!rates.has(c)) rates.set(c, await this.pageRate(tx, c));
        rate = rates.get(c)!;
      }
      const f = handoverFreight({ ...h, freightRateToEgp: rate });
      if (
        !rate.eq(D(h.freightRateToEgp ?? 1)) ||
        !f.egp.eq(D(h.freightAmountEgp))
      ) {
        await tx.shipmentDeparture.update({
          where: { id: h.id },
          data: { freightRateToEgp: rate, freightAmountEgp: f.egp },
        });
      }
    }
  }

  /** After a write: the stored leg statuses, the status walk, the audit row. */
  private async finish(
    tx: Tx,
    cycleId: string,
    actorId: string,
    audit: {
      action: string;
      entityType: string;
      entityId: string;
      beforeJson?: unknown;
      afterJson?: unknown;
    },
    follow: boolean,
  ) {
    const changed = await syncLegStatuses(tx, cycleId);
    const followed = follow
      ? await this.deliveries.followShipment(tx, cycleId)
      : null;
    await this.audit.log({ actorUserId: actorId, ...audit }, tx);
    return { changed, followed };
  }

  private async announce(
    cycleId: string,
    actorId: string,
    out: {
      changed: { legId: string; from: string; to: string }[];
      followed: Awaited<ReturnType<DeliveriesService['followShipment']>> | null;
    },
  ) {
    if (out.followed)
      await this.deliveries.announceFollow(out.followed, actorId);
    await this.deliveries.notifyArrivals(cycleId, out.changed);
  }

  // ─── Hand over ────────────────────────────────────────────────────────

  /**
   * POST /shipping/legs/:id/handovers — a lot given to the forwarder in the
   * UAE. No products: they are counted as each batch arrives.
   *
   * Refused: a leg that does not leave the UAE; one already recorded the old
   * way (a departure, a delivery or a loss of its own); nothing waiting there
   * by that day; a date in the future; more pieces than are still in the UAE
   * and not already with the forwarder under another handover's count.
   */
  async create(legId: string, input: HandoverInput, actorId: string) {
    const day = departureDay(input.handedOverOn);
    const pieces = this.pieces(input.pieces);
    const cycleId = await this.cycleOfLeg(legId);

    const out = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const { cycle, position } = await this.loaded(tx, cycleId);
      assertOpen(cycle);
      const leg = this.legFor(cycle, legId);
      if (legLeavesFrom(cycle.originType, leg.sequence) !== 'UAE') {
        throw badRequest(
          'HANDOVER_NOT_FROM_UAE',
          `${where(leg)} does not leave the UAE; only a leg leaving the UAE goes in handovers.`,
          { leg: where(leg) },
        );
      }
      // An old-style leg keeps its own form: its departures carry products.
      if (
        !leg.usesHandovers &&
        (leg.departures.length > 0 ||
          leg.deliveries.length > 0 ||
          leg.losses.length > 0)
      ) {
        throw badRequest(
          'LEG_RECORDED_WITHOUT_HANDOVERS',
          `${where(leg)} already has departures or deliveries recorded with their products; keep recording it that way.`,
          { leg: where(leg) },
        );
      }
      const freight = await this.freight(tx, input);
      // What is paid now (§2, 2026-11-20): all of it unless said, never more.
      const paidNow =
        input.paidAmount === undefined
          ? freight.amount
          : input.paidAmount === null || input.paidAmount === ''
            ? D(0)
            : D(input.paidAmount);
      if (!paidNow.isFinite()) {
        throw badRequest('VALIDATION_FAILED', 'paidAmount must be a number.', {
          fields: 'paidAmount',
        });
      }
      if (paidNow.isNegative()) {
        throw badRequest(
          'AMOUNT_NOT_POSITIVE',
          'A payment must be more than zero.',
        );
      }
      const paid = paidNow.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      this.assertNotOverpaid(freight.amount, paid, freight.currency, 1);
      const payer = await this.payer(tx, cycleId, input.paidByUserId, paid);
      const forwarder = await this.provider(tx, input.providerId);

      // What could have been handed over that day: everything that had
      // reached the UAE by then and not left (the departure rules' own
      // reading — DEPARTURE_NOTHING_WAITING, DEPARTURE_BEFORE_ARRIVAL).
      const couldLeave = departureLines(cycle, position, legId, day).reduce(
        (s, l) => s + milli(l.qty),
        0,
      );
      const legPos = position.legs.find((l) => l.legId === legId)!;
      if (pieces !== null) {
        // Not in handovers yet: nothing is with the forwarder.
        const handovers = legHandovers(cycle, position, legId)?.handovers ?? [];
        const cap = Math.min(
          milli(handoverPiecesCap(handovers, legPos.atOrigin)),
          couldLeave,
        );
        if (pieces * 1000 > cap) {
          throw badRequest(
            'HANDOVER_PIECES_EXCEED_WAITING',
            `Only ${units(cap)} pieces are still in the UAE and not already with the forwarder, so ${pieces} cannot have been handed over.`,
            { available: units(cap), asked: pieces, leg: where(leg) },
          );
        }
      }

      if (!leg.usesHandovers) {
        await tx.shippingLeg.update({
          where: { id: legId },
          data: { usesHandovers: true },
        });
      }
      const handover = await tx.shipmentDeparture.create({
        data: {
          legId,
          departedOn: asDate(day),
          note: input.note?.trim() || null,
          createdBy: actorId,
          handover: true,
          freightAmount: freight.amount,
          freightCurrency: freight.currency,
          // The rest's rate and the pounds are set by syncFreight below.
          freightRateToEgp: freight.rate,
          freightAmountEgp: freight.amountEgp,
          pieces,
          providerId: forwarder?.id ?? null,
          // Who paid is each payment's now (2026-11-20).
          paidByUserId: null,
        },
      });
      if (paid.gt(0)) {
        await this.writePayment(tx, {
          cycleId,
          handoverId: handover.id,
          day,
          amount: paid,
          currency: freight.currency,
          rate: freight.rate,
          payer,
          actorId,
        });
      }
      const recost = await this.syncFreight(tx, cycleId, legId, true);
      const done = await this.finish(
        tx,
        cycleId,
        actorId,
        {
          action: 'CREATE',
          entityType: 'ShipmentHandover',
          entityId: handover.id,
          afterJson: { ...handover, recost },
        },
        // The leg's first departure moves the cycle on (§1, L3), as any is.
        leg.departures.length === 0,
      );
      return { handover, ...done };
    });

    await this.announce(cycleId, actorId, out);
    return {
      data: out.handover,
      cycleStatus: out.followed?.cycleStatus ?? null,
    };
  }

  /**
   * PUT /shipping/handovers/:id — correct a handover: its day, forwarder,
   * freight in full, piece count. The freight may be corrected at any time it
   * can still re-cost (a late bill), never below what was already paid of it
   * (`HANDOVER_FREIGHT_BELOW_PAID`), and its currency only while nothing is
   * paid in the old one. The day and the count only while it is open, never
   * past what has already arrived from it; a payment made on the old day
   * ("paid now") moves with it, one dated before the new day refuses it.
   * What was paid, at what rate and by whom is each payment's — corrected on
   * the payment (`PUT /shipping/freight-payments/:id`).
   */
  async update(id: string, input: HandoverUpdateInput, actorId: string) {
    const cycleId = await this.cycleOfHandover(id);
    const out = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const { cycle, position } = await this.loaded(tx, cycleId);
      assertOpen(cycle);
      const { leg, handover: h } = this.handoverIn(cycle, id);
      const before = await tx.shipmentDeparture.findUniqueOrThrow({
        where: { id },
        include: { freightPayments: true },
      });
      const summary = this.summary(cycle, position, leg.id);
      const mine = summary.handovers.find((x) => x.id === id)!;

      const day = input.handedOverOn
        ? departureDay(input.handedOverOn)
        : mine.handedOverOn;
      const pieces =
        input.pieces === undefined ? h.pieces : this.pieces(input.pieces);
      const closed = !mine.open;
      if (closed && (day !== mine.handedOverOn || pieces !== h.pieces)) {
        throw badRequest(
          'HANDOVER_ALL_ARRIVED',
          `Handover ${mine.number} was marked all arrived; undo that first to change its day or its pieces.`,
          { handover: mine.number },
        );
      }
      const firstArrival = mine.arrivals[0]?.arrivedOn;
      if (firstArrival && firstArrival < day) {
        throw badRequest(
          'ARRIVAL_BEFORE_HANDOVER',
          `A batch arrived from this handover on ${firstArrival}, before ${day}.`,
          { day: firstArrival, handedOverOn: day },
        );
      }
      // Paid on the handover day: paid with it, so it moves with it.
      const movesWith = mine.payments.filter(
        (p) => p.paidOn === mine.handedOverOn,
      );
      if (day !== mine.handedOverOn) {
        const earlier = mine.payments.find(
          (p) => p.paidOn !== mine.handedOverOn && p.paidOn < day,
        );
        if (earlier) {
          throw badRequest(
            'FREIGHT_PAYMENT_BEFORE_HANDOVER',
            `Freight was paid on ${earlier.paidOn}, before ${day}; correct that payment first.`,
            { day: earlier.paidOn, handedOverOn: day },
          );
        }
        // What it brought must have reached the UAE by the new day.
        const own = h.lines.map((l) => ({
          purchaseOrderItemId: l.purchaseOrderItemId,
          qty: Number(l.qty),
        }));
        if (own.length > 0) {
          departureLines(cycle, position, leg.id, day, own, id);
        }
      }
      if (pieces !== null) {
        const accounted = milli(mine.arrived) + milli(mine.lost);
        if (pieces * 1000 < accounted) {
          throw badRequest(
            'HANDOVER_PIECES_BELOW_ARRIVED',
            `${units(accounted)} pieces already came from this handover, so it cannot have held ${pieces}.`,
            { arrived: units(accounted), asked: pieces },
          );
        }
        const legPos = position.legs.find((l) => l.legId === leg.id)!;
        const cap = milli(
          handoverPiecesCap(summary.handovers, legPos.atOrigin, id),
        );
        if (pieces * 1000 - accounted > cap) {
          throw badRequest(
            'HANDOVER_PIECES_EXCEED_WAITING',
            `Only ${units(cap)} pieces are still in the UAE and not already with the forwarder, so ${pieces} cannot have been handed over.`,
            {
              available: units(cap + accounted),
              asked: pieces,
              leg: where(leg),
            },
          );
        }
      }

      const currency =
        parseCurrencyCode(input.freightCurrency) ??
        before.freightCurrency ??
        'EGP';
      const paid = D(mine.freightPaid);
      if (currency !== before.freightCurrency && paid.gt(0)) {
        throw badRequest(
          'HANDOVER_FREIGHT_CURRENCY_HAS_PAYMENTS',
          `${mine.freightPaid} ${mine.freightCurrency} of handover ${mine.number}'s freight is paid in ${mine.freightCurrency}; undo those payments to change its currency.`,
          {
            handover: mine.number,
            paid: mine.freightPaid,
            currency: mine.freightCurrency,
          },
        );
      }
      const freight = await this.freight(tx, {
        freightAmount:
          input.freightAmount ?? (before.freightAmount?.toString() as string),
        freightCurrency: currency,
        // The rest is counted at the page's; a rate here is no payment's.
        freightRateToEgp:
          currency === 'EGP'
            ? undefined
            : currency === before.freightCurrency
              ? before.freightRateToEgp?.toString()
              : undefined,
      });
      if (freight.amount.lt(paid)) {
        throw badRequest(
          'HANDOVER_FREIGHT_BELOW_PAID',
          `${mine.freightPaid} ${mine.freightCurrency} of handover ${mine.number}'s freight is already paid, so it cannot be ${freight.amount.toFixed(2)}.`,
          {
            handover: mine.number,
            paid: mine.freightPaid,
            asked: freight.amount.toFixed(2),
            currency: mine.freightCurrency,
          },
        );
      }
      const forwarder =
        input.providerId === undefined
          ? { id: before.providerId }
          : await this.provider(tx, input.providerId);

      const updated = await tx.shipmentDeparture.update({
        where: { id },
        data: {
          departedOn: asDate(day),
          note:
            input.note === undefined ? before.note : input.note.trim() || null,
          freightAmount: freight.amount,
          freightCurrency: freight.currency,
          freightRateToEgp: freight.rate,
          pieces,
          providerId: forwarder?.id ?? null,
        },
      });
      if (day !== mine.handedOverOn) {
        for (const p of movesWith) {
          // His debt is dated the day he paid: it moves with the payment.
          const row = before.freightPayments.find((x) => x.id === p.id)!;
          const payer = await this.payer(tx, cycleId, row.paidByUserId, D(1));
          await removePartnerFreightIn(
            tx,
            p.id,
            `Handover of ${mine.handedOverOn} moved to ${day}`,
            actorId,
          );
          await tx.handoverFreightPayment.update({
            where: { id: p.id },
            data: { paidOn: asDate(day) },
          });
          if (payer?.kind === 'PARTNER') {
            await recordPartnerFreightIn(tx, {
              handoverId: id,
              paymentId: p.id,
              cycleId,
              partner: payer,
              currency: freight.currency,
              amount: D(row.amount),
              rate: D(row.rateToEgp),
              amountEgp: D(row.amountEgp),
              day,
              actorId,
            });
          }
        }
      }
      const freightMoved =
        !D(before.freightAmount).eq(freight.amount) ||
        before.freightCurrency !== freight.currency;
      const recost = await this.syncFreight(tx, cycleId, leg.id, freightMoved);
      const done = await this.finish(
        tx,
        cycleId,
        actorId,
        {
          action: 'UPDATE',
          entityType: 'ShipmentHandover',
          entityId: id,
          beforeJson: before,
          afterJson: { ...updated, recost },
        },
        false,
      );
      return { updated, ...done };
    });
    await this.announce(cycleId, actorId, out);
    return { data: out.updated };
  }

  /**
   * DELETE /shipping/handovers/:id — a handover recorded by mistake. Refused
   * once a batch arrived from it (undo those first) or it was marked all
   * arrived, when the cycle's status says the leg left and it is the leg's
   * only departure (DEPARTURE_IN_USE, as any departure), or when a partner
   * who paid its freight has been repaid on it. Its payments go with it.
   */
  async remove(id: string, actorId: string) {
    const cycleId = await this.cycleOfHandover(id);
    const out = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const { cycle, position } = await this.loaded(tx, cycleId);
      assertOpen(cycle);
      const { leg, handover } = this.handoverIn(cycle, id);
      const mine = this.summary(cycle, position, leg.id).handovers.find(
        (x) => x.id === id,
      )!;
      if (!mine.open) {
        throw badRequest(
          'HANDOVER_ALL_ARRIVED',
          `Handover ${mine.number} was marked all arrived; undo that first.`,
          { handover: mine.number },
        );
      }
      if (mine.arrivals.length > 0) {
        throw badRequest(
          'HANDOVER_IN_USE',
          `${mine.arrivals.length} batch(es) arrived from handover ${mine.number}; undo those arrivals first.`,
          { handover: mine.number, arrivals: mine.arrivals.length },
        );
      }
      const block = departureUndoBlock(cycle, position, id);
      if (block) {
        throw badRequest('DEPARTURE_IN_USE', block.english, { why: block.why });
      }
      const toPreparing = undoReturnsToPreparing(cycle, position, id);
      for (const p of mine.payments) {
        await removePartnerFreightIn(
          tx,
          p.id,
          `Handover of ${mine.handedOverOn} undone`,
          actorId,
        );
      }
      await tx.shipmentDeparture.delete({ where: { id } });
      await this.syncFreight(tx, cycleId, leg.id);
      const back = toPreparing
        ? await this.cycles.returnToPreparingIn(tx, cycleId)
        : null;
      const done = await this.finish(
        tx,
        cycleId,
        actorId,
        {
          action: 'DELETE',
          entityType: 'ShipmentHandover',
          entityId: id,
          beforeJson: handover,
        },
        false,
      );
      return { back, ...done };
    });
    if (out.back) await this.cycles.announceTransition(out.back.plan, actorId);
    await this.announce(cycleId, actorId, out);
    return {
      data: { id, deleted: true },
      cycleStatus: out.back?.cycleStatus ?? null,
    };
  }

  // ─── Freight payments (§2, owner 2026-11-20) ──────────────────────────

  /** Write one payment and, when a core partner paid it, what the business owes him. */
  private async writePayment(
    tx: Tx,
    input: {
      cycleId: string;
      handoverId: string;
      day: string;
      amount: Prisma.Decimal;
      currency: string;
      rate: Prisma.Decimal;
      payer: Payer | null;
      note?: string;
      actorId: string;
    },
  ) {
    const amountEgp = input.amount
      .mul(input.rate)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const payment = await tx.handoverFreightPayment.create({
      data: {
        departureId: input.handoverId,
        paidOn: asDate(input.day),
        amount: input.amount,
        rateToEgp: input.rate,
        amountEgp,
        paidByUserId: input.payer?.id ?? null,
        note: input.note?.trim() || null,
        createdBy: input.actorId,
      },
    });
    if (input.payer?.kind === 'PARTNER') {
      await recordPartnerFreightIn(tx, {
        handoverId: input.handoverId,
        paymentId: payment.id,
        cycleId: input.cycleId,
        partner: input.payer,
        currency: input.currency,
        amount: input.amount,
        rate: input.rate,
        amountEgp,
        day: input.day,
        actorId: input.actorId,
      });
    }
    return payment;
  }

  /**
   * POST /shipping/handovers/:id/freight-payments — some or all of what is
   * still to pay of a handover's freight, paid on a day at the rate got.
   * Refused: more than is still to pay, a day in the future or before the
   * handover, a payer who is not the business, a core partner or an investor
   * in the cycle, a closed cycle — and a re-cost that is locked
   * (LEG_COST_LOCKED_*), with nothing written.
   */
  async addPayment(
    handoverId: string,
    input: FreightPaymentInput,
    actorId: string,
  ) {
    const cycleId = await this.cycleOfHandover(handoverId);
    const amount = this.paymentAmount(input.amount);
    const out = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const { cycle, position } = await this.loaded(tx, cycleId);
      assertOpen(cycle);
      const { leg } = this.handoverIn(cycle, handoverId);
      const mine = this.summary(cycle, position, leg.id).handovers.find(
        (x) => x.id === handoverId,
      )!;
      const day = this.paymentDay(input.paidOn, mine.handedOverOn);
      this.assertNotOverpaid(
        D(mine.freightToPay),
        amount,
        mine.freightCurrency,
        mine.number,
      );
      const rate = await this.paymentRate(
        tx,
        mine.freightCurrency,
        input.rateToEgp,
      );
      const payer = await this.payer(tx, cycleId, input.paidByUserId, amount);
      const payment = await this.writePayment(tx, {
        cycleId,
        handoverId,
        day,
        amount,
        currency: mine.freightCurrency,
        rate,
        payer,
        note: input.note,
        actorId,
      });
      const recost = await this.syncFreight(tx, cycleId, leg.id, true);
      const done = await this.finish(
        tx,
        cycleId,
        actorId,
        {
          action: 'CREATE',
          entityType: 'HandoverFreightPayment',
          entityId: payment.id,
          afterJson: { ...payment, recost },
        },
        false,
      );
      return { payment, ...done };
    });
    await this.announce(cycleId, actorId, out);
    return { data: out.payment };
  }

  /**
   * PUT /shipping/freight-payments/:id — correct a payment: its day, amount,
   * rate or who paid. The same refusals as recording one, the amount judged
   * against what is still to pay with this payment taken off. A partner's
   * debt for it is replaced only while nothing of it was repaid
   * (`FINANCING_HAS_REPAYMENTS`).
   */
  async updatePayment(
    id: string,
    input: Partial<FreightPaymentInput>,
    actorId: string,
  ) {
    const cycleId = await this.cycleOfPayment(id);
    const out = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const { cycle, position } = await this.loaded(tx, cycleId);
      assertOpen(cycle);
      const { leg, handover, payment: was } = this.paymentIn(cycle, id);
      const mine = this.summary(cycle, position, leg.id).handovers.find(
        (x) => x.id === handover.id,
      )!;
      const amount =
        input.amount === undefined
          ? D(was.amount)
          : this.paymentAmount(input.amount);
      const day =
        input.paidOn === undefined
          ? positionDay(was.paidOn)
          : this.paymentDay(input.paidOn, mine.handedOverOn);
      this.assertNotOverpaid(
        D(mine.freightToPay).add(D(was.amount)),
        amount,
        mine.freightCurrency,
        mine.number,
      );
      const rate =
        input.rateToEgp === undefined
          ? D(was.rateToEgp)
          : await this.paymentRate(tx, mine.freightCurrency, input.rateToEgp);
      const payer = await this.payer(
        tx,
        cycleId,
        input.paidByUserId === undefined
          ? was.paidByUserId
          : input.paidByUserId,
        amount,
      );
      const amountEgp = amount
        .mul(rate)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const moved =
        !amount.eq(D(was.amount)) ||
        !rate.eq(D(was.rateToEgp)) ||
        day !== positionDay(was.paidOn) ||
        (payer?.id ?? null) !== was.paidByUserId;
      // Nothing moved (a note): what he is owed stays as it was.
      if (moved) {
        await removePartnerFreightIn(
          tx,
          id,
          `Freight payment of ${positionDay(was.paidOn)} corrected`,
          actorId,
        );
      }
      const updated = await tx.handoverFreightPayment.update({
        where: { id },
        data: {
          paidOn: asDate(day),
          amount,
          rateToEgp: rate,
          amountEgp,
          paidByUserId: payer?.id ?? null,
          note: input.note === undefined ? was.note : input.note.trim() || null,
        },
      });
      if (moved && payer?.kind === 'PARTNER') {
        await recordPartnerFreightIn(tx, {
          handoverId: handover.id,
          paymentId: id,
          cycleId,
          partner: payer,
          currency: mine.freightCurrency,
          amount,
          rate,
          amountEgp,
          day,
          actorId,
        });
      }
      const recost = await this.syncFreight(tx, cycleId, leg.id, true);
      const done = await this.finish(
        tx,
        cycleId,
        actorId,
        {
          action: 'UPDATE',
          entityType: 'HandoverFreightPayment',
          entityId: id,
          beforeJson: was,
          afterJson: { ...updated, recost },
        },
        false,
      );
      return { updated, ...done };
    });
    await this.announce(cycleId, actorId, out);
    return { data: out.updated };
  }

  /**
   * DELETE /shipping/freight-payments/:id — a payment recorded by mistake.
   * Its amount is to pay again, counted at the page's rate. Refused while a
   * partner who paid it has been repaid on it (`FINANCING_HAS_REPAYMENTS`),
   * or when the re-cost is locked (LEG_COST_LOCKED_*).
   */
  async removePayment(id: string, actorId: string) {
    const cycleId = await this.cycleOfPayment(id);
    const out = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const { cycle } = await this.loaded(tx, cycleId);
      assertOpen(cycle);
      const { leg, payment } = this.paymentIn(cycle, id);
      await removePartnerFreightIn(
        tx,
        id,
        `Freight payment of ${positionDay(payment.paidOn)} undone`,
        actorId,
      );
      await tx.handoverFreightPayment.delete({ where: { id } });
      const recost = await this.syncFreight(tx, cycleId, leg.id, true);
      return this.finish(
        tx,
        cycleId,
        actorId,
        {
          action: 'DELETE',
          entityType: 'HandoverFreightPayment',
          entityId: id,
          beforeJson: payment,
          afterJson: { recost },
        },
        false,
      );
    });
    await this.announce(cycleId, actorId, out);
    return { data: { id, deleted: true } };
  }

  /**
   * POST /shipping/legs/:id/freight/recount — count what is still to pay at
   * today's rate on the Exchange rates page (§2, GUESS 2026-11-20). A change
   * to the page restates nothing by itself (§22); the card says when the
   * page has moved since, and this brings the estimate to it, re-costing as
   * any freight change does.
   */
  async recount(legId: string, actorId: string) {
    const cycleId = await this.cycleOfLeg(legId);
    const out = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const { cycle } = await this.loaded(tx, cycleId);
      assertOpen(cycle);
      const leg = this.legFor(cycle, legId);
      if (!leg.usesHandovers) {
        throw badRequest(
          'LEG_NOT_IN_HANDOVERS',
          `${where(leg)} is not recorded in handovers; record its deliveries instead.`,
          { leg: where(leg) },
        );
      }
      const recost = await this.syncFreight(tx, cycleId, legId, true);
      const done = await this.finish(
        tx,
        cycleId,
        actorId,
        {
          action: 'UPDATE',
          entityType: 'ShippingLeg',
          entityId: legId,
          afterJson: { recountedAtPageRate: true, recost },
        },
        false,
      );
      return { recost, ...done };
    });
    await this.announce(cycleId, actorId, out);
    return { data: { legId, recost: out.recost } };
  }

  // ─── Arrivals ─────────────────────────────────────────────────────────

  /**
   * POST /shipping/legs/:id/arrivals — a batch from a handover reached Egypt,
   * counted product by product. The handover's departure lines grow by what
   * arrived and the delivery is the existing one (`deliverIn`), so it is
   * received into stock and verified exactly as any delivery.
   *
   * Refused: another leg's (or cycle's) handover; one marked all arrived; a
   * day before the handover or in the future; more of a product than still
   * waits in the UAE for this leg, or than had reached it by the handover
   * day; more pieces than the handover's count has left to bring.
   */
  async recordArrival(legId: string, input: ArrivalInput, actorId: string) {
    const lines = checkLines(input.lines);
    const day = deliveryDay(input.arrivedOn);
    const cycleId = await this.cycleOfLeg(legId);

    const out = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const { cycle, position } = await this.loaded(tx, cycleId);
      assertOpen(cycle);
      const leg = this.legFor(cycle, legId);
      if (!leg.usesHandovers) {
        throw badRequest(
          'LEG_NOT_IN_HANDOVERS',
          `${where(leg)} is not recorded in handovers; record its deliveries instead.`,
          { leg: where(leg) },
        );
      }
      const summary = this.summary(cycle, position, legId);
      const open = summary.handovers.filter((h) => h.open);
      let mine;
      if (input.handoverId) {
        if (!isUuid(input.handoverId)) throw notFound('handover');
        mine = summary.handovers.find((h) => h.id === input.handoverId);
        // Another leg's or another cycle's handover is no such handover here.
        if (!mine) throw notFound('handover');
      } else if (open.length === 1) {
        mine = open[0];
      } else {
        throw badRequest(
          'HANDOVER_REQUIRED',
          open.length === 0
            ? `Nothing is with the forwarder on ${where(leg)}: hand goods over first.`
            : `${open.length} handovers on ${where(leg)} are still open: say which this batch came from.`,
          { open: open.length, leg: where(leg) },
        );
      }
      if (!mine.open) {
        throw badRequest(
          'HANDOVER_ALL_ARRIVED',
          `Handover ${mine.number} was marked all arrived; undo that first.`,
          { handover: mine.number },
        );
      }
      if (day < mine.handedOverOn) {
        throw badRequest(
          'ARRIVAL_BEFORE_HANDOVER',
          `A batch on ${day} cannot have come from goods handed over on ${mine.handedOverOn}.`,
          { day, handedOverOn: mine.handedOverOn },
        );
      }
      const names = new Map(
        cycle.purchaseOrders.flatMap((po) =>
          po.items.map((i) => [i.id, i.product.name] as const),
        ),
      );
      const legPos = position.legs.find((l) => l.legId === legId)!;
      for (const line of lines) {
        // Another cycle's order line is no such line here (ownership).
        if (!names.has(line.purchaseOrderItemId)) {
          throw notFound('purchaseOrderItem');
        }
        const waiting = legPos.lines.find(
          (l) => l.purchaseOrderItemId === line.purchaseOrderItemId,
        )!.atOrigin;
        if (milli(line.qty) > milli(waiting)) {
          const name = names.get(line.purchaseOrderItemId)!;
          throw badRequest(
            'ARRIVAL_EXCEEDS_WAITING',
            `Only ${waiting} of ${name} are still in the UAE for this leg, so ${line.qty} cannot have arrived.`,
            { line: name, waiting, asked: Number(line.qty) },
          );
        }
      }
      const asked = lines.reduce((s, l) => s + milli(l.qty), 0);
      if (mine.toCome !== null && asked > milli(mine.toCome)) {
        throw badRequest(
          'ARRIVAL_EXCEEDS_HANDOVER',
          `Handover ${mine.number} was ${mine.pieces} pieces and ${mine.arrived} arrived from it, so ${units(asked)} more cannot have.`,
          {
            handover: mine.number,
            pieces: mine.pieces!,
            arrived: mine.arrived,
            toCome: mine.toCome,
            asked: units(asked),
          },
        );
      }
      // The handover carried what arrived from it: its lines grow, checked
      // by the departure rules as if it had left with them on its own day.
      const handover = leg.departures.find((d) => d.id === mine.id)!;
      const combined = this.addLines(handover.lines, lines);
      departureLines(
        cycle,
        position,
        legId,
        mine.handedOverOn,
        combined,
        mine.id,
      );
      await this.writeLines(tx, mine.id, combined);

      const delivery = await this.deliveries.deliverIn(
        tx,
        cycleId,
        legId,
        day,
        lines,
        actorId,
        input.note,
        mine.id,
      );
      const recost = await this.syncFreight(tx, cycleId, legId);
      const done = await this.finish(
        tx,
        cycleId,
        actorId,
        {
          action: 'CREATE',
          entityType: 'ShipmentDelivery',
          entityId: delivery.id,
          afterJson: { ...delivery, handoverId: mine.id, recost },
        },
        // An arrival proves the goods reached the leg's end (§1, L3).
        true,
      );
      return { delivery, ...done };
    });

    await this.announce(cycleId, actorId, out);
    return {
      data: out.delivery,
      cycleStatus: out.followed?.cycleStatus ?? null,
    };
  }

  /**
   * DELETE /shipping/arrivals/:id — an arrival recorded by mistake. Refused
   * once stock was received from it or the cycle's status rests on it
   * (DELIVERY_IN_USE, the delivery rule), or while its handover is marked
   * all arrived. Its goods go back to waiting in the UAE and the freight a
   * piece is worked out again.
   */
  async removeArrival(id: string, actorId: string) {
    if (!isUuid(id)) throw notFound('shipmentDelivery');
    const found = await this.prisma.shipmentDelivery.findUnique({
      where: { id },
      select: { departureId: true, leg: { select: { cycleId: true } } },
    });
    if (!found || !found.departureId) throw notFound('shipmentDelivery');
    const cycleId = found.leg.cycleId;

    const out = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const { cycle, position } = await this.loaded(tx, cycleId);
      assertOpen(cycle);
      const leg = cycle.shippingLegs.find((l) =>
        l.deliveries.some((d) => d.id === id),
      );
      if (!leg) throw notFound('shipmentDelivery');
      const delivery = leg.deliveries.find((d) => d.id === id)!;
      const mine = this.summary(cycle, position, leg.id).handovers.find(
        (h) => h.id === delivery.departureId,
      )!;
      if (!mine.open) {
        throw badRequest(
          'HANDOVER_ALL_ARRIVED',
          `Handover ${mine.number} was marked all arrived; undo that first.`,
          { handover: mine.number },
        );
      }
      const block = deliveryDeleteBlock(cycle, id);
      if (block) {
        throw badRequest('DELIVERY_IN_USE', block.english, { why: block.why });
      }
      const handover = leg.departures.find((d) => d.id === mine.id)!;
      const less = this.addLines(
        handover.lines,
        delivery.lines.map((l) => ({
          purchaseOrderItemId: l.purchaseOrderItemId,
          qty: -Number(l.qty),
        })),
      );
      await tx.shipmentDelivery.delete({ where: { id } });
      await this.writeLines(tx, mine.id, less);
      await this.syncFreight(tx, cycleId, leg.id);
      const done = await this.finish(
        tx,
        cycleId,
        actorId,
        {
          action: 'DELETE',
          entityType: 'ShipmentDelivery',
          entityId: id,
          beforeJson: { ...delivery, handoverId: mine.id },
        },
        false,
      );
      return done;
    });
    await this.announce(cycleId, actorId, out);
    return { data: { id, deleted: true } };
  }

  // ─── All arrived ──────────────────────────────────────────────────────

  /**
   * POST /shipping/handovers/:id/all-arrived — nothing more is coming from
   * this lot. When it had a count and fewer came, the rest are lost at full
   * landed unit cost (§2): `lost` says which products they were — exactly as
   * many as are missing, each from what still waits in the UAE. A handover
   * with no count loses nothing: nobody knows anything is missing.
   */
  async allArrived(
    id: string,
    input: { on?: string; lost?: ShipmentLineInput[]; reason?: string },
    actorId: string,
  ) {
    const lostLines =
      input.lost === undefined || input.lost.length === 0
        ? []
        : checkLines(input.lost);
    if (input.on) assertNotFuture(input.on, 'DELIVERY');
    const day = input.on ? businessDay(input.on) : businessToday();
    const cycleId = await this.cycleOfHandover(id);

    const out = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const { cycle, position } = await this.loaded(tx, cycleId);
      assertOpen(cycle);
      const { leg, handover } = this.handoverIn(cycle, id);
      const mine = this.summary(cycle, position, leg.id).handovers.find(
        (h) => h.id === id,
      )!;
      if (!mine.open) {
        throw badRequest(
          'HANDOVER_ALREADY_ALL_ARRIVED',
          `Handover ${mine.number} was already marked all arrived on ${mine.allArrivedOn}.`,
          { handover: mine.number, day: mine.allArrivedOn! },
        );
      }
      const last = mine.arrivals[mine.arrivals.length - 1]?.arrivedOn;
      const earliest =
        last && last > mine.handedOverOn ? last : mine.handedOverOn;
      if (day < earliest) {
        throw badRequest(
          'ALL_ARRIVED_TOO_EARLY',
          `Handover ${mine.number} cannot be all arrived on ${day}: it was handed over or last arrived on ${earliest}.`,
          { handover: mine.number, day, earliest },
        );
      }
      const missing = milli(mine.toCome ?? 0);
      const given = lostLines.reduce((s, l) => s + milli(l.qty), 0);
      if (missing === 0 && given > 0) {
        throw badRequest(
          'HANDOVER_NOTHING_MISSING',
          mine.pieces === null
            ? `Handover ${mine.number} has no piece count, so nothing can be known to be missing from it.`
            : `Everything handover ${mine.number} held has arrived; nothing is missing.`,
          { handover: mine.number },
        );
      }
      if (given !== missing) {
        throw badRequest(
          'HANDOVER_LOST_MUST_MATCH',
          `Handover ${mine.number} held ${mine.pieces} pieces and ${mine.arrived} arrived: say which ${units(missing)} never came (${units(given)} said).`,
          {
            handover: mine.number,
            missing: units(missing),
            given: units(given),
          },
        );
      }
      if (lostLines.length > 0) {
        const names = new Set(
          cycle.purchaseOrders.flatMap((po) => po.items.map((i) => i.id)),
        );
        for (const l of lostLines) {
          if (!names.has(l.purchaseOrderItemId)) {
            throw notFound('purchaseOrderItem');
          }
        }
        // The missing pieces were handed over with the rest: they left on
        // the handover's day, from what waited in the UAE then.
        const combined = this.addLines(handover.lines, lostLines);
        departureLines(
          cycle,
          position,
          leg.id,
          mine.handedOverOn,
          combined,
          id,
        );
        await this.writeLines(tx, id, combined);
        await this.deliveries.lossIn(
          tx,
          cycleId,
          leg.id,
          lostLines,
          input.reason?.trim() ||
            `Never arrived from handover ${mine.number} (${mine.handedOverOn})`,
          actorId,
          id,
        );
      }
      await tx.shipmentDeparture.update({
        where: { id },
        data: { allArrivedOn: asDate(day), allArrivedBy: actorId },
      });
      const recost = await this.syncFreight(tx, cycleId, leg.id);
      return this.finish(
        tx,
        cycleId,
        actorId,
        {
          action: 'UPDATE',
          entityType: 'ShipmentHandover',
          entityId: id,
          afterJson: { allArrivedOn: day, lost: lostLines, recost },
        },
        false,
      );
    });
    await this.announce(cycleId, actorId, out);
    return { data: { id, allArrivedOn: day } };
  }

  /**
   * DELETE /shipping/handovers/:id/all-arrived — more is coming after all.
   * Its missing pieces come off the losses and wait in the UAE again. Refused
   * while a refund stands on one of them (LOSS_REFUNDED, as taking a loss
   * back is).
   */
  async undoAllArrived(id: string, actorId: string) {
    const cycleId = await this.cycleOfHandover(id);
    const out = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const { cycle, position } = await this.loaded(tx, cycleId);
      assertOpen(cycle);
      const { leg, handover } = this.handoverIn(cycle, id);
      const mine = this.summary(cycle, position, leg.id).handovers.find(
        (h) => h.id === id,
      )!;
      if (mine.open) {
        throw badRequest(
          'HANDOVER_NOT_ALL_ARRIVED',
          `Handover ${mine.number} is not marked all arrived.`,
          { handover: mine.number },
        );
      }
      const losses = leg.losses.filter((x) => x.departureId === id);
      for (const loss of losses) await assertLossNotRefunded(tx, loss.id);
      if (losses.length > 0) {
        // Refunds undone earlier still name the loss; they let go of it, as
        // taking a loss back does.
        await tx.supplierRefund.updateMany({
          where: {
            shipmentLossId: { in: losses.map((x) => x.id) },
            reversedAt: { not: null },
          },
          data: { shipmentLossId: null },
        });
        await tx.shipmentLoss.deleteMany({
          where: { id: { in: losses.map((x) => x.id) } },
        });
        const less = this.addLines(
          handover.lines,
          losses.map((x) => ({
            purchaseOrderItemId: x.purchaseOrderItemId,
            qty: -Number(x.qty),
          })),
        );
        await this.writeLines(tx, id, less);
      }
      await tx.shipmentDeparture.update({
        where: { id },
        data: { allArrivedOn: null, allArrivedBy: null },
      });
      await this.syncFreight(tx, cycleId, leg.id);
      return this.finish(
        tx,
        cycleId,
        actorId,
        {
          action: 'UPDATE',
          entityType: 'ShipmentHandover',
          entityId: id,
          beforeJson: { allArrivedOn: mine.allArrivedOn, losses },
          afterJson: { allArrivedOn: null },
        },
        false,
      );
    });
    await this.announce(cycleId, actorId, out);
    return { data: { id, allArrivedOn: null } };
  }

  // ─── A handover's lines ───────────────────────────────────────────────

  /** A handover's lines with `more` added (or taken off, negative), zeros dropped. */
  private addLines(
    current: { purchaseOrderItemId: string; qty: Prisma.Decimal.Value }[],
    more: ShipmentLineInput[],
  ): ShipmentLineInput[] {
    const by = new Map<string, number>();
    for (const l of current) {
      by.set(
        l.purchaseOrderItemId,
        (by.get(l.purchaseOrderItemId) ?? 0) + milli(l.qty),
      );
    }
    for (const l of more) {
      by.set(
        l.purchaseOrderItemId,
        (by.get(l.purchaseOrderItemId) ?? 0) + milli(l.qty),
      );
    }
    return [...by.entries()]
      .filter(([, q]) => q > 0)
      .map(([purchaseOrderItemId, q]) => ({
        purchaseOrderItemId,
        qty: units(q),
      }));
  }

  /** Replace a handover's lines with these. */
  private async writeLines(
    tx: Tx,
    departureId: string,
    lines: ShipmentLineInput[],
  ) {
    await tx.shipmentDepartureLine.deleteMany({ where: { departureId } });
    if (lines.length > 0) {
      await tx.shipmentDepartureLine.createMany({
        data: lines.map((l) => ({
          departureId,
          purchaseOrderItemId: l.purchaseOrderItemId,
          qty: l.qty,
        })),
      });
    }
  }
}
