// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; a share must not become a float
import { Prisma } from '@prisma/client';
import { badRequest } from '../../common/api-error';
import { isUuid } from '../../common/uuid';

/**
 * The body of `PUT /cycles/:id/split` (§8 "Change split saved and checked on
 * the server", 2026-10-27), read into participant id → agreed percentage
 * (null: none). Each value on its own: a number from 0 to 100 with at most
 * four decimals — what the column holds, so nothing is rounded on the way in
 * and the 100 that was checked is the 100 that is stored. Whether they add up
 * is `customSplitProblem`'s question, asked once the cycle's participants are
 * known.
 */

/** Places the column keeps (`custom_profit_pct`, decimal(8,4)). */
const PCT_PLACES = 4;

export function splitEntries(
  body: unknown,
): Map<string, Prisma.Decimal | null> {
  const list = (body as { split?: unknown } | null)?.split;
  if (!Array.isArray(list)) {
    throw badRequest(
      'VALIDATION_FAILED',
      'split must be a list of { participantId, customProfitPct }.',
      { fields: 'split' },
    );
  }
  const out = new Map<string, Prisma.Decimal | null>();
  for (const raw of list) {
    const entry = (raw ?? {}) as {
      participantId?: unknown;
      customProfitPct?: unknown;
    };
    const id = entry.participantId;
    // Not an id at all is not on the cycle either — refused the same way,
    // never a uuid cast failing in Postgres as a 500 (CLAUDE.md §1).
    if (typeof id !== 'string' || !isUuid(id)) {
      throw badRequest(
        'SPLIT_PARTICIPANT_NOT_ON_CYCLE',
        `Participant ${String(id)} is not on this cycle.`,
      );
    }
    if (out.has(id)) {
      throw badRequest(
        'SPLIT_PARTICIPANT_TWICE',
        `Participant ${id} is named twice in the split.`,
      );
    }
    out.set(id, splitPct(entry.customProfitPct));
  }
  return out;
}

/** One percentage as sent: null or '' for none; otherwise 0–100, ≤ 4 places. */
function splitPct(raw: unknown): Prisma.Decimal | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const shown =
    typeof raw === 'number' || typeof raw === 'string'
      ? String(raw)
      : typeof raw;
  const refuse = () =>
    badRequest(
      'SPLIT_PCT_INVALID',
      `A profit share must be a percentage from 0 to 100 (received "${shown}").`,
      { value: shown },
    );
  if (typeof raw !== 'number' && typeof raw !== 'string') throw refuse();
  let pct: Prisma.Decimal;
  try {
    pct = new Prisma.Decimal(typeof raw === 'string' ? raw.trim() : raw);
  } catch {
    throw refuse();
  }
  if (
    !pct.isFinite() ||
    pct.lt(0) ||
    pct.gt(100) ||
    pct.decimalPlaces() > PCT_PLACES
  ) {
    throw refuse();
  }
  return pct;
}
