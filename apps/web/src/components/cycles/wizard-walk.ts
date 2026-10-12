/**
 * How far finishing the wizard moves a cycle: only as far as its recorded dates
 * allow (BUSINESS_LOGIC §1 and §15, 2026-10-10).
 *
 * The wizard used to walk every cycle to VERIFICATION in one click and receive
 * its stock, which only worked when every leg had already arrived — and refused
 * outright when it had not, which is most of the time a cycle is set up. Now it
 * stops at the first step the dates do not support:
 *
 *   no departure on leg 1        → PURCHASING; its orders stay DRAFT (§15)
 *   leg 1 departed               → IN_TRANSIT; leaving PURCHASING confirms the orders
 *   leg 1 has a delivery         → ARRIVED_UAE (China)
 *   last leg departed            → IN_TRANSIT_TO_EGYPT
 *   last leg has a delivery      → ARRIVED_EGYPT, and never further
 *
 * VERIFICATION and SELLING belong to receiving, which happens on the cycle
 * page one delivery at a time. The server checks every step again
 * (`assertShippingReached`); this only decides which steps to ask for.
 */

/**
 * The statuses the wizard still has something to do for: "Continue setup"
 * (continue-setup.tsx) is offered for these, and the wizard opens on them.
 *
 * DECIDED 2026-10-12 (owner): the wizard is for setting a cycle up, and it
 * stops when the goods leave. From In transit on, departures, deliveries,
 * another leg and its cost are recorded on the cycle page (BUSINESS_LOGIC §1),
 * and a resumed wizard sends the cycle there.
 */
export const WIZARD_STATUSES = ['PLANNING', 'FUNDING', 'PURCHASING'];

export interface WalkLeg {
  sequence: number;
  departedOn?: string | null;
  arrivedOn?: string | null;
  status?: string | null;
}

type Check = (legs: WalkLeg[]) => boolean;

const leg = (legs: WalkLeg[], sequence: number) => legs.find((l) => l.sequence === sequence);
const departed =
  (sequence: number): Check =>
  (legs) =>
    Boolean(leg(legs, sequence)?.departedOn);
/** A leg with a delivery reads PARTLY_ARRIVED or ARRIVED — the server derives it. */
const delivered =
  (sequence: number): Check =>
  (legs) => {
    const l = leg(legs, sequence);
    return l?.status === 'PARTLY_ARRIVED' || l?.status === 'ARRIVED';
  };
const always: Check = () => true;

const PATHS: Record<string, [string, Check][]> = {
  CHINA: [
    ['FUNDING', always],
    ['PURCHASING', always],
    ['IN_TRANSIT', departed(1)],
    ['ARRIVED_UAE', delivered(1)],
    ['IN_TRANSIT_TO_EGYPT', departed(2)],
    ['ARRIVED_EGYPT', delivered(2)],
  ],
  // The one leg starts in the UAE. The machine only lets a UAE-direct cycle
  // leave PURCHASING through ARRIVED_UAE, so that step waits for the departure
  // too: with no date recorded the goods are bought, not moving (guess,
  // F1b build log).
  UAE_DIRECT: [
    ['FUNDING', always],
    ['PURCHASING', always],
    ['ARRIVED_UAE', departed(1)],
    ['IN_TRANSIT_TO_EGYPT', departed(1)],
    ['ARRIVED_EGYPT', delivered(1)],
  ],
};

/**
 * The statuses to request, in order, to move a cycle from `status` as far as
 * `legs` allow. Empty when it is already there, or past the wizard's reach.
 */
export function statusesToWalk(originType: string, status: string, legs: WalkLeg[]): string[] {
  const path = PATHS[originType === 'UAE_DIRECT' ? 'UAE_DIRECT' : 'CHINA'];
  const order = ['PLANNING', ...path.map(([s]) => s)];
  const from = order.indexOf(status);
  if (from < 0) return [];

  const steps: string[] = [];
  for (const [target, allowed] of path.slice(from)) {
    if (!allowed(legs)) break;
    steps.push(target);
  }
  return steps;
}
