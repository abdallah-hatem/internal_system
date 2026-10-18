/**
 * A product's price on a channel, as the API resolved it (BUSINESS_LOGIC §3,
 * owner 2026-10-18): the one the owner set, or the DEFAULT — landed cost plus
 * the markup — where none is set. The rule and the markup live once, in
 * `apps/api/src/common/default-price.ts`; the app only reads what was sent, and
 * a DEFAULT carries its own `markupPct` for the hint, so no percentage is
 * written down here.
 *
 * A default is a suggestion. A sale line may start from it, and what is saved
 * is the line's price as it stands — never a stored product price.
 */
export type PriceSource = 'SET' | 'DEFAULT';

export interface ListPrice {
  amount: number | string;
  currency: string;
  source: PriceSource;
  markupPct?: number;
}

export type ListPrices = Partial<Record<'B2B' | 'B2C', ListPrice | null>>;

/** The product's price on a channel, or null when it has none (set or default). */
export function listPriceOf(
  product: { listPrices?: ListPrices | null } | null | undefined,
  channel: string,
): ListPrice | null {
  if (channel !== 'B2B' && channel !== 'B2C') return null;
  return product?.listPrices?.[channel] ?? null;
}

/** The amount as a number, or null. */
export function listAmountOf(
  product: { listPrices?: ListPrices | null } | null | undefined,
  channel: string,
): number | null {
  const price = listPriceOf(product, channel);
  return price ? Number(price.amount) : null;
}
