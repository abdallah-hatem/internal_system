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
  PURCHASING: ['IN_TRANSIT', 'ARRIVED_UAE', 'CANCELLED'],
  IN_TRANSIT: ['ARRIVED_UAE', 'ARRIVED_EGYPT'],
  ARRIVED_UAE: ['IN_TRANSIT_TO_EGYPT'],
  IN_TRANSIT_TO_EGYPT: ['ARRIVED_EGYPT'],
  ARRIVED_EGYPT: ['VERIFICATION'],
  VERIFICATION: ['SELLING', 'ARRIVED_EGYPT'],
  SELLING: ['SETTLEMENT'],
  SETTLEMENT: ['CLOSED', 'SELLING'],
  CLOSED: [],
};
