/**
 * The legs a cycle's route ships in (BUSINESS_LOGIC §1).
 *
 * A China cycle has two — China→UAE by the merchant, then UAE→Egypt by the
 * shipping company. A UAE-direct cycle has only the UAE→Egypt leg. Written once
 * here so "how many legs does this cycle have" has one answer: the cycle's
 * status checks, the leg rules and the assistant's previews all read it.
 *
 * The place names are the defaults the office app's wizard offers.
 */
export interface ExpectedLeg {
  sequence: number;
  origin: string;
  destination: string;
}

export const CYCLE_ROUTES = ['CHINA', 'UAE_DIRECT'] as const;
export type CycleRoute = (typeof CYCLE_ROUTES)[number];

const UAE_TO_EGYPT = { origin: 'Dubai, UAE', destination: 'Cairo, Egypt' };

export function isCycleRoute(value: unknown): value is CycleRoute {
  return (CYCLE_ROUTES as readonly unknown[]).includes(value);
}

export function expectedLegs(originType: string): ExpectedLeg[] {
  return originType === 'UAE_DIRECT'
    ? [{ sequence: 1, ...UAE_TO_EGYPT }]
    : [
        { sequence: 1, origin: 'Guangzhou, CN', destination: 'Dubai, UAE' },
        { sequence: 2, ...UAE_TO_EGYPT },
      ];
}
