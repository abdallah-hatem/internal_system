// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; quantities and costs must not become floats
import { Prisma } from '@prisma/client';

import { assertNoSamplesOut, SAMPLES_OPEN_STATUS } from './samples';

/**
 * Units out at shops as samples, read from the database (BUSINESS_LOGIC §4,
 * "Samples at shops", 2026-10-18).
 *
 * A unit at a shop is off the shelf (its batch's `remainingQty` already fell)
 * and not sold (its order is SAMPLES, which no revenue or COGS reader counts).
 * It is counted here, once: from the allocations of open samples orders.
 * Inventory's "At shops", the cycle's unsold stock, and the settlement gate all
 * read this, so the three cannot disagree about how many are out.
 */

type Db = {
  saleItemAllocation: Pick<
    Prisma.TransactionClient['saleItemAllocation'],
    'findMany'
  >;
};

/**
 * The allocations of open samples orders, optionally one cycle's or one
 * shop's: the one definition of "samples out" every reader below shares.
 */
function openSampleDraws(
  db: Db,
  where: Prisma.InventoryBatchWhereInput,
  order: { customerId?: string } = {},
) {
  return db.saleItemAllocation.findMany({
    where: {
      inventoryBatch: where,
      saleItem: { saleOrder: { ...order, status: SAMPLES_OPEN_STATUS } },
    },
    select: {
      qty: true,
      unitCostEgp: true,
      inventoryBatchId: true,
      inventoryBatch: {
        select: {
          productId: true,
          cycleId: true,
          product: { select: { name: true, nameAr: true, sku: true } },
        },
      },
      saleItem: {
        select: {
          saleOrder: {
            select: {
              id: true,
              orderNo: true,
              samplesLeftAt: true,
              customer: { select: { displayName: true } },
              branch: { select: { id: true, name: true, archivedAt: true } },
            },
          },
        },
      },
    },
  });
}

/** One product a shop holds as samples, on one samples order. */
export interface ShopSampleLine {
  productId: string;
  name: string;
  nameAr: string | null;
  sku: string;
  /** Units at the shop, as a decimal string ("1", "2.5"). */
  units: string;
}

/**
 * The branch a samples order was left at (§7, "Samples by branch", owner
 * 2026-10-27), or null when it is on the owner — no branches, no default, or
 * left before the branches existed. Archived says the branch takes no new
 * orders; its samples are still there.
 */
export interface ShopSamplesBranch {
  id: string;
  name: string;
  archived: boolean;
}

/** One open samples order at a shop, and what is on it. */
export interface ShopSamplesOrder {
  id: string;
  orderNo: string;
  /** When the samples were left; null only for a record that predates the field. */
  leftAt: Date | null;
  /** Where they were left: a branch, or null for the owner. */
  branch: ShopSamplesBranch | null;
  lines: ShopSampleLine[];
}

/**
 * What a shop holds as samples right now (§4, "New Order warns when the shop
 * holds samples", owner 2026-10-25): its open samples orders, oldest first,
 * each with every product on it and its units — read from the same draws as
 * Inventory's "At shops" and the settlement gate, so the hint, the stock and
 * the gate cannot disagree. Returned, written-off and bought samples are no
 * longer SAMPLES and are not here; another shop's are not here either.
 *
 * Each order names its branch (owner 2026-10-27, "Samples by branch"): New
 * Order groups by it and the assistant's note says it. Every branch's samples
 * are here — one owner pays for all, so which to buy is the partner's call.
 */
export async function samplesAtShop(
  db: Db,
  customerId: string,
): Promise<ShopSamplesOrder[]> {
  const draws = await openSampleDraws(db, {}, { customerId });
  const orders = new Map<
    string,
    ShopSamplesOrder & { units: Map<string, ShopSampleLine> }
  >();
  for (const d of draws) {
    const o = d.saleItem.saleOrder;
    let entry = orders.get(o.id);
    if (!entry) {
      entry = {
        id: o.id,
        orderNo: o.orderNo,
        leftAt: o.samplesLeftAt,
        branch: o.branch
          ? {
              id: o.branch.id,
              name: o.branch.name,
              archived: o.branch.archivedAt !== null,
            }
          : null,
        lines: [],
        units: new Map(),
      };
      orders.set(o.id, entry);
    }
    const { productId, product } = d.inventoryBatch;
    const line = entry.units.get(productId);
    entry.units.set(productId, {
      productId,
      name: product.name,
      nameAr: product.nameAr,
      sku: product.sku,
      units: new Prisma.Decimal(line?.units ?? 0).add(d.qty).toString(),
    });
  }
  return [...orders.values()]
    .map(({ units, ...o }) => ({
      ...o,
      lines: [...units.values()].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort(
      (a, b) =>
        (a.leftAt?.getTime() ?? 0) - (b.leftAt?.getTime() ?? 0) ||
        a.orderNo.localeCompare(b.orderNo),
    );
}

/** Units of a cycle at shops, and what they cost: unsold stock away from the shelf. */
export async function cycleUnitsAtShops(db: Db, cycleId: string) {
  const draws = await openSampleDraws(db, { cycleId });
  return {
    units: draws.reduce((s, d) => s.add(d.qty), new Prisma.Decimal(0)),
    value: draws.reduce(
      (s, d) => s.add(new Prisma.Decimal(d.qty).mul(d.unitCostEgp)),
      new Prisma.Decimal(0),
    ),
  };
}

/** Units at shops per product and per batch, for the inventory page. */
export async function unitsAtShopsByProduct(
  db: Db,
  where: Prisma.InventoryBatchWhereInput = {},
) {
  const draws = await openSampleDraws(db, where);
  const byProduct = new Map<string, Prisma.Decimal>();
  const byBatch = new Map<string, Prisma.Decimal>();
  for (const d of draws) {
    const p = d.inventoryBatch.productId;
    byProduct.set(p, (byProduct.get(p) ?? new Prisma.Decimal(0)).add(d.qty));
    byBatch.set(
      d.inventoryBatchId,
      (byBatch.get(d.inventoryBatchId) ?? new Prisma.Decimal(0)).add(d.qty),
    );
  }
  return { byProduct, byBatch };
}

/**
 * Refuse to settle a cycle while any of its units are out as samples
 * (DECIDED, owner 2026-10-18): calculate, approve, pay, and the plain move to
 * Settlement all ask this. Names how many units at which shops.
 */
export async function assertCycleHasNoSamplesOut(
  db: Db,
  cycleId: string,
  cycleCode: string,
) {
  const draws = await openSampleDraws(db, { cycleId });
  const byShop = new Map<string, Prisma.Decimal>();
  for (const d of draws) {
    const shop = d.saleItem.saleOrder.customer.displayName;
    byShop.set(shop, (byShop.get(shop) ?? new Prisma.Decimal(0)).add(d.qty));
  }
  assertNoSamplesOut(
    cycleCode,
    [...byShop.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([shop, units]) => ({ shop, units })),
  );
}
