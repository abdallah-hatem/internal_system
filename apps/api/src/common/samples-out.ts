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

/** The allocations of open samples orders, optionally one cycle's. */
function openSampleDraws(db: Db, where: Prisma.InventoryBatchWhereInput) {
  return db.saleItemAllocation.findMany({
    where: {
      inventoryBatch: where,
      saleItem: { saleOrder: { status: SAMPLES_OPEN_STATUS } },
    },
    select: {
      qty: true,
      unitCostEgp: true,
      inventoryBatchId: true,
      inventoryBatch: { select: { productId: true, cycleId: true } },
      saleItem: {
        select: {
          saleOrder: {
            select: {
              id: true,
              orderNo: true,
              customer: { select: { displayName: true } },
            },
          },
        },
      },
    },
  });
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
