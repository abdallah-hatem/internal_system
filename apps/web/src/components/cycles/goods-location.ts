/**
 * Where a cycle's goods are, in the owner's words (I3, layout A, 2026-10-11):
 * in China, on the way to the UAE, in the UAE, on the way to Egypt, in Egypt,
 * sold — and lost, when anything was.
 *
 * Nothing here is new arithmetic about the shipment. Every figure comes from
 * the server's `shipmentPosition` (per leg and order line: waiting at the
 * origin, on the way, lost, received, waiting to be received) and from the
 * cycle's batches for what was sold; this only decides which place each of
 * those numbers is (`legLinePlaces`). Goods can leave in parts (L8,
 * 2026-10-12): what has not left a leg's origin is still AT that origin — in
 * China for a China cycle's first leg, in the UAE for the leg to Egypt — and
 * only what has left is on the way.
 *
 *   China cycle:  leg 1 China → UAE,  leg 2 UAE → Egypt
 *   UAE direct:   leg 1 UAE → Egypt
 *
 * Every unit ordered is in exactly one place, so the places always add up to
 * what was ordered (lost is its own place). Pure: no clock, no requests.
 */

import { num, type Shipment, type ShipmentLeg, type ShipmentLegLine } from '@/components/shipment/shipment-model';

export interface GoodsBuckets {
  ordered: number;
  /** Ordered, and the leg out of China has not left. */
  inChina: number;
  /** On a China cycle's first leg after it left. */
  toUae: number;
  /** In Dubai: delivered by leg 1 (or ordered, on a UAE-direct cycle) and not yet on a leg that has left. */
  inUae: number;
  /** On the leg to Egypt after it left. */
  toEgypt: number;
  /** Delivered to Egypt and not sold: on the shelf, plus `notCheckedIn`. */
  inEgypt: number;
  /** Part of `inEgypt`: delivered to Egypt, not yet received into stock. */
  notCheckedIn: number;
  /** Units of this cycle's batches that have left the shelf through a sale. */
  sold: number;
  lost: number;
}

export interface ProductLocation extends GoodsBuckets {
  productId: string;
  productName: string;
}

export interface GoodsLocation {
  /** A UAE-direct cycle has no China or To-UAE place at all. */
  direct: boolean;
  totals: GoodsBuckets;
  products: ProductLocation[];
}

/** The batch fields this reads — `GET /cycles/:id` returns them on `inventoryBatches`. */
export interface LocationBatch {
  productId: string;
  receivedQty: number | string;
  remainingQty: number | string;
}

const PLACES = ['ordered', 'inChina', 'toUae', 'inUae', 'toEgypt', 'inEgypt', 'notCheckedIn', 'sold', 'lost'] as const;

/** Whole thousandths — the precision quantities are stored at — so sums stay exact. */
const milli = (v: unknown) => Math.round(num(v) * 1000);
const fromMilli = (m: number) => m / 1000;
const zero = (): GoodsBuckets => ({
  ordered: 0, inChina: 0, toUae: 0, inUae: 0, toEgypt: 0, inEgypt: 0, notCheckedIn: 0, sold: 0, lost: 0,
});

/** The places in milli-units, then the same in units. */
function toUnits(b: GoodsBuckets): GoodsBuckets {
  const out = zero();
  for (const k of PLACES) out[k] = fromMilli(b[k]);
  return out;
}

export function locateGoods(input: {
  originType: string;
  shipment: Pick<Shipment, 'lines' | 'legs'> | undefined;
  batches: LocationBatch[];
}): GoodsLocation {
  const direct = input.originType === 'UAE_DIRECT';
  const lines = input.shipment?.lines ?? [];
  const legs = [...(input.shipment?.legs ?? [])].sort((a, b) => a.sequence - b.sequence);

  // Per product, in milli-units, with the product's received total kept apart
  // until sold is known.
  const byProduct = new Map<string, { name: string; b: GoodsBuckets; received: number }>();
  const productOf = new Map<string, string>();
  for (const line of lines) {
    const key = line.productId ?? line.purchaseOrderItemId;
    productOf.set(line.purchaseOrderItemId, key);
    if (!byProduct.has(key)) byProduct.set(key, { name: line.productName ?? '—', b: zero(), received: 0 });
    byProduct.get(key)!.b.ordered += milli(line.ordered);
  }

  for (const leg of legs) {
    // Which stretch this leg is: out of China, or into Egypt.
    const outOfChina = !direct && leg.sequence === 1;
    for (const l of leg.lines) {
      const p = byProduct.get(productOf.get(l.purchaseOrderItemId) ?? '');
      if (!p) continue;
      const places = legLinePlaces(leg, l, outOfChina);
      for (const k of Object.keys(places) as (keyof GoodsBuckets)[]) p.b[k] += places[k] ?? 0;
      p.b.lost += milli(l.lost);
      if (leg.isLast) {
        const waiting = milli(l.waiting ?? 0);
        if (outOfChina) {
          // A China cycle whose second leg is not recorded yet: what leg 1
          // delivered is sitting in Dubai, not waiting in Egypt.
          p.b.inUae += waiting;
        } else {
          p.b.notCheckedIn += waiting;
        }
        p.received += milli(l.received ?? 0);
      }
    }
  }

  // Sold: what left this cycle's shelves, per product. A sale takes units off
  // `remainingQty`; a cancelled sale or a return to stock puts them back.
  const soldByProduct = new Map<string, number>();
  for (const batch of input.batches) {
    const sold = Math.max(0, milli(batch.receivedQty) - milli(batch.remainingQty));
    soldByProduct.set(batch.productId, (soldByProduct.get(batch.productId) ?? 0) + sold);
  }

  const products: ProductLocation[] = [];
  const totals = zero();
  for (const [productId, p] of byProduct) {
    const sold = Math.min(p.received, soldByProduct.get(productId) ?? 0);
    p.b.sold = sold;
    p.b.inEgypt = p.received - sold + p.b.notCheckedIn;

    // Whatever no leg accounts for has not been put on one: it is still where
    // the cycle starts. With every leg recorded this is zero.
    const placed = p.b.inChina + p.b.toUae + p.b.inUae + p.b.toEgypt + p.b.inEgypt + p.b.sold + p.b.lost;
    const unplaced = p.b.ordered - placed;
    if (unplaced > 0) {
      if (direct) p.b.inUae += unplaced;
      else p.b.inChina += unplaced;
    }

    for (const k of PLACES) totals[k] += p.b[k];
    products.push({ productId, productName: p.name, ...toUnits(p.b) });
  }

  return { direct, totals: toUnits(totals), products };
}

/**
 * Where one leg line's goods that have not arrived are, in milli-units (L8):
 * what waits at the leg's origin is at that place (in China out of China, in
 * the UAE on the leg to Egypt); what has left is on the way to the leg's end.
 *
 * A server from before L8 sends no `atOrigin`: a leg that had left then read as
 * everything on the way, and one that had not as everything still at origin.
 */
export function legLinePlaces(
  leg: Pick<ShipmentLeg, 'departedOn' | 'status'>,
  line: Pick<ShipmentLegLine, 'onTheWay' | 'atOrigin'>,
  outOfChina: boolean,
): Partial<GoodsBuckets> {
  let atOrigin = milli(line.atOrigin);
  let onTheWay = milli(line.onTheWay);
  if (line.atOrigin === undefined) {
    const departed = !!leg.departedOn || leg.status !== 'PENDING';
    atOrigin = departed ? 0 : onTheWay;
    onTheWay = departed ? onTheWay : 0;
  }
  return outOfChina ? { inChina: atOrigin, toUae: onTheWay } : { inUae: atOrigin, toEgypt: onTheWay };
}

/** The places that add up to `ordered` — `notCheckedIn` is inside `inEgypt`, so it is not one. */
export const LOCATION_PLACES = ['inChina', 'toUae', 'inUae', 'toEgypt', 'inEgypt', 'sold', 'lost'] as const;
