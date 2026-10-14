/**
 * What a switched-off product is still offered for (BUSINESS_LOGIC §3,
 * DECIDED 2026-10-14 by the owner) — the web's reading of
 * `apps/api/src/common/product-status.ts`.
 *
 * Off means **no more is bought**: it leaves every picker that buys — the
 * Purchases form, the wizard, an import request's answer — and the server
 * refuses a new purchase line (PRODUCT_INACTIVE). What is on the shelf is still
 * **sold**: the sale form (shop and walk-in) keeps it, tagged Inactive, while
 * there is stock to sell, and drops it once there is none.
 *
 * Anything other than ACTIVE is off, as on the server.
 */
export const PRODUCT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

type WithStatus = { status?: string | null };

/** Switched on: offered for buying more. */
export function isOffered(product: WithStatus): boolean {
  return product.status === 'ACTIVE';
}

/** The products a picker that BUYS may offer. */
export function offeredOnly<T extends WithStatus>(products: readonly T[]): T[] {
  return products.filter(isOffered);
}

/** Whether a sale picker lists it: on, or off with `available` units left. */
export function isSellable(product: WithStatus, available: number): boolean {
  return isOffered(product) || available > 0;
}
