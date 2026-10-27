/**
 * COPY of `apps/api/src/common/cycle-transitions.ts` — which status a cycle may
 * move to from each status. The server enforces its own copy; this one decides
 * what the details page's "Change status" button offers, so it never offers a
 * move the server will refuse. Next cannot import across apps, so
 * `cycle-transitions.test.ts` compares the two and fails the moment they
 * disagree. Change the API's file first, then this.
 */
export const VALID_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  PLANNING: ['FUNDING', 'CANCELLED'],
  FUNDING: ['PURCHASING', 'PLANNING', 'CANCELLED'],
  PURCHASING: ['PREPARING', 'CANCELLED'],
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

/** The statuses a cycle in `status` may move to; none for an unknown or final one. */
export function nextStatuses(status: string | undefined | null): readonly string[] {
  // Own keys only: `VALID_TRANSITIONS['constructor']` is Object's function.
  if (!status || !Object.hasOwn(VALID_TRANSITIONS, status)) return [];
  return VALID_TRANSITIONS[status];
}
