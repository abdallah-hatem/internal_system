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

/**
 * `?stock=low` on inventory: the one web copy of the low-stock rule, pinned to
 * the API's (the dashboard count) by `lib/low-stock.test.ts`.
 */
export { isBelowMinStock } from '@/lib/low-stock';
