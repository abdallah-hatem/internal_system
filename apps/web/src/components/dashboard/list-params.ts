/**
 * How a list reads the filter a dashboard tile sends it, so the list shows
 * what the tile counted. Pure functions: the pages call them, the tests load
 * them without rendering a page.
 */

/** `?sort=balance` on customers: whoever owes the most first, then by name. */
export function sortByBalance<T extends { outstandingBalance?: number | string | null; displayName?: string }>(
  customers: readonly T[],
): T[] {
  return [...customers].sort(
    (a, b) =>
      Number(b.outstandingBalance ?? 0) - Number(a.outstandingBalance ?? 0) ||
      (a.displayName ?? '').localeCompare(b.displayName ?? ''),
  );
}

interface StockRow {
  totalStock: number | string;
  batches?: readonly { product?: { minStock?: number | string | null; status?: string } | null }[];
}

/**
 * `?stock=low` on inventory. The same rule as the dashboard's Low stock count
 * (`AnalyticsService.getDashboardKPIs`): an active product with a minimum set
 * whose stock on hand — every batch's remaining quantity — is under it.
 */
export function isBelowMinStock(row: StockRow): boolean {
  const product = row.batches?.find((b) => b.product)?.product;
  if (!product || product.minStock === null || product.minStock === undefined) return false;
  if (product.status && product.status !== 'ACTIVE') return false;
  return Number(row.totalStock) < Number(product.minStock);
}
