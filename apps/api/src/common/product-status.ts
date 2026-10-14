import { badRequest } from './api-error';

/**
 * A product is switched on or off — never deleted (BUSINESS_LOGIC §3,
 * DECIDED 2026-10-14 by the owner). Its orders, batches, receipts, returns and
 * settlements all point at it, so removing it would rewrite history.
 *
 * The one definition (CLAUDE.md §11). The column is a plain string and older
 * code wrote whatever it was sent, so this is also the only list of values a
 * caller may set: anything else is refused, never stored.
 *
 * INACTIVE means **no more is bought**: a new purchase-order line is refused
 * with PRODUCT_INACTIVE, and the wizard, the Purchases form and the
 * assistant's receipt matching stop offering it. What is already on the shelf
 * is still SOLD — the sale form, walk-in, the assistant's record_sale and the
 * storefront keep it while stock remains (the stock check refuses anything
 * beyond that, as for any product), and drop it once the shelf is empty.
 * Nothing that exists is touched.
 */
export const PRODUCT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** Offered for buying more: `where: { ...OFFERED }`. */
export const OFFERED = { status: 'ACTIVE' } as const;

/**
 * Offered for selling: on, or off with verified stock still on the shelf.
 * A Prisma `where` fragment, for lists a shop or a sale picks from.
 */
export const SELLABLE = {
  OR: [
    { status: 'ACTIVE' },
    {
      inventoryBatches: {
        some: {
          verificationStatus: 'VERIFIED' as const,
          saleableQty: { gt: 0 },
        },
      },
    },
  ],
};

export function isProductStatus(value: unknown): value is ProductStatus {
  return (
    typeof value === 'string' &&
    (PRODUCT_STATUSES as readonly string[]).includes(value)
  );
}

/** A status a caller asked to set, or the refusal. Case is not forgiven. */
export function parseProductStatus(value: unknown): ProductStatus {
  if (!isProductStatus(value)) {
    const given =
      typeof value === 'string' ? value : JSON.stringify(value ?? null);
    throw badRequest(
      'PRODUCT_STATUS_INVALID',
      `A product's status is ACTIVE or INACTIVE (given ${given}).`,
      { status: given },
    );
  }
  return value;
}

/**
 * Refuses buying more of a product that is switched off. Any status other
 * than ACTIVE counts as off — a row stored before the values were checked
 * cannot slip through by being spelt differently.
 */
export function assertOffered(product: { name: string; status: string }) {
  if (product.status !== 'ACTIVE') {
    throw badRequest(
      'PRODUCT_INACTIVE',
      `${product.name} is deactivated, so no more of it can be ordered. Reactivate it to buy more.`,
      { product: product.name },
    );
  }
}
