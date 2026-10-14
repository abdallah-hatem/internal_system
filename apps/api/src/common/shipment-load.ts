import type { Prisma } from '@prisma/client';
import { businessDay } from './dates';
import { shipmentPosition, type ShipmentPosition } from './shipment-position';

/**
 * Loading a cycle's shipment, locking it, and writing back what it says
 * (BUSINESS_LOGIC §1, 2026-10-10).
 *
 * `shipmentPosition` is the arithmetic and stays pure. This is the one place
 * that reads the rows it needs, so the shipment panel, the delivery and loss
 * guards and the leg-status writer all see the same thing (CLAUDE.md rule 11).
 */

type Db = Prisma.TransactionClient;

/** Everything `shipmentPosition` reads, plus what the screens name. */
const SHIPMENT_SELECT = {
  id: true,
  code: true,
  status: true,
  originType: true,
  shippingLegs: {
    orderBy: { sequence: 'asc' },
    select: {
      id: true,
      sequence: true,
      origin: true,
      destination: true,
      departedOn: true,
      arrivedOn: true,
      status: true,
      departures: {
        orderBy: [{ departedOn: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          legId: true,
          departedOn: true,
          note: true,
          createdAt: true,
          lines: {
            select: { id: true, purchaseOrderItemId: true, qty: true },
          },
        },
      },
      deliveries: {
        select: {
          id: true,
          legId: true,
          arrivedOn: true,
          note: true,
          lines: {
            select: { id: true, purchaseOrderItemId: true, qty: true },
          },
        },
      },
      losses: {
        select: {
          id: true,
          legId: true,
          purchaseOrderItemId: true,
          qty: true,
          unitCostEgp: true,
          costEgp: true,
          reason: true,
          createdAt: true,
        },
      },
    },
  },
  purchaseOrders: {
    select: {
      orderedOn: true,
      items: {
        select: {
          id: true,
          orderedQty: true,
          productId: true,
          product: { select: { name: true, nameAr: true } },
        },
      },
    },
  },
  inventoryBatches: {
    select: {
      sourcePoItemId: true,
      sourceDeliveryLineId: true,
      receivedQty: true,
    },
  },
} satisfies Prisma.ImportCycleSelect;

export type LoadedShipment = Prisma.ImportCycleGetPayload<{
  select: typeof SHIPMENT_SELECT;
}>;

/** The cycle's shipment rows and the position they add up to; null for no such cycle. */
export async function loadShipment(
  db: Pick<Db, 'importCycle'>,
  cycleId: string,
): Promise<{ cycle: LoadedShipment; position: ShipmentPosition } | null> {
  const cycle = await db.importCycle.findUnique({
    where: { id: cycleId },
    select: SHIPMENT_SELECT,
  });
  if (!cycle) return null;
  return { cycle, position: positionOf(cycle) };
}

/** The position of rows already loaded — for a "what if" with one removed. */
export function positionOf(cycle: LoadedShipment): ShipmentPosition {
  const legs = cycle.shippingLegs;
  return shipmentPosition({
    lines: cycle.purchaseOrders.flatMap((po) =>
      po.items.map((i) => ({
        id: i.id,
        orderedQty: i.orderedQty,
        productId: i.productId,
        productName: i.product.name,
        productNameAr: i.product.nameAr,
      })),
    ),
    legs,
    departures: legs.flatMap((l) => l.departures),
    deliveries: legs.flatMap((l) => l.deliveries),
    losses: legs.flatMap((l) => l.losses),
    batches: cycle.inventoryBatches,
  });
}

/**
 * Hold the cycle's row until the transaction ends.
 *
 * Every write that changes where a cycle's goods are — a delivery, a loss,
 * taking one back, deleting a delivery, changing a leg's dates or cost — takes
 * this first and only then reads the position it checks against. Two
 * deliveries of 30 against 40 on the way, sent at once, would otherwise both
 * read "40 on the way" and both be written. With the lock the second waits,
 * reads 10, and is refused.
 *
 * The cycle, not the leg: a later leg can only deliver what the leg before it
 * delivered, so deleting a leg-1 delivery and recording a leg-2 one race
 * against each other across two legs.
 */
export async function lockCycle(db: Pick<Db, '$queryRaw'>, cycleId: string) {
  await db.$queryRaw`SELECT id FROM import_cycles WHERE id = ${cycleId}::uuid FOR UPDATE`;
}

const REACHED_UAE = [
  'ARRIVED_UAE',
  'IN_TRANSIT_TO_EGYPT',
  'ARRIVED_EGYPT',
  'VERIFICATION',
  'SELLING',
  'SETTLEMENT',
  'CLOSED',
];
const IN_TRANSIT_OR_BEYOND = ['IN_TRANSIT', ...REACHED_UAE];
const TO_EGYPT_OR_BEYOND = [
  'IN_TRANSIT_TO_EGYPT',
  'ARRIVED_EGYPT',
  'VERIFICATION',
  'SELLING',
  'SETTLEMENT',
  'CLOSED',
];
const REACHED_EGYPT = [
  'ARRIVED_EGYPT',
  'VERIFICATION',
  'SELLING',
  'SETTLEMENT',
  'CLOSED',
];

/**
 * Which legs a cycle at `status` must have had at least one delivery on (§1's
 * table, 2026-10-10): a China cycle that reached the UAE needs one on its first
 * leg; any cycle that reached Egypt needs one on its last.
 *
 * Read by the transition gate (can the cycle move there?) and by deleting a
 * delivery (would the cycle be left somewhere its goods never reached?) — one
 * answer to one question. A UAE-direct cycle's one leg starts in the UAE, so
 * "arrived UAE" asks nothing of it.
 */
export function legsThatMustHaveDelivered(
  originType: string,
  status: string,
): ('first' | 'last')[] {
  const need: ('first' | 'last')[] = [];
  if (originType !== 'UAE_DIRECT' && REACHED_UAE.includes(status)) {
    need.push('first');
  }
  if (REACHED_EGYPT.includes(status)) need.push('last');
  return need;
}

/**
 * Which legs a cycle at `status` must have had a departure on — the other half
 * of §1's table: a China cycle in transit (or further) needs leg 1 to have
 * left; any cycle in transit to Egypt or further needs its last leg to have
 * left. Undoing a leg's only departure reads this (L8), as deleting a
 * delivery reads `legsThatMustHaveDelivered`.
 */
export function legsThatMustHaveDeparted(
  originType: string,
  status: string,
): ('first' | 'last')[] {
  const need: ('first' | 'last')[] = [];
  if (originType !== 'UAE_DIRECT' && IN_TRANSIT_OR_BEYOND.includes(status)) {
    need.push('first');
  }
  if (TO_EGYPT_OR_BEYOND.includes(status)) need.push('last');
  return need;
}

/** A calendar day as the timestamp column stores it: UTC midnight of that day. */
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

/**
 * Write each leg's `status`, `departedOn` and `arrivedOn` as the position
 * reads them.
 *
 * They are stored so lists can show them without loading every departure and
 * delivery, but nobody sets them: every writer calls this after its change,
 * inside its transaction, so the stored reading can never disagree with the
 * departures and deliveries (§1, L8). `departedOn` is the first departure's
 * day; a stored time on the same Cairo day is left as it is. Returns the legs
 * whose status changed, for notifications.
 */
export async function syncLegStatuses(
  db: Pick<Db, 'importCycle' | 'shippingLeg'>,
  cycleId: string,
): Promise<{ legId: string; from: string; to: string }[]> {
  const loaded = await loadShipment(db, cycleId);
  if (!loaded) return [];
  const changed: { legId: string; from: string; to: string }[] = [];
  for (const p of loaded.position.legs) {
    const leg = loaded.cycle.shippingLegs.find((l) => l.id === p.legId)!;
    const arrivedOn = p.arrivedOn ? asDate(p.arrivedOn) : null;
    const sameArrival =
      (leg.arrivedOn?.getTime() ?? null) === (arrivedOn?.getTime() ?? null);
    const sameDeparture =
      (leg.departedOn ? businessDay(leg.departedOn) : null) === p.departedOn;
    if (leg.status === p.status && sameArrival && sameDeparture) continue;
    await db.shippingLeg.update({
      where: { id: leg.id },
      data: {
        status: p.status,
        arrivedOn,
        ...(sameDeparture
          ? {}
          : { departedOn: p.departedOn ? asDate(p.departedOn) : null }),
      },
    });
    if (leg.status !== p.status) {
      changed.push({ legId: leg.id, from: leg.status, to: p.status });
    }
  }
  return changed;
}
