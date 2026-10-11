import type { Prisma } from '@prisma/client';

/**
 * What "low stock" means — the one definition (BUSINESS_LOGIC §3, DECIDED
 * 2026-10-10; CLAUDE.md rule 11).
 *
 *     low = the product is ACTIVE
 *           and has a minimum set
 *           and its stock on hand is below that minimum (strictly: at the
 *           minimum is not low)
 *
 * A product with no minimum is never low, however little is left.
 *
 * **Stock on hand is `remainingQty` summed over every batch of the product** —
 * the units physically on the shelf, the figure the inventory page shows as
 * Total. Not `saleableQty`, which is what is left after holds: a unit held for
 * a customer is still on the shelf, and a minimum is a reorder point for the
 * shelf, not for what is unpromised. (Today the two are equal, since nothing
 * holds stock yet — §3 — so choosing one now is what stops them drifting the
 * day something does.)
 *
 * The rule used to live in four places: the dashboard count (remaining, ACTIVE
 * only), the low-stock notification raised on receiving (saleable, inactive
 * products included), the inventory filter and the inventory highlight. Two of
 * them already disagreed. Everything now asks here; the web app keeps one copy
 * in `apps/web/src/lib/low-stock.ts`, and its test runs both over the same
 * table of cases.
 *
 * No value imports, so the web test can load this file as it is.
 */

/** A minimum or a quantity as the database or the wire carries it. */
export type Quantity = number | string | { toString(): string };

export interface LowStockProduct {
  status?: string | null;
  minStock?: Quantity | null;
}

/** Sum of `remainingQty` over a product's batches — the stock on hand. */
export function stockOnHand(
  batches: readonly { remainingQty: Quantity }[],
): number {
  return batches.reduce((sum, b) => sum + Number(b.remainingQty), 0);
}

/**
 * The per-product predicate. `status` absent counts as active (a row that did
 * not carry it); any status other than ACTIVE is not low.
 */
export function isLowStock(
  product: LowStockProduct | null | undefined,
  onHand: Quantity,
): boolean {
  if (!product) return false;
  if (product.minStock === null || product.minStock === undefined) return false;
  if (product.status != null && product.status !== 'ACTIVE') return false;
  const minimum = Number(product.minStock);
  if (!Number.isFinite(minimum)) return false;
  return Number(onHand) < minimum;
}

/** Anything that can run the query — the client or a transaction. */
type Db = Pick<Prisma.TransactionClient, 'product'>;

export interface LowStockRow {
  productId: string;
  productName: string;
  currentStock: number;
  minStock: number;
}

/**
 * Every product that is low right now, optionally limited to some ids (the
 * products a receipt just touched). The database narrows to the candidates —
 * active, with a minimum — and the predicate above decides, so the query and
 * the per-product answer cannot disagree.
 */
export async function findLowStock(
  db: Db,
  productIds?: readonly string[],
): Promise<LowStockRow[]> {
  const candidates = await db.product.findMany({
    where: {
      status: 'ACTIVE',
      minStock: { not: null },
      ...(productIds ? { id: { in: [...productIds] } } : {}),
    },
    select: {
      id: true,
      name: true,
      status: true,
      minStock: true,
      inventoryBatches: { select: { remainingQty: true } },
    },
  });
  const low: LowStockRow[] = [];
  for (const p of candidates) {
    const onHand = stockOnHand(p.inventoryBatches);
    if (isLowStock(p, onHand)) {
      low.push({
        productId: p.id,
        productName: p.name,
        currentStock: onHand,
        minStock: Number(p.minStock),
      });
    }
  }
  return low;
}

/**
 * Which of the products a sale just touched it took **into** low stock — not
 * low before the sale, low after it (BUSINESS_LOGIC §3, DECIDED 2026-10-11).
 *
 * `lowAfter` is `findLowStock` over the products sold, read after the stock
 * left; `sold` is how much of each this sale took. Before the sale the shelf
 * held `currentStock + sold`, and that was low exactly when it was below the
 * minimum — so a product that was already low gives no second alert while it
 * stays low. It is alerted again only after stock comes back above its
 * minimum (a receipt, a return, a cancellation) and a sale takes it under once
 * more. A product left exactly at its minimum is not low (the rule above), so
 * it is not in `lowAfter` at all.
 */
export function crossedIntoLowStock(
  lowAfter: readonly LowStockRow[],
  sold: ReadonlyMap<string, number>,
): LowStockRow[] {
  return lowAfter.filter((row) => {
    const qty = sold.get(row.productId);
    if (!qty || qty <= 0) return false;
    // In whole thousandths, as quantities are stored (NUMERIC(18,3)): 9.9 +
    // 0.1 is 10, not 9.999999999999998.
    const milli = (n: number) => Math.round(n * 1000);
    return milli(row.currentStock) + milli(qty) >= milli(row.minStock);
  });
}

/** The dashboard's Low stock figure. */
export async function countLowStock(db: Db): Promise<number> {
  return (await findLowStock(db)).length;
}
