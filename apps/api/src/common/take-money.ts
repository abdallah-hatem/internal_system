// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';

/**
 * Taking money from a cycle before it is settled, in one go (BUSINESS_LOGIC
 * §8, owner 2026-11-10: one card, "Take money from this cycle").
 *
 * Two kinds of money with their own rules and records stay two: profit taken
 * (`ProfitDraw` kind DRAW, the PROFIT_DRAWN line) and capital taken back early
 * (kind CAPITAL, the CAPITAL_TAKEN_EARLY line). One take is cut into them here,
 * profit first, then capital — the order is a GUESS (2026-11-10), written in
 * docs/business/08: profit is his to keep whatever the cycle does next, while
 * capital taken early is what he may owe back if the cycle ends in a loss.
 *
 * The one definition (rule 11): the service records what this returns, and the
 * web dialog's preview is pinned to it by a unit test.
 */

const ZERO = new Prisma.Decimal(0);

export interface TakeSplit {
  profit: Prisma.Decimal;
  capital: Prisma.Decimal;
}

/**
 * Cut `amount` into profit and capital: as much as his profit room allows,
 * the rest from his capital room. Null when the two rooms together are less
 * than the amount — nothing is cut, nothing is taken.
 */
export function splitTake(
  amount: Prisma.Decimal,
  profitRoom: Prisma.Decimal,
  capitalRoom: Prisma.Decimal,
): TakeSplit | null {
  const p = profitRoom.gt(0) ? profitRoom : ZERO;
  const c = capitalRoom.gt(0) ? capitalRoom : ZERO;
  if (amount.lte(0) || amount.gt(p.add(c))) return null;
  const profit = amount.lt(p) ? amount : p;
  return { profit, capital: amount.sub(profit) };
}
