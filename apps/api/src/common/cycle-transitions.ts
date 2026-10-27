/**
 * Which status a cycle may move to from each status — the one definition the
 * server enforces (`CyclesService.planTransition`).
 *
 * `apps/web/src/lib/cycle-transitions.ts` is a copy the details page's
 * "Change status" button offers from (Next cannot import across apps);
 * `cycle-transitions.test.ts` there fails the moment the two disagree. Change
 * this file first, then that one.
 */
export const VALID_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  PLANNING: ['FUNDING', 'CANCELLED'],
  FUNDING: ['PURCHASING', 'PLANNING', 'CANCELLED'],
  // Leaving PURCHASING confirms the cycle's draft orders (§15); the order is
  // then being prepared until something departs (Preparing, §1, 2026-10-27).
  PURCHASING: ['PREPARING', 'CANCELLED'],
  // Back to PURCHASING only while nothing has departed (CYCLE_HAS_DEPARTED).
  PREPARING: ['IN_TRANSIT', 'ARRIVED_UAE', 'PURCHASING', 'CANCELLED'],
  IN_TRANSIT: ['ARRIVED_UAE', 'ARRIVED_EGYPT'],
  ARRIVED_UAE: ['IN_TRANSIT_TO_EGYPT'],
  IN_TRANSIT_TO_EGYPT: ['ARRIVED_EGYPT'],
  ARRIVED_EGYPT: ['VERIFICATION'],
  VERIFICATION: ['SELLING', 'ARRIVED_EGYPT'],
  SELLING: ['SETTLEMENT'],
  SETTLEMENT: ['CLOSED', 'SELLING'],
  CLOSED: [],
};
