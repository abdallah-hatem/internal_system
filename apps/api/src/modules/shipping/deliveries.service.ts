import { Injectable } from '@nestjs/common';
import type { Prisma, ShipmentLoss } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CostingService, lineEventCost } from '../costing/costing.service';
import { badRequest, notFound } from '../../common/api-error';
import { assertNotFuture, businessDay } from '../../common/dates';
import { isUuid } from '../../common/uuid';
import {
  legsThatMustHaveDelivered,
  loadShipment,
  lockCycle,
  positionOf,
  syncLegStatuses,
  type LoadedShipment,
} from '../../common/shipment-load';

/**
 * Deliveries and losses on a shipping leg (BUSINESS_LOGIC §1, §2, §9 —
 * 2026-10-10).
 *
 * Goods leave in one shipment and arrive in pieces, weeks apart. A delivery
 * records one of those pieces; a loss records goods a partner has decided are
 * not coming. Both move units out of "on the way", and both are checked
 * against `shipmentPosition` — never against a sum worked out here (rule 11).
 *
 * Every write takes the cycle's row lock first (`lockCycle`) and only then
 * reads the position it checks against, so two writes sent at once cannot
 * both spend the same units on the way. After every write the leg's stored
 * `status` and `arrivedOn` are re-derived (`syncLegStatuses`).
 */

type Tx = Prisma.TransactionClient;

export interface ShipmentLineInput {
  purchaseOrderItemId: string;
  qty: number;
}

/** Quantities compared in whole thousandths, as `shipmentPosition` sums them. */
const milli = (q: number | string | { toString(): string }) =>
  Math.round(Number(q.toString()) * 1000);

/** A cycle being settled, or settled, is frozen (§1, spec amendment 4). */
const SETTLING = ['SETTLEMENT', 'CLOSED'];

const where = (leg: { origin: string; destination: string }) =>
  `${leg.origin} → ${leg.destination}`;

/**
 * The shape every delivery and loss has to have, checked before anything is
 * read: at least one line, each order line once, and every quantity above
 * zero. These are the service's checks, not only the DTO's — the assistant
 * calls this service too (CLAUDE.md rule 3).
 */
export function checkLines(
  lines: ShipmentLineInput[] | undefined,
): ShipmentLineInput[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw badRequest(
      'VALIDATION_FAILED',
      'Name at least one product and how many.',
      {
        fields: 'lines',
      },
    );
  }
  const seen = new Set<string>();
  for (const line of lines) {
    if (!isUuid(line.purchaseOrderItemId)) {
      throw notFound('purchaseOrderItem');
    }
    if (seen.has(line.purchaseOrderItemId)) {
      throw badRequest(
        'VALIDATION_FAILED',
        'The same product appears twice. Put its whole quantity on one line.',
        { fields: 'lines.purchaseOrderItemId' },
      );
    }
    seen.add(line.purchaseOrderItemId);
    const qty = Number(line.qty);
    if (!Number.isFinite(qty) || milli(qty) <= 0) {
      throw badRequest(
        'QTY_NOT_POSITIVE',
        'A quantity must be greater than zero.',
      );
    }
  }
  return lines;
}

/** The arrival day of a delivery: a real date, in Cairo, not in the future. */
export function deliveryDay(value: string | undefined): string {
  if (!value || Number.isNaN(new Date(value).getTime())) {
    throw badRequest('VALIDATION_FAILED', 'arrivedOn must be a date.', {
      fields: 'arrivedOn',
    });
  }
  assertNotFuture(value, 'A delivery date');
  return businessDay(value);
}

/** Refuse anything on a cycle that is cancelled, being settled or closed. */
function assertOpen(cycle: { code: string; status: string }) {
  if (cycle.status === 'CANCELLED') {
    throw badRequest(
      'CYCLE_CLOSED',
      `Cycle ${cycle.code} was cancelled, so nothing can be recorded on its shipment.`,
      { cycle: cycle.code, status: cycle.status },
    );
  }
  if (SETTLING.includes(cycle.status)) {
    throw badRequest(
      'CYCLE_SETTLING',
      `Cycle ${cycle.code} is ${cycle.status}. Nothing is recorded on a cycle being settled; reverse the settlement first.`,
      { cycle: cycle.code, status: cycle.status },
    );
  }
}

/**
 * A refunded loss cannot be taken back (§1, §6): the goods turning up after
 * being paid for would be counted twice. Read under the cycle's lock, which a
 * loss refund also takes, so a refund and a take-back sent at once cannot
 * both succeed. The foreign key (RESTRICT) refuses it too.
 */
async function assertLossNotRefunded(
  tx: Pick<Tx, 'supplierRefund'>,
  lossId: string,
) {
  const refunds = await tx.supplierRefund.count({
    where: { shipmentLossId: lossId },
  });
  if (refunds > 0) {
    throw badRequest(
      'LOSS_REFUNDED',
      `This loss has been refunded (${refunds} refund${refunds === 1 ? '' : 's'}), so it cannot be taken back: the goods would be counted twice.`,
      { refunds },
    );
  }
}

/** The cycle's order lines by id, with a name to put in a refusal. */
function orderLines(cycle: LoadedShipment) {
  return new Map(
    cycle.purchaseOrders.flatMap((po) =>
      po.items.map((i) => [i.id, i.product.name] as const),
    ),
  );
}

/** A cycle with nothing ordered has nothing that can arrive or be lost. */
function assertHasOrderLines(cycle: LoadedShipment) {
  if (orderLines(cycle).size === 0) {
    throw badRequest(
      'VALIDATION_FAILED',
      `Cycle ${cycle.code} has nothing ordered, so nothing can be delivered or lost.`,
      { fields: 'lines' },
    );
  }
}

@Injectable()
export class DeliveriesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private costing: CostingService,
  ) {}

  /** The leg's cycle, or a 404 — a non-uuid is "no such leg", not a 500. */
  private async legCycle(legId: string) {
    if (!isUuid(legId)) throw notFound('shippingLeg');
    const leg = await this.prisma.shippingLeg.findUnique({
      where: { id: legId },
      select: { id: true, cycleId: true },
    });
    if (!leg) throw notFound('shippingLeg');
    return leg;
  }

  // ─── Deliveries ────────────────────────────────────────────────────────

  /** POST /shipping/legs/:id/deliveries */
  async recordDelivery(
    legId: string,
    body: { arrivedOn: string; lines: ShipmentLineInput[]; note?: string },
    actorId: string,
  ) {
    const lines = checkLines(body.lines);
    const day = deliveryDay(body.arrivedOn);
    const leg = await this.legCycle(legId);

    const { delivery, changed } = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, leg.cycleId);
      const delivery = await this.deliverIn(
        tx,
        leg.cycleId,
        legId,
        day,
        lines,
        actorId,
        body.note,
      );
      const changed = await syncLegStatuses(tx, leg.cycleId);
      await this.audit.log(
        {
          actorUserId: actorId,
          action: 'CREATE',
          entityType: 'ShipmentDelivery',
          entityId: delivery.id,
          afterJson: delivery,
        },
        tx,
      );
      return { delivery, changed };
    });

    await this.notifyArrivals(leg.cycleId, changed);
    return { data: delivery };
  }

  /**
   * "Everything still on the way on this leg arrived on `day`" — what an
   * arrival date on the old leg form means now (spec: PUT kept for
   * compatibility). Nothing left on the way → nothing written.
   *
   * Runs inside the caller's transaction, which must already hold the lock.
   */
  async deliverRemainderIn(
    tx: Tx,
    cycleId: string,
    legId: string,
    day: string,
    actorId: string,
  ) {
    const loaded = await loadShipment(tx, cycleId);
    const legPos = loaded?.position.legs.find((l) => l.legId === legId);
    const remainder = (legPos?.lines ?? [])
      .filter((l) => milli(l.onTheWay) > 0)
      .map((l) => ({
        purchaseOrderItemId: l.purchaseOrderItemId,
        qty: l.onTheWay,
      }));
    if (remainder.length === 0) return null;
    return this.deliverIn(tx, cycleId, legId, day, remainder, actorId);
  }

  /** Every check a delivery makes, then the delivery. Caller holds the lock. */
  private async deliverIn(
    tx: Tx,
    cycleId: string,
    legId: string,
    day: string,
    lines: ShipmentLineInput[],
    actorId: string,
    note?: string,
  ) {
    const loaded = await loadShipment(tx, cycleId);
    if (!loaded) throw notFound('cycle');
    const { cycle, position } = loaded;
    const leg = cycle.shippingLegs.find((l) => l.id === legId)!;

    assertOpen(cycle);

    // Goods cannot arrive from a journey that has not started (§1).
    if (!leg.departedOn) {
      throw badRequest(
        'LEG_NOT_DEPARTED',
        `${where(leg)} has not departed. Record the departure date on that leg first.`,
        { leg: where(leg) },
      );
    }
    const departed = businessDay(leg.departedOn);
    if (day < departed) {
      throw badRequest(
        'DELIVERY_BEFORE_DEPARTURE',
        `A delivery on ${day} is before ${where(leg)} departed on ${departed}.`,
        { day, departedOn: departed, leg: where(leg) },
      );
    }

    assertHasOrderLines(cycle);
    const names = orderLines(cycle);
    const legPos = position.legs.find((l) => l.legId === legId)!;
    for (const line of lines) {
      // An order line of another cycle is "no such line" here, not a 500 from
      // a foreign key, and never a delivery onto someone else's order.
      if (!names.has(line.purchaseOrderItemId))
        throw notFound('purchaseOrderItem');
      const onTheWay = legPos.lines.find(
        (l) => l.purchaseOrderItemId === line.purchaseOrderItemId,
      )!.onTheWay;
      if (milli(line.qty) > milli(onTheWay)) {
        throw badRequest(
          'DELIVERY_EXCEEDS_IN_TRANSIT',
          `Only ${onTheWay} of ${names.get(line.purchaseOrderItemId)} are on the way on ${where(leg)}, so a delivery of ${line.qty} cannot be recorded.`,
          {
            line: names.get(line.purchaseOrderItemId)!,
            onTheWay,
            asked: Number(line.qty),
          },
        );
      }
    }

    return tx.shipmentDelivery.create({
      data: {
        legId,
        arrivedOn: new Date(`${day}T00:00:00Z`),
        note: note ?? null,
        createdBy: actorId,
        lines: {
          create: lines.map((l) => ({
            purchaseOrderItemId: l.purchaseOrderItemId,
            qty: l.qty,
          })),
        },
      },
      include: { lines: true },
    });
  }

  /**
   * DELETE /shipping/deliveries/:id — a delivery recorded by mistake.
   *
   * Refused with DELIVERY_IN_USE (spec amendment 7) when removing it would
   * leave a record the business could not have produced: stock was received
   * from it, a later leg carried its goods on, or the cycle's status says goods
   * reached a point that only this delivery shows them reaching.
   */
  async deleteDelivery(id: string, actorId: string) {
    if (!isUuid(id)) throw notFound('shipmentDelivery');
    const found = await this.prisma.shipmentDelivery.findUnique({
      where: { id },
      select: { id: true, leg: { select: { cycleId: true } } },
    });
    if (!found) throw notFound('shipmentDelivery');
    const cycleId = found.leg.cycleId;

    const changed = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const loaded = await loadShipment(tx, cycleId);
      if (!loaded) throw notFound('cycle');
      const { cycle } = loaded;
      assertOpen(cycle);

      const leg = cycle.shippingLegs.find((l) =>
        l.deliveries.some((d) => d.id === id),
      );
      // Deleted by someone else between the read and the lock.
      if (!leg) throw notFound('shipmentDelivery');
      const delivery = leg.deliveries.find((d) => d.id === id)!;

      const inUse = (why: 'received' | 'carried' | 'status', english: string) =>
        badRequest('DELIVERY_IN_USE', english, { why });

      const lineIds = new Set(delivery.lines.map((l) => l.id));
      if (
        cycle.inventoryBatches.some(
          (b) => b.sourceDeliveryLineId && lineIds.has(b.sourceDeliveryLineId),
        )
      ) {
        throw inUse(
          'received',
          'Stock was received from this delivery, so it cannot be deleted.',
        );
      }

      // The shipment as it would be without this delivery: nothing may leave
      // a leg that did not enter it.
      const without: LoadedShipment = {
        ...cycle,
        shippingLegs: cycle.shippingLegs.map((l) =>
          l.id === leg.id
            ? { ...l, deliveries: l.deliveries.filter((d) => d.id !== id) }
            : l,
        ),
      };
      const after = positionOf(without);
      const impossible = after.legs.some((lp) =>
        lp.lines.some(
          (ll) =>
            milli(ll.delivered) + milli(ll.lost) > milli(ll.entered) ||
            (ll.received !== null &&
              milli(ll.received) + milli(ll.lost) > milli(ll.entered)),
        ),
      );
      if (impossible) {
        throw inUse(
          'carried',
          'A later leg has carried on goods from this delivery, so it cannot be deleted.',
        );
      }

      const legs = cycle.shippingLegs;
      const isFirst = legs[0]?.id === leg.id;
      const isLast = legs[legs.length - 1]?.id === leg.id;
      const need = legsThatMustHaveDelivered(cycle.originType, cycle.status);
      const stillHasOne = leg.deliveries.length > 1;
      if (
        !stillHasOne &&
        ((isFirst && need.includes('first')) ||
          (isLast && need.includes('last')))
      ) {
        throw inUse(
          'status',
          `Cycle ${cycle.code} is ${cycle.status} because of this delivery, so it cannot be deleted. Move the cycle back first.`,
        );
      }

      await tx.shipmentDelivery.delete({ where: { id } });
      const changed = await syncLegStatuses(tx, cycleId);
      await this.audit.log(
        {
          actorUserId: actorId,
          action: 'DELETE',
          entityType: 'ShipmentDelivery',
          entityId: id,
          beforeJson: delivery,
        },
        tx,
      );
      return changed;
    });

    await this.notifyArrivals(cycleId, changed);
    return { data: { id, deleted: true } };
  }

  // ─── Losses ────────────────────────────────────────────────────────────

  /**
   * POST /shipping/legs/:id/losses — units a partner has decided are not
   * coming (§1). Anything not yet received can be marked lost: on the way on
   * this leg, or, on the last leg, delivered but never found when counted.
   *
   * Each loss is valued at the line's landed unit cost (§2) and is its own
   * record. No ledger row: no money moves when goods are lost (§9).
   */
  async recordLoss(
    legId: string,
    body: { lines: ShipmentLineInput[]; reason?: string },
    actorId: string,
  ) {
    const lines = checkLines(body.lines);
    const leg = await this.legCycle(legId);

    const { losses, changed } = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, leg.cycleId);
      const loaded = await loadShipment(tx, leg.cycleId);
      if (!loaded) throw notFound('cycle');
      const { cycle, position } = loaded;
      assertOpen(cycle);
      assertHasOrderLines(cycle);

      const names = orderLines(cycle);
      const legRow = cycle.shippingLegs.find((l) => l.id === legId)!;
      const legPos = position.legs.find((l) => l.legId === legId)!;
      for (const line of lines) {
        if (!names.has(line.purchaseOrderItemId))
          throw notFound('purchaseOrderItem');
        const lp = legPos.lines.find(
          (l) => l.purchaseOrderItemId === line.purchaseOrderItemId,
        )!;
        const available = milli(lp.onTheWay) + milli(lp.waiting ?? 0);
        if (milli(line.qty) > available) {
          throw badRequest(
            'LOSS_EXCEEDS_IN_TRANSIT',
            `Only ${available / 1000} of ${names.get(line.purchaseOrderItemId)} are still to come on ${where(legRow)}, so ${line.qty} cannot be marked lost.`,
            {
              line: names.get(line.purchaseOrderItemId)!,
              onTheWay: available / 1000,
              asked: Number(line.qty),
            },
          );
        }
      }

      // The costing service's per-ORDERED-unit figure (§2), read in this
      // transaction so a one-connection pool does not wait on itself.
      const costs = await this.costing.computeCycleLandedCosts(leg.cycleId, {
        db: tx,
      });
      const allLosses = cycle.shippingLegs.flatMap((l) => l.losses);
      const losses: ShipmentLoss[] = [];
      for (const line of lines) {
        const item = costs.items.find(
          (i) => i.purchaseOrderItemId === line.purchaseOrderItemId,
        )!;
        // The full unit cost on any leg; the loss that accounts for the
        // line's last units takes the rounding residual (amendment 9).
        const { unitCostEgp, costEgp } = lineEventCost({
          orderedQty: item.qty,
          landedTotalEgp: item.totalLandedCostEgp,
          unitCostEgp: item.landedUnitCostEgp,
          priorReceivedQtys: cycle.inventoryBatches
            .filter((b) => b.sourcePoItemId === line.purchaseOrderItemId)
            .map((b) => b.receivedQty),
          priorLosses: allLosses.filter(
            (x) => x.purchaseOrderItemId === line.purchaseOrderItemId,
          ),
          qty: line.qty,
        });
        const loss = await tx.shipmentLoss.create({
          data: {
            legId,
            purchaseOrderItemId: line.purchaseOrderItemId,
            qty: line.qty,
            unitCostEgp,
            costEgp,
            reason: body.reason ?? null,
            createdBy: actorId,
          },
        });
        losses.push(loss);
        await this.audit.log(
          {
            actorUserId: actorId,
            action: 'CREATE',
            entityType: 'ShipmentLoss',
            entityId: loss.id,
            afterJson: loss,
          },
          tx,
        );
      }
      const changed = await syncLegStatuses(tx, leg.cycleId);
      return { losses, changed };
    });

    await this.notifyArrivals(leg.cycleId, changed);
    return { data: losses };
  }

  /**
   * DELETE /shipping/losses/:id — the goods turned up after all. The units
   * are on the way again (§1). Refused once the cycle is being settled.
   */
  async takeBackLoss(id: string, actorId: string) {
    if (!isUuid(id)) throw notFound('shipmentLoss');
    const found = await this.prisma.shipmentLoss.findUnique({
      where: { id },
      select: { id: true, leg: { select: { cycleId: true } } },
    });
    if (!found) throw notFound('shipmentLoss');
    const cycleId = found.leg.cycleId;

    const changed = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const loaded = await loadShipment(tx, cycleId);
      if (!loaded) throw notFound('cycle');
      assertOpen(loaded.cycle);
      const loss = await tx.shipmentLoss.findUnique({ where: { id } });
      if (!loss) throw notFound('shipmentLoss');
      await assertLossNotRefunded(tx, loss.id);

      await tx.shipmentLoss.delete({ where: { id } });
      const changed = await syncLegStatuses(tx, cycleId);
      await this.audit.log(
        {
          actorUserId: actorId,
          action: 'DELETE',
          entityType: 'ShipmentLoss',
          entityId: id,
          beforeJson: loss,
        },
        tx,
      );
      return changed;
    });

    await this.notifyArrivals(cycleId, changed);
    return { data: { id, deleted: true } };
  }

  // ─── Notifications ─────────────────────────────────────────────────────

  /** Tell the cycle's participants when a leg's goods have all arrived. */
  async notifyArrivals(
    cycleId: string,
    changed: { legId: string; from: string; to: string }[],
  ) {
    const arrived = changed.filter((c) => c.to === 'ARRIVED');
    if (arrived.length === 0) return;
    const participants = await this.prisma.cycleParticipant.findMany({
      where: { cycleId },
    });
    const userIds = participants
      .flatMap((p) => [p.partnerUserId, p.investorUserId])
      .filter(Boolean) as string[];
    if (userIds.length === 0) return;
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
      select: { code: true },
    });
    for (const c of arrived) {
      const leg = await this.prisma.shippingLeg.findUnique({
        where: { id: c.legId },
        select: { sequence: true, origin: true, destination: true },
      });
      if (!leg) continue;
      await this.notifications.createForMultipleUsers(userIds, {
        eventType: 'SHIPPING_LEG_ARRIVED',
        title: `Shipping leg ${leg.sequence} (${leg.origin} → ${leg.destination}) has arrived`,
        payload: {
          legId: c.legId,
          cycleId,
          cycleCode: cycle?.code,
          sequence: leg.sequence,
        },
      });
    }
  }
}
