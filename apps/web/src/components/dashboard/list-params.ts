/**
 * How a list reads the filter a dashboard tile sends it, so the list shows
 * what the tile counted. Pure functions: the pages call them, the tests load
 * them without rendering a page.
 */

/**
 * `?stock=low` on inventory: the one web copy of the low-stock rule, pinned to
 * the API's (the dashboard count) by `lib/low-stock.test.ts`.
 */
export { isBelowMinStock } from '@/lib/low-stock';
