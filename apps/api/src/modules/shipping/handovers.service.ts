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
import type { ShipmentPosition } from '../../common/shipment-position';
import { handoverPiecesCap, legHandovers } from '../../common/leg-handovers';
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
 * paid so far spread over the pieces it covers, re-costing the cycle through
 * the leg re-cost (§2, 2026-10-17) — the same function a leg edit uses — or
 * refusing with its LEG_COST_LOCKED_* code. Nothing is ever booked as an
 * expense instead.
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
  freightAmount: number | string;
  freightCurrency?: string;
  freightRateToEgp?: number | string;
  pieces?: number | null;
  paidByUserId?: string | null;
  note?: string;
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
   * from the Exchange rates page (§22), as a leg's cost is.
   */
  private async freight(db: Tx, input: HandoverInput): Promise<Freight> {
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
      rate = D(known.rateToEgp);
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

  /** Who paid: the business (null), or an active core partner — never anyone else. */
  private async payer(db: Tx, value: unknown, freight: Freight) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !isUuid(value)) {
      throw badRequest(
        'LEDGER_PAYER_NOT_PARTNER',
        'An expense can be paid by the business or by one of the core partners; that is neither.',
      );
    }
    const partner = await expensePayer(db, value);
    if (freight.amount.isZero()) {
      throw badRequest(
        'HANDOVER_PAID_BY_NOTHING_PAID',
        `No freight was paid on this handover, so ${partner.name} cannot have paid it.`,
        { partner: partner.name },
      );
    }
    return partner;
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

  // ─── The leg's freight ────────────────────────────────────────────────

  /**
   * Set the leg's cost from its handovers (§2, 2026-11-20). In the caller's
   * transaction, after its writes. A change re-costs the cycle through the
   * leg re-cost — or is refused with its LEG_COST_LOCKED_* code, which rolls
   * the whole write back: nothing is booked as an expense instead.
   */
  private async syncFreight(tx: Tx, cycleId: string, legId: string) {
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
      const partner = await this.payer(tx, input.paidByUserId, freight);
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
          freightRateToEgp: freight.rate,
          freightAmountEgp: freight.amountEgp,
          pieces,
          providerId: forwarder?.id ?? null,
          paidByUserId: partner?.id ?? null,
        },
      });
      if (partner) {
        await recordPartnerFreightIn(tx, {
          handoverId: handover.id,
          cycleId,
          partner,
          currency: freight.currency,
          amount: freight.amount,
          rate: freight.rate,
          amountEgp: freight.amountEgp,
          day,
          actorId,
        });
      }
      const recost = await this.syncFreight(tx, cycleId, legId);
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
   * freight, piece count or who paid. The freight may be corrected at any
   * time it can still re-cost (a late bill); the day and the count only while
   * it is open, never past what has already arrived from it. A partner's
   * debt for it is replaced only while nothing of it was repaid.
   */
  async update(id: string, input: HandoverInput, actorId: string) {
    const cycleId = await this.cycleOfHandover(id);
    const out = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const { cycle, position } = await this.loaded(tx, cycleId);
      assertOpen(cycle);
      const { leg, handover: h } = this.handoverIn(cycle, id);
      const before = await tx.shipmentDeparture.findUniqueOrThrow({
        where: { id },
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
      if (day !== mine.handedOverOn) {
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

      const freight = await this.freight(tx, {
        freightAmount:
          input.freightAmount ?? (before.freightAmount?.toString() as string),
        freightCurrency:
          input.freightCurrency ?? before.freightCurrency ?? 'EGP',
        freightRateToEgp:
          input.freightRateToEgp ??
          (input.freightCurrency &&
          input.freightCurrency !== before.freightCurrency
            ? undefined
            : before.freightRateToEgp?.toString()),
        handedOverOn: day,
      });
      const paidBy =
        input.paidByUserId === undefined
          ? before.paidByUserId
          : input.paidByUserId;
      const partner = await this.payer(tx, paidBy, freight);
      const forwarder =
        input.providerId === undefined
          ? { id: before.providerId }
          : await this.provider(tx, input.providerId);

      // His debt follows the freight, its day and who paid.
      const debtMoved =
        (before.paidByUserId ?? null) !== (partner?.id ?? null) ||
        !D(before.freightAmount).eq(freight.amount) ||
        before.freightCurrency !== freight.currency ||
        !D(before.freightRateToEgp).eq(freight.rate) ||
        day !== mine.handedOverOn;
      if (debtMoved) {
        await removePartnerFreightIn(
          tx,
          id,
          `Handover of ${mine.handedOverOn} corrected`,
          actorId,
        );
      }
      const updated = await tx.shipmentDeparture.update({
        where: { id },
        data: {
          departedOn: asDate(day),
          note:
            input.note === undefined ? before.note : input.note.trim() || null,
          freightAmount: freight.amount,
          freightCurrency: freight.currency,
          freightRateToEgp: freight.rate,
          freightAmountEgp: freight.amountEgp,
          pieces,
          providerId: forwarder?.id ?? null,
          paidByUserId: partner?.id ?? null,
        },
      });
      if (debtMoved && partner) {
        await recordPartnerFreightIn(tx, {
          handoverId: id,
          cycleId,
          partner,
          currency: freight.currency,
          amount: freight.amount,
          rate: freight.rate,
          amountEgp: freight.amountEgp,
          day,
          actorId,
        });
      }
      const recost = await this.syncFreight(tx, cycleId, leg.id);
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
   * only departure (DEPARTURE_IN_USE, as any departure), or when the partner
   * who paid it has been repaid on it.
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
      await removePartnerFreightIn(
        tx,
        id,
        `Handover of ${mine.handedOverOn} undone`,
        actorId,
      );
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
