/**
 * COPY of `apps/api/src/common/low-stock.ts` — what "low stock" means
 * (BUSINESS_LOGIC §3, DECIDED 2026-10-10):
 *
 *     low = the product is ACTIVE, has a minimum set, and its stock on hand
 *           (remainingQty summed over every batch) is below that minimum
 *
 * A product with no minimum is never low. The dashboard counts with the API's
 * copy; the inventory filter (`?stock=low`) and the inventory highlight use
 * this one, so the tile and the list it opens agree. Next cannot import across
 * apps, so `low-stock.test.ts` runs both files over the same table of cases
 * and fails the moment they disagree. Change the API's file first, then this.
 *
 * The one web copy: nothing else in apps/web decides this.
 */

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

/** A row of `GET /inventory`: `totalStock` is already the remaining sum. */
export interface StockRow {
  totalStock: Quantity;
  batches?: readonly { product?: LowStockProduct | null }[];
}

/** One inventory row, by the rule above. */
export function isBelowMinStock(row: StockRow): boolean {
  const product = row.batches?.find((b) => b.product)?.product;
  return isLowStock(product, row.totalStock);
}
