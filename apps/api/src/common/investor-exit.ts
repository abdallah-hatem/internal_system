// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';

/**
 * A temporary investor paid out and taken off a cycle before it settles
 * (BUSINESS_LOGIC §8, owner 2026-11-27: "we want to kick them both out by
 * giving them their money" — and their profit "until today with all
 * expenses").
 *
 * The one definition of what an exit pays and how it is recorded (rule 11).
 * His share is the settlement projection's own line for him, now — never a
 * second split. What he already took early (profit drawn, capital taken back,
 * anything owed from an earlier payout) is the very figure the settlement
 * would take off his payout (`deductionsFor`), so paying the difference now
 * leaves his settlement payout at exactly nothing.
 */

const ZERO = new Prisma.Decimal(0);

export interface ExitPayout {
  /** Paid as profit now: his net profit share less the profit he already took. */
  profitPart: Prisma.Decimal;
  /** Paid as capital now: his capital less what he took back early (less any loss beyond his draws). */
  capitalPart: Prisma.Decimal;
  /** Cash handed to him now: the two together. */
  payout: Prisma.Decimal;
}

/**
 * What an exit hands over, cut into the two records it is written as — the
 * profit part a `profit_draw`, the capital part a `capital_back_early` — so
 * the settlement's PROFIT_DRAWN and CAPITAL_TAKEN_EARLY lines take off exactly
 * his PROFIT_SHARE and CAPITAL_RETURN.
 *
 * A loss (GUESS 2026-11-27): his share of it comes off his capital, as it
 * would at settlement. Profit he drew beyond his share comes off his capital
 * too. Null when even his capital does not cover it — he would owe the
 * business, and an exit pays out, it does not collect (`EXIT_PAYOUT_NEGATIVE`).
 */
export function exitPayout(input: {
  capital: Prisma.Decimal;
  netProfit: Prisma.Decimal;
  /** Profit drawn on this cycle and anything owed from an earlier payout. */
  takenProfit: Prisma.Decimal;
  /** Capital taken back early from this cycle. */
  takenCapital: Prisma.Decimal;
}): ExitPayout | null {
  let profitPart = input.netProfit.sub(input.takenProfit);
  let capitalPart = input.capital.sub(input.takenCapital);
  if (profitPart.lt(0)) {
    capitalPart = capitalPart.add(profitPart);
    profitPart = ZERO;
  }
  if (capitalPart.lt(0)) return null;
  return { profitPart, capitalPart, payout: profitPart.add(capitalPart) };
}

/**
 * The share of each remaining participant's capital that cash recovered so
 * far still covers, once exits have taken theirs (§8, 2026-11-27: "the
 * partners advance the rest"). Paid sales have brought back `share` of what
 * everyone put in; what the exited investors took as capital came out of that
 * pool, so the rest is shared over the remaining contributions — and nobody
 * can take the same money twice. With nobody exited, exactly `share`.
 */
export function remainingRecoveredShare(input: {
  share: Prisma.Decimal;
  /** Every participant's contribution, the exited's included. */
  allContributions: Prisma.Decimal;
  /** The contributions of those still on the cycle. */
  liveContributions: Prisma.Decimal;
  /** Capital the exited participants were paid (their standing capital rows). */
  exitedCapitalTaken: Prisma.Decimal;
  anyExited: boolean;
}): Prisma.Decimal {
  if (!input.anyExited) return input.share;
  if (input.liveContributions.lte(0)) return ZERO;
  const left = input.share
    .mul(input.allContributions)
    .sub(input.exitedCapitalTaken);
  if (left.lte(0)) return ZERO;
  const s = left.div(input.liveContributions);
  return s.gt(input.share) ? input.share : s;
}
