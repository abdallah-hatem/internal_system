import type { Prisma } from '@prisma/client';
import { notFound } from './api-error';

/**
 * Which cycles a caller may read — the one definition every read uses
 * (CLAUDE.md rule 11; BUSINESS_LOGIC roles, decided by the owner 2026-10-10:
 * "a temporary investor sees only their own cycles").
 *
 * A menu that hides a page is not a guard (rule 12), so the cycles list, a
 * cycle, its purchases, legs, shipment, landed cost, stock, settlement and
 * profitability all ask this before they answer.
 *
 *   CORE_PARTNER, ADMIN_SUPPORT → null: no restriction, every cycle.
 *   TEMP_INVESTOR               → the ids of the cycles they participate in.
 *   anything else, or no user   → []: nothing. A role nobody planned for
 *                                 fails closed rather than seeing everything.
 *
 * `'internal'` is a caller with no HTTP viewer at all — the assistant, which
 * only a core partner can reach, calling a service method directly. It is
 * spelled out rather than implied by a missing argument, so a controller that
 * forgets to pass its user gets nothing, not everything.
 */

/** The roles that read every cycle. */
export const UNRESTRICTED_ROLES: readonly string[] = [
  'CORE_PARTNER',
  'ADMIN_SUPPORT',
];

export interface Viewer {
  id: string;
  role: string;
}

/** Who is asking: a signed-in user, or an internal caller. */
export type ScopeViewer = Viewer | 'internal' | null | undefined;

/** null: every cycle. A list: only these (possibly none). */
export type CycleScope = readonly string[] | null;

type ScopeDb = Pick<Prisma.TransactionClient, 'cycleParticipant'>;

/** True when the caller reads everything without a cycle filter. */
export function seesEveryCycle(viewer: ScopeViewer): boolean {
  if (viewer === 'internal') return true;
  return !!viewer && UNRESTRICTED_ROLES.includes(viewer.role);
}

/** The participant rows that are the viewer themself, as a Prisma filter. */
function ownRows(viewer: Viewer): Prisma.CycleParticipantWhereInput {
  // A temporary investor joins as an investor; the partner column is read too
  // so a person is never shown less of a cycle than the row that names them.
  return { OR: [{ investorUserId: viewer.id }, { partnerUserId: viewer.id }] };
}

export async function cyclesVisibleTo(
  viewer: ScopeViewer,
  db: ScopeDb,
): Promise<CycleScope> {
  if (seesEveryCycle(viewer)) return null;
  if (!viewer || viewer === 'internal' || viewer.role !== 'TEMP_INVESTOR')
    return [];
  const rows = await db.cycleParticipant.findMany({
    where: ownRows(viewer),
    select: { cycleId: true },
  });
  return [...new Set(rows.map((r) => r.cycleId))];
}

/**
 * The viewer's own participant rows, for the reads that show one line per
 * participant (a settlement, a preview, a cycle's participants). null: every
 * line. An investor sees their own payout and the cycle's totals, never
 * another participant's line.
 */
export async function ownParticipantIds(
  viewer: ScopeViewer,
  db: ScopeDb,
): Promise<readonly string[] | null> {
  if (seesEveryCycle(viewer)) return null;
  if (!viewer || viewer === 'internal' || viewer.role !== 'TEMP_INVESTOR')
    return [];
  const rows = await db.cycleParticipant.findMany({
    where: ownRows(viewer),
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Participant rows a viewer may see, as a Prisma filter (undefined: all). */
export function participantFilter(
  viewer: ScopeViewer,
): Prisma.CycleParticipantWhereInput | undefined {
  if (seesEveryCycle(viewer)) return undefined;
  if (!viewer || viewer === 'internal' || viewer.role !== 'TEMP_INVESTOR') {
    return { id: { in: [] } };
  }
  return ownRows(viewer);
}

export function inScope(
  scope: CycleScope,
  cycleId: string | null | undefined,
): boolean {
  if (scope === null) return true;
  return !!cycleId && scope.includes(cycleId);
}

/**
 * Refuses a cycle outside the scope as not found — 404, not 403, so asking
 * about a cycle does not confirm that it exists (plan R1).
 */
export function assertInScope(
  scope: CycleScope,
  cycleId: string | null | undefined,
  entity = 'cycle',
): void {
  if (!inScope(scope, cycleId)) throw notFound(entity);
}

/**
 * The `cycleId` filter for a list: the one asked for, narrowed to the scope.
 * A cycle asked for outside the scope matches nothing — an empty list, the
 * same answer as a cycle with nothing on it.
 */
export function cycleIdWhere(
  scope: CycleScope,
  requested?: string,
): string | { in: string[] } | undefined {
  if (scope === null) return requested || undefined;
  if (requested) return scope.includes(requested) ? requested : { in: [] };
  return { in: [...scope] };
}
