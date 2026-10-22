/**
 * The legs a cycle's route ships in, with the places the forms offer
 * (BUSINESS_LOGIC §1): a China cycle goes China → UAE (the merchant), then
 * UAE → Egypt (the shipping company); a UAE-direct cycle only UAE → Egypt.
 *
 * The web's one copy of the API's `common/cycle-routes.ts` `expectedLegs` — the
 * office app cannot import API code at build time — pinned to it by
 * `leg-plan.test.ts`. The wizard's legs step and the Shipment panel's Add next
 * leg both read it.
 */
export interface PlannedLeg {
  sequence: number;
  origin: string;
  destination: string;
}

const UAE_TO_EGYPT = { origin: 'Dubai, UAE', destination: 'Cairo, Egypt' };

export function expectedLegsOf(originType: string | undefined): PlannedLeg[] {
  return originType === 'UAE_DIRECT'
    ? [{ sequence: 1, ...UAE_TO_EGYPT }]
    : [
        { sequence: 1, origin: 'Guangzhou, CN', destination: 'Dubai, UAE' },
        { sequence: 2, ...UAE_TO_EGYPT },
      ];
}

/** The first leg of the route not recorded yet, or null when every leg is. */
export function nextLegToAdd(originType: string | undefined, recorded: number[]): PlannedLeg | null {
  return expectedLegsOf(originType).find((l) => !recorded.includes(l.sequence)) ?? null;
}

/** Where a leg of this route leaves from: a China cycle's first leg leaves China; every other leg leaves the UAE. */
export function legLeavesFrom(originType: string | undefined, sequence: number): 'CHINA' | 'UAE' {
  return originType !== 'UAE_DIRECT' && sequence === 1 ? 'CHINA' : 'UAE';
}

/**
 * A new leg's starting currency and basis (owner, 2026-10-20): leaving China the
 * merchant quotes one figure in dollars, so **USD** and **a flat amount**; leaving
 * the UAE the shipping company bills in dirhams, so **AED**, with the form's usual
 * basis. Starting values only: a leg already saved keeps its own, and anything
 * picked on the form is never changed. The rate comes from the Exchange rates
 * page as for any currency (ShippingCostFields).
 */
export function legCostStart(
  originType: string | undefined,
  sequence: number,
): { currency: string; costBasis?: 'FLAT' } {
  return legLeavesFrom(originType, sequence) === 'CHINA' ? { currency: 'USD', costBasis: 'FLAT' } : { currency: 'AED' };
}
