import { expectedLegs } from './cycle-routes';

/**
 * L3 — a cycle's status follows its shipment (BUSINESS_LOGIC §1, owner,
 * 2026-10-11).
 *
 * Recording a departure or a delivery moves the cycle forward to the furthest
 * status the shipment proves, one step at a time through the same transition
 * the Change status button makes (`CyclesService.followShipment`). This file
 * answers the two questions that walk needs, with nothing read or written:
 * how far the recorded shipment proves the cycle got, and which steps lead
 * there from where it stands.
 *
 * What proves what is §1's step-requires table, read the other way round:
 *
 *   China       leg 1 departed     → In transit
 *               leg 1 delivered    → Arrived UAE
 *               leg 2 departed     → In transit to Egypt
 *               leg 2 delivered    → Arrived Egypt
 *   UAE direct  leg 1 departed     → In transit to Egypt (through Arrived UAE,
 *                                     which asks nothing of its one leg)
 *               leg 1 delivered    → Arrived Egypt
 *
 * The step checks (`assertShippingReached`) still run on every step; this only
 * decides which steps to ask for. It is stricter than they are on purpose: a
 * China cycle whose second leg was never added proves nothing past Arrived UAE,
 * although the transition checks let a missing leg through.
 */

export interface FollowLeg {
  sequence: number;
  departedOn: Date | string | null;
  status?: string | null;
  /** How many deliveries the leg has. */
  deliveries: number;
}

/** The statuses a cycle passes through on its way to Egypt, in order. */
export function forwardPath(originType: string): string[] {
  return originType === 'UAE_DIRECT'
    ? [
        'PLANNING',
        'FUNDING',
        'PURCHASING',
        'ARRIVED_UAE',
        'IN_TRANSIT_TO_EGYPT',
        'ARRIVED_EGYPT',
      ]
    : [
        'PLANNING',
        'FUNDING',
        'PURCHASING',
        'IN_TRANSIT',
        'ARRIVED_UAE',
        'IN_TRANSIT_TO_EGYPT',
        'ARRIVED_EGYPT',
      ];
}

const hasLeft = (l: FollowLeg | undefined) =>
  Boolean(l && (l.departedOn || (l.status && l.status !== 'PENDING')));
const hasDelivered = (l: FollowLeg | undefined) =>
  Boolean(l && l.deliveries > 0);

/** The furthest status the recorded shipment proves, or null when it proves none. */
export function statusProvenByShipment(
  originType: string,
  legs: FollowLeg[],
): string | null {
  const last = expectedLegs(originType).length;
  const leg = (sequence: number) => legs.find((l) => l.sequence === sequence);
  const lastLeg = leg(last);

  if (hasDelivered(lastLeg)) return 'ARRIVED_EGYPT';
  if (hasLeft(lastLeg)) return 'IN_TRANSIT_TO_EGYPT';
  if (originType === 'UAE_DIRECT') return null;
  const first = leg(1);
  if (hasDelivered(first)) return 'ARRIVED_UAE';
  if (hasLeft(first)) return 'IN_TRANSIT';
  return null;
}

/**
 * The statuses to move through, in order, from `status` to `target`. Empty
 * when the cycle is already there or further, when there is no target, and
 * when the cycle is anywhere off the way to Egypt — verification, selling,
 * settlement, closed, cancelled: the walk never moves a cycle back and never
 * touches one that is past arriving or finished.
 */
export function stepsToward(
  originType: string,
  status: string,
  target: string | null,
): string[] {
  if (!target) return [];
  const path = forwardPath(originType);
  const from = path.indexOf(status);
  const to = path.indexOf(target);
  if (from < 0 || to < 0 || to <= from) return [];
  return path.slice(from + 1, to + 1);
}
