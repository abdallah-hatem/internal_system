import type { PriceChannel } from '../../common/default-price';

export type { PriceChannel };

/**
 * Which price a viewer is shown, decided once.
 *
 * There are two tiers and four surfaces that show a price — the catalogue card,
 * the product page, the basket, and the order that comes out the other end.
 * Deciding per screen is how a storefront quotes one figure on the card and a
 * different one at checkout, and the shop is right to distrust everything after
 * that.
 *
 * So the channel is resolved here, from who is asking, and every portal
 * response carries the price already resolved. No component chooses.
 *
 *   anonymous, or a shop not yet verified  →  B2C
 *   a verified shop                        →  its customer type
 *
 * An unverified shop sees retail on purpose. It has not been agreed with
 * anybody yet, and showing trade prices to an account the owner has not looked
 * at would hand out the wholesale list to whoever fills in a signup form.
 */

export interface Viewer {
  /** Absent for an anonymous visitor. */
  customer?: { type: string; verificationStatus: string } | null;
}

export function channelFor(viewer: Viewer): PriceChannel {
  const customer = viewer.customer;
  if (!customer) return 'B2C';
  if (customer.verificationStatus !== 'VERIFIED') return 'B2C';
  return customer.type === 'B2B' ? 'B2B' : 'B2C';
}

// The price itself — set, else landed + markup — is `listPriceOn` in
// common/default-price.ts, the one definition every price reader uses.
