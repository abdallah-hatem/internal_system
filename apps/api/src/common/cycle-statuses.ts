import type { CycleStatus } from '@prisma/client';

/**
 * Every cycle status, in the order a cycle passes through them — the one list
 * (rule 11). The assistant's tools filter and move by it, the office app's
 * copy (`apps/web/src/lib/cycle-statuses.ts`) orders its filter chips by it,
 * and `cycle-statuses.spec.ts` fails when the schema's enum gains a value this
 * list does not have.
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
] as const satisfies readonly CycleStatus[];

type MissingStatus = Exclude<CycleStatus, (typeof CYCLE_STATUSES)[number]>;
// A status added to the schema and not here fails the build.
const _everyStatus: [MissingStatus] extends [never] ? true : MissingStatus =
  true;
void _everyStatus;

/**
 * The statuses that come before shipping: nothing of the cycle has left a
 * supplier yet (BUSINESS_LOGIC §1, Preparing, 2026-10-27). The one place that
 * says so: the shipment walk starts from these (`forwardPath`), the stranded-
 * drafts scripts count every other open status as "the order was placed", and
 * the office app's copy is pinned to this by a test.
 *
 * PREPARING is the last of them — the order is confirmed (the cycle left
 * PURCHASING, §15) and the supplier is preparing it; the first departure moves
 * the cycle on to In transit.
 */
export const BEFORE_SHIPPING = [
  'PLANNING',
  'FUNDING',
  'PURCHASING',
  'PREPARING',
] as const satisfies readonly CycleStatus[];
