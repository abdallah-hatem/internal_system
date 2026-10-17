import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertNotFuture, businessDay } from '../../common/dates';
import { expectedLegs } from '../../common/cycle-routes';
import { assertUuid, isUuid } from '../../common/uuid';
import {
  assertInScope,
  cycleIdWhere,
  cyclesVisibleTo,
  type ScopeViewer,
} from '../../common/investor-scope';
import {
  loadShipment,
  lockCycle,
  syncLegStatuses,
} from '../../common/shipment-load';
import {
  assertOpen,
  checkLines,
  DeliveriesService,
} from './deliveries.service';
import { AuditService } from '../audit/audit.service';
import {
  PaginationDto,
  pageSize,
  cursorPage,
} from '../../common/dto/pagination.dto';
import { CostingService } from '../costing/costing.service';
import { planRecost, recost, refuseCostChange } from '../costing/leg-recost';
import { Prisma, ShippingCostBasis } from '@prisma/client';

import { badRequest, notFound } from '../../common/api-error';
/**
 * A leg's status is what its dates say, not a field anyone sets.
 *
 * The shipment departed on a date, and arrived on a date. Those are the facts
 * being recorded; "in transit" and "arrived" are just readings of them.
 * Keeping status separately meant it could disagree with the dates, and it
 * did: nothing wrote to it, so every leg read PENDING for ever while goods
 * were received and sold.
 */
/**
 * Dates a shipment could actually have.
 *
 * Arriving before departing, or arriving without ever having left, are not
 * things that happen — and either would make the derived status a lie.
 */
export function assertLegDates(
  departedOn?: Date | string | null,
  arrivedOn?: Date | string | null,
) {
  if (arrivedOn && !departedOn) {
    throw badRequest(
      'ARRIVAL_WITHOUT_DEPARTURE',
      'A shipment cannot arrive without a departure date. Record when it left first.',
    );
  }
  if (departedOn && arrivedOn && new Date(arrivedOn) < new Date(departedOn)) {
    throw badRequest(
      'ARRIVAL_BEFORE_DEPARTURE',
      'A shipment cannot arrive before it departed.',
    );
  }
}

export function legStatusFromDates(
  departedOn?: Date | string | null,
  arrivedOn?: Date | string | null,
): 'PENDING' | 'IN_TRANSIT' | 'ARRIVED' {
  if (arrivedOn) return 'ARRIVED';
  if (departedOn) return 'IN_TRANSIT';
  return 'PENDING';
}

/** What `createLeg` accepts — the DTO's fields, with the route's places optional. */
export interface NewLeg {
  sequence: number;
  origin?: string;
  destination?: string;
  provider?: string;
  providerId?: string;
  trackingRef?: string;
  departedOn?: string;
  /**
   * What left on `departedOn`, per order line (L8). Left out: everything
   * waiting at the leg's origin that could have left by that day.
   */
  departureLines?: { purchaseOrderItemId: string; qty: number }[];
  arrivedOn?: string;
  costBasis?: ShippingCostBasis;
  ratePerUnit?: number;
  chargeablePieces?: number;
  chargeableWeightKg?: number;
  currency?: string;
  fxRateToEgp?: number;
  amount?: number;
}

@Injectable()
export class ShippingService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private costing: CostingService,
    private deliveries: DeliveriesService,
  ) {}

  async findAll(
    pagination: PaginationDto & { cycleId?: string },
    viewer: ScopeViewer = 'internal',
  ) {
    const { cursor, limit: rawLimit = 20, cycleId } = pagination;
    const limit = pageSize(rawLimit);
    const where: Prisma.ShippingLegWhereInput = {};
    // An investor: only their cycles' legs (R1).
    const cycleFilter = cycleIdWhere(
      await cyclesVisibleTo(viewer, this.prisma),
      cycleId,
    );
    if (cycleFilter) where.cycleId = cycleFilter;

    const items = await this.prisma.shippingLeg.findMany({
      where,
      ...cursorPage(cursor, limit),
      // Newest cycle first, its legs in route order. Ordering by cycleId (a
      // random uuid) put a new cycle's legs anywhere, so whichever legs fell
      // past the page were arbitrary; now a full page drops the oldest.
      orderBy: [
        { cycle: { createdAt: 'desc' } },
        { cycleId: 'asc' },
        { sequence: 'asc' },
        { id: 'asc' },
      ],
      include: { cycle: true },
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    return {
      data,
      meta: {
        nextCursor: hasMore ? data[data.length - 1].id : null,
        limit,
      },
    };
  }

  async findByCycle(cycleId: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(cycleId)) throw notFound('cycle');
    assertInScope(await cyclesVisibleTo(viewer, this.prisma), cycleId);
    const legs = await this.prisma.shippingLeg.findMany({
      where: { cycleId },
      orderBy: { sequence: 'asc' },
    });
    return { data: legs };
  }

  /**
   * Every check `createLeg` makes, and the leg it would write, with nothing
   * written. The assistant previews a leg from this and `createLeg` saves
   * exactly what it returns, so the preview's cost and status are the saved ones.
   *
   * Origin and destination default to the route's usual places for that leg
   * (`common/cycle-routes.ts`) when the caller leaves them out.
   */
  async planLeg(cycleId: string, data: NewLeg) {
    assertUuid(cycleId, 'cycleId');
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
    });
    if (!cycle) throw notFound('cycle');

    // A cancelled cycle shipped nothing and a closed one has been settled on
    // the costs it had; a leg added to either would be freight nobody paid, or
    // freight the settlement never saw.
    if (cycle.status === 'CANCELLED' || cycle.status === 'CLOSED') {
      throw badRequest(
        'CYCLE_FINAL_NO_LEGS',
        `Cycle ${cycle.code} is ${cycle.status}, so no shipping leg can be added to it.`,
        { cycle: cycle.code, status: cycle.status },
      );
    }

    const route = expectedLegs(cycle.originType).find(
      (l) => l.sequence === data.sequence,
    );
    const origin = data.origin ?? route?.origin ?? '';
    const destination = data.destination ?? route?.destination ?? '';

    // Validate: UAE_DIRECT cycles only allow sequence 1 (UAE→Egypt)
    if (cycle.originType === 'UAE_DIRECT' && data.sequence !== 1) {
      throw badRequest(
        'UAE_DIRECT_ONE_LEG',
        'UAE_DIRECT cycles only allow a single shipping leg (sequence 1: UAE to Egypt)',
      );
    }

    // Validate destination for UAE_DIRECT
    if (cycle.originType === 'UAE_DIRECT' && data.sequence === 1) {
      if (
        !origin.toUpperCase().includes('UAE') ||
        !destination.toUpperCase().includes('EGYPT')
      ) {
        throw badRequest(
          'UAE_DIRECT_LEG_ROUTE',
          'UAE_DIRECT cycle shipping leg must go from UAE to Egypt',
        );
      }
    }

    // China cycles ship in two legs: 1 = China->UAE (merchant), 2 = UAE->Egypt
    // (shipping company). Anything beyond sequence 2 is not a real route.
    if (cycle.originType === 'CHINA' && !route) {
      throw badRequest(
        'CHINA_TWO_LEGS',
        'CHINA cycles have at most two shipping legs (sequence 1: China to UAE, sequence 2: UAE to Egypt)',
      );
    }

    // Check sequence uniqueness within cycle
    const existingLeg = await this.prisma.shippingLeg.findUnique({
      where: { cycleId_sequence: { cycleId, sequence: data.sequence } },
    });
    if (existingLeg) {
      throw badRequest(
        'LEG_SEQUENCE_TAKEN',
        `Shipping leg with sequence ${data.sequence} already exists for this cycle`,
        { sequence: data.sequence },
      );
    }

    const costFields = this.buildCostFields(data);

    // The dates were accepted by the DTO and then dropped on the floor here,
    // so a leg created with a departure date came back without one.
    assertLegDates(data.departedOn, data.arrivedOn);
    // Editing a leg refused a date in the future and creating one did not, so
    // a leg could be born "arrived" next week and walk the cycle to Egypt.
    assertNotFuture(data.departedOn, 'DEPARTURE');
    assertNotFuture(data.arrivedOn, 'ARRIVAL');

    return {
      cycle,
      leg: {
        cycleId,
        sequence: data.sequence,
        origin,
        destination,
        provider: data.provider,
        providerId: data.providerId,
        trackingRef: data.trackingRef,
        departedOn: data.departedOn ? new Date(data.departedOn) : undefined,
        arrivedOn: data.arrivedOn ? new Date(data.arrivedOn) : undefined,
        status: legStatusFromDates(data.departedOn, data.arrivedOn),
        ...costFields,
      },
    };
  }

  /**
   * Create a leg. A departure date given with it records the leg's first
   * departure (L8): of `departureLines`, or of everything waiting at its
   * origin. An arrival date means "everything that left arrived that day": it
   * is recorded as one delivery of what is on the way (§1, 2026-10-10) — the
   * fixtures, the old wizard and the assistant still send it this way.
   */
  async createLeg(cycleId: string, data: NewLeg, actorId: string) {
    const plan = await this.planLeg(cycleId, data);
    if (data.departureLines !== undefined && !data.departedOn) {
      throw badRequest(
        'VALIDATION_FAILED',
        'Departure lines need a departure date.',
        { fields: 'departedOn' },
      );
    }
    const departureLines =
      data.departureLines === undefined
        ? undefined
        : checkLines(data.departureLines);
    // Status, departure and arrival are readings of the departures and
    // deliveries, written by `syncLegStatuses`, never taken from the plan.
    const { arrivedOn: _arrivedOn, departedOn: _departedOn, ...row } = plan.leg;

    const { leg, changed, followed } = await this.prisma.$transaction(
      async (tx) => {
        await lockCycle(tx, cycleId);
        const created = await tx.shippingLeg.create({
          data: { ...row, departedOn: null, status: 'PENDING' },
        });
        if (data.departedOn) {
          await this.deliveries.departIn(
            tx,
            cycleId,
            created.id,
            businessDay(data.departedOn),
            departureLines,
            actorId,
          );
        }
        if (data.arrivedOn) {
          await this.deliveries.deliverRemainderIn(
            tx,
            cycleId,
            created.id,
            businessDay(data.arrivedOn),
            actorId,
          );
        }
        const changed = await syncLegStatuses(tx, cycleId);
        // A leg born departed, or delivered, moves the cycle on (§1, L3).
        const followed =
          data.departedOn || data.arrivedOn
            ? await this.deliveries.followShipment(tx, cycleId)
            : null;
        const leg = await tx.shippingLeg.findUniqueOrThrow({
          where: { id: created.id },
        });
        await this.audit.log(
          {
            actorUserId: actorId,
            action: 'CREATE',
            entityType: 'ShippingLeg',
            entityId: leg.id,
            afterJson: leg,
          },
          tx,
        );
        return { leg, changed, followed };
      },
    );

    if (followed) await this.deliveries.announceFollow(followed, actorId);
    await this.deliveries.notifyArrivals(cycleId, changed);
    return { data: leg, cycleStatus: followed?.cycleStatus ?? null };
  }

  /**
   * Edit a leg.
   *
   * - `status` is ignored: it is a reading, never a field anyone sets (§1).
   * - `arrivedOn` is kept for the old form: a delivery of everything still on
   *   the way, on that day. With nothing on the way it writes nothing, and a
   *   null is ignored — an arrival is taken back by deleting its delivery.
   * - Moving the departure after a delivery already recorded is refused.
   * - A leg's cost moves freely until anything of the cycle is received or
   *   lost. After that a change re-costs the whole cycle — batches, purchase
   *   rows, sale allocations, returns — in this transaction, unless a
   *   settlement, a loss, a transfer, a hand-typed batch cost or unmatched
   *   purchase rows stand in the way, each refused with its own code
   *   (§2, 2026-10-17; `costing/leg-recost.ts`). A late charge on a cycle
   *   that cannot be re-costed is a ledger expense on it instead.
   */
  async updateLeg(
    id: string,
    data: {
      origin?: string;
      destination?: string;
      status?: string;
      departedOn?: string | null;
      departureLines?: { purchaseOrderItemId: string; qty: number }[];
      arrivedOn?: string | null;
      amount?: number;
      provider?: string;
      providerId?: string;
      trackingRef?: string;
      costBasis?: ShippingCostBasis;
      ratePerUnit?: number;
      chargeablePieces?: number;
      chargeableWeightKg?: number;
      currency?: string;
      fxRateToEgp?: number;
    },
    actorId: string,
  ) {
    if (!isUuid(id)) throw notFound('shippingLeg');
    const existing = await this.prisma.shippingLeg.findUnique({
      where: { id },
    });
    if (!existing) throw notFound('shippingLeg');

    // Recompute the EGP amount from the merged (existing + incoming) state so a
    // partial update of just the rate or the piece count stays consistent.
    const merged = {
      costBasis: data.costBasis ?? existing.costBasis,
      ratePerUnit: data.ratePerUnit ?? existing.ratePerUnit,
      chargeablePieces: data.chargeablePieces ?? existing.chargeablePieces,
      chargeableWeightKg:
        data.chargeableWeightKg ?? existing.chargeableWeightKg,
      amount: data.amount ?? existing.amount,
      fxRateToEgp: data.fxRateToEgp ?? existing.fxRateToEgp,
      // Merged too: an edit that left the currency out reset a USD leg to EGP.
      currency: data.currency ?? existing.currency,
    };
    const costFields = this.buildCostFields(merged);

    // Merged, because a partial update that sets only the arrival date still
    // has to be judged against the departure date already on the leg.
    const departedOn = data.departedOn ?? existing.departedOn;
    const arrivedOn = data.arrivedOn ?? null;
    assertLegDates(departedOn, arrivedOn);
    assertNotFuture(data.departedOn, 'DEPARTURE');
    assertNotFuture(data.arrivedOn, 'ARRIVAL');

    const { updated, changed, followed } = await this.prisma.$transaction(
      async (tx) => {
        await lockCycle(tx, existing.cycleId);
        // A departure set or moved, or an arrival delivered (§1, L3). The edit
        // form re-sends an unchanged departure on every save; that is no news.
        let shipmentNews = false;
        const loaded = await loadShipment(tx, existing.cycleId);
        if (!loaded) throw notFound('cycle');

        const costMoved =
          costFields.costBasis !== existing.costBasis ||
          !costFields.amountEgp.equals(existing.amountEgp ?? 0);
        // Once goods of the cycle were received, a cost change re-costs every
        // unit of it — or is refused for the reason it cannot (§2, 2026-10-17).
        const recostPlan = costMoved
          ? await planRecost(tx, this.costing, loaded.cycle, loaded.position)
          : null;
        if (recostPlan && !recostPlan.state.editable) {
          refuseCostChange(
            recostPlan.state.reason!,
            recostPlan.state.params,
            `${existing.origin} → ${existing.destination}`,
          );
        }

        const legRow = loaded.cycle.shippingLegs.find((l) => l.id === id)!;
        let departure: { day: string; replaces: string | null } | null = null;
        if (data.departedOn) {
          const departed = businessDay(data.departedOn);
          // No departure is recorded on a cycle cancelled, being settled or
          // closed (§1). Only a change counts: the Shipments page's edit form
          // sends the leg's departure back with every save, unchanged.
          const before =
            loaded.position.legs.find((l) => l.legId === id)?.departedOn ??
            null;
          if (departed !== before) {
            assertOpen(loaded.cycle);
            shipmentNews = true;
            // L8: a leg with no departure gets its first; a leg with one
            // has that one moved to the new day (checked again from
            // scratch); a leg with several is corrected on the cycle page,
            // by undoing a departure and recording it again.
            if (legRow.departures.length > 1) {
              throw badRequest(
                'LEG_HAS_SEVERAL_DEPARTURES',
                `${existing.origin} → ${existing.destination} left in ${legRow.departures.length} departures, so its departure date cannot be changed here. Undo the departure that is wrong on the cycle's page and record it again.`,
                {
                  leg: `${existing.origin} → ${existing.destination}`,
                  departures: legRow.departures.length,
                },
              );
            }
            departure = {
              day: departed,
              replaces: legRow.departures[0]?.id ?? null,
            };
          }
          const earliest = (legRow?.deliveries ?? [])
            .map((d) => businessDay(d.arrivedOn))
            .sort()[0];
          if (earliest && earliest < departed) {
            throw badRequest(
              'DELIVERY_BEFORE_DEPARTURE',
              `A delivery on ${earliest} is before ${existing.origin} → ${existing.destination} departed on ${departed}.`,
              {
                day: earliest,
                departedOn: departed,
                leg: `${existing.origin} → ${existing.destination}`,
              },
            );
          }
        }

        await tx.shippingLeg.update({
          where: { id },
          data: {
            origin: data.origin,
            destination: data.destination,
            provider: data.provider,
            providerId: data.providerId,
            trackingRef: data.trackingRef,
            ...costFields,
          },
        });
        // Every batch, purchase row, sale and return of the cycle, at the
        // cost the legs give now — inside this transaction, under the lock.
        const recosted =
          recostPlan?.state.recosts === true
            ? await recost(tx, this.costing, existing.cycleId, recostPlan)
            : [];

        if (departure?.replaces) {
          await this.deliveries.moveDepartureIn(
            tx,
            existing.cycleId,
            id,
            departure.replaces,
            departure.day,
          );
        } else if (departure) {
          await this.deliveries.departIn(
            tx,
            existing.cycleId,
            id,
            departure.day,
            data.departureLines === undefined
              ? undefined
              : checkLines(data.departureLines),
            actorId,
          );
        }

        if (data.arrivedOn) {
          const delivered = await this.deliveries.deliverRemainderIn(
            tx,
            existing.cycleId,
            id,
            businessDay(data.arrivedOn),
            actorId,
          );
          if (delivered) shipmentNews = true;
        }

        const changed = await syncLegStatuses(tx, existing.cycleId);
        const followed = shipmentNews
          ? await this.deliveries.followShipment(tx, existing.cycleId)
          : null;
        const updated = await tx.shippingLeg.findUniqueOrThrow({
          where: { id },
        });
        await this.audit.log(
          {
            actorUserId: actorId,
            action: 'UPDATE',
            entityType: 'ShippingLeg',
            entityId: id,
            beforeJson: existing,
            afterJson:
              recosted.length > 0
                ? {
                    ...updated,
                    recost: {
                      oldAmountEgp: existing.amountEgp?.toFixed(2) ?? null,
                      newAmountEgp: updated.amountEgp?.toFixed(2) ?? null,
                      batches: recosted,
                    },
                  }
                : updated,
          },
          tx,
        );
        return { updated, changed, followed };
      },
    );

    if (followed) await this.deliveries.announceFollow(followed, actorId);
    await this.deliveries.notifyArrivals(existing.cycleId, changed);
    return { data: updated, cycleStatus: followed?.cycleStatus ?? null };
  }

  /**
   * Normalise the costing inputs for a leg and derive its EGP amount.
   *
   * Shipping is quoted per piece most of the time, occasionally by weight, and
   * sometimes as a single agreed figure (the UAE->Egypt combined payment that
   * covers service, customs and handling).
   */
  private buildCostFields(data: {
    costBasis?: ShippingCostBasis;
    ratePerUnit?: number | Prisma.Decimal | null;
    chargeablePieces?: number | Prisma.Decimal | null;
    chargeableWeightKg?: number | Prisma.Decimal | null;
    currency?: string;
    fxRateToEgp?: number | Prisma.Decimal | null;
    amount?: number | Prisma.Decimal | null;
  }) {
    const basis = data.costBasis ?? 'FLAT';
    const dec = (v: number | Prisma.Decimal | null | undefined) =>
      v === null || v === undefined ? null : new Prisma.Decimal(v);

    const ratePerUnit = dec(data.ratePerUnit);
    const chargeablePieces = dec(data.chargeablePieces);
    const chargeableWeightKg = dec(data.chargeableWeightKg);
    const fxRateToEgp = dec(data.fxRateToEgp) ?? new Prisma.Decimal(1);

    if (basis === 'PER_PIECE' && (!ratePerUnit || !chargeablePieces)) {
      throw badRequest(
        'PER_PIECE_FIELDS_REQUIRED',
        'PER_PIECE shipping requires both ratePerUnit and chargeablePieces',
      );
    }
    if (basis === 'PER_WEIGHT' && (!ratePerUnit || !chargeableWeightKg)) {
      throw badRequest(
        'PER_WEIGHT_FIELDS_REQUIRED',
        'PER_WEIGHT shipping requires both ratePerUnit and chargeableWeightKg',
      );
    }

    // For rate-based legs the native amount is derived, not typed in.
    let amount = dec(data.amount);
    if (basis === 'PER_PIECE') {
      amount = ratePerUnit!.mul(chargeablePieces!);
    } else if (basis === 'PER_WEIGHT') {
      amount = ratePerUnit!.mul(chargeableWeightKg!);
    }

    const amountEgp = this.costing.computeLegAmountEgp({
      costBasis: basis,
      ratePerUnit,
      chargeablePieces,
      chargeableWeightKg,
      amount,
      fxRateToEgp,
    });

    return {
      costBasis: basis,
      ratePerUnit,
      chargeablePieces,
      chargeableWeightKg,
      currency: data.currency ?? 'EGP',
      fxRateToEgp,
      amount: amount ? amount.toDecimalPlaces(2) : null,
      amountEgp,
    };
  }
}
