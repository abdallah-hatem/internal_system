/**
 * COPY of `apps/api/src/common/cycle-statuses.ts` — every cycle status in the
 * order a cycle passes through them, and the ones before shipping. Next cannot
 * import across apps, so `cycle-statuses.test.ts` compares the two (and the
 * schema's enum) and fails the moment they disagree. Change the API's file
 * first, then this.
 */
export const CYCLE_STATUSES = [
  'PLANNING',
  'FUNDING',
  'PURCHASING',
  'PREPARING',
  'IN_TRANSIT',
  'ARRIVED_UAE',
  'IN_TRANSIT_TO_EGYPT',
  'ARRIVED_EGYPT',
  'VERIFICATION',
  'SELLING',
  'SETTLEMENT',
  'CLOSED',
  'CANCELLED',
] as const;

/**
 * Nothing of the cycle has left a supplier yet (BUSINESS_LOGIC §1, Preparing,
 * 2026-10-27). Preparing is the last: the order is confirmed and being
 * prepared; the first departure moves the cycle on to In transit.
 */
export const BEFORE_SHIPPING = ['PLANNING', 'FUNDING', 'PURCHASING', 'PREPARING'] as const;
