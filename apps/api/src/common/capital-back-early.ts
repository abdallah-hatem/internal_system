// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { paidAndValueOf } from './profit-on-collected';
import { REALISED_SALE_STATUSES } from './units-sold';

/**
 * Capital taken back before a cycle is settled (BUSINESS_LOGIC §8, owner
 * 2026-11-08: "why am i allowed to take from profit only i have money as
 * well, the money i put to purchase goods").
 *
 * Mid-cycle a participant's capital is stock, customers' debt, or cash that
 * paid sales brought back — and that cash is everyone's capital, investors'
 * included, so each may take back only his own part of it: the share of the
 * cycle's cost recovered so far, times what he put in.
 *
 * The one definition every reader shares (rule 11): the room, the settlement
 * line, the ledger category.
 */

const ZERO = new Prisma.Decimal(0);
const ONE = new Prisma.Decimal(1);
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/**
 * The ledger category of the cash taken back. Money out, but capital, not an
 * expense and not a cost of the cycle — like `contribution` it is in
 * CAPITALISED_CATEGORIES, so the cycle's profit never sees it. Its own
 * category, not `contribution`: the contribution rows sum to what each
 * participant put in (check-data 14.1) and the split reads that figure, which
 * an early return must not move.
 */
export const CAPITAL_BACK_CATEGORY = 'capital_back_early';

/** The ledger row's type, and its undo's. */
export const CAPITAL_BACK_TYPE = 'CAPITAL_RETURN_EARLY';
export const CAPITAL_BACK_REVERSAL_TYPE = 'CAPITAL_RETURN_EARLY_REVERSAL';

/** The settlement line capital taken early is written as (negative). */
export const CAPITAL_TAKEN_EARLY_COMPONENT = 'CAPITAL_TAKEN_EARLY';

/**
 * The cost of the goods customers have paid for: each realised order's cost
 * from this cycle's batches (less cost given back by returns), times the share
 * of that order paid — the dashboard's and profit draws' own reading of "the
 * share paid" (`paidAndValueOf`, rule 11). Never below zero.
 */
export async function cycleCostRecovered(
  db: Pick<Prisma.TransactionClient, 'saleItemAllocation' | 'saleReturnItem'>,
  cycleId: string,
): Promise<Prisma.Decimal> {
  const orderSelect = {
    id: true,
    outstanding: true,
    paymentAllocations: {
      select: { amount: true, payment: { select: { status: true } } },
    },
    returns: { select: { refundMethod: true, refundEgp: true } },
  } as const;
  const realised = { status: { in: [...REALISED_SALE_STATUSES] } };
  const [allocations, returned] = await Promise.all([
    db.saleItemAllocation.findMany({
      where: {
        inventoryBatch: { cycleId },
        saleItem: { saleOrder: realised },
      },
      select: {
        cogsEgp: true,
        saleItem: { select: { saleOrder: { select: orderSelect } } },
      },
    }),
    db.saleReturnItem.findMany({
      where: {
        inventoryBatch: { cycleId },
        saleItem: { saleOrder: realised },
      },
      select: {
        cogsReversedEgp: true,
        saleItem: { select: { saleOrder: { select: orderSelect } } },
      },
    }),
  ]);
  const shareOf = (o: Parameters<typeof paidAndValueOf>[0]) => {
    const { paid, value } = paidAndValueOf(o);
    if (value.lte(0)) return ZERO;
    return Prisma.Decimal.min(Prisma.Decimal.max(paid.div(value), ZERO), ONE);
  };
  let recovered = ZERO;
  for (const a of allocations) {
    recovered = recovered.add(
      new Prisma.Decimal(a.cogsEgp).mul(shareOf(a.saleItem.saleOrder)),
    );
  }
  for (const r of returned) {
    recovered = recovered.sub(
      new Prisma.Decimal(r.cogsReversedEgp).mul(shareOf(r.saleItem.saleOrder)),
    );
  }
  return recovered.gt(0) ? money(recovered) : ZERO;
}

/**
 * The share of the cycle's cost to fund that paid sales have brought back,
 * between 0 and 1. Nothing to fund recovers nothing: there is no capital in
 * the goods to give back.
 */
export function recoveredShare(
  recovered: Prisma.Decimal,
  toFund: Prisma.Decimal,
): Prisma.Decimal {
  if (toFund.lte(0) || recovered.lte(0)) return ZERO;
  const share = recovered.div(toFund);
  return share.gt(ONE) ? ONE : share;
}

/**
 * What one participant may take back now: the recovered share of what he put
 * in, less what he already took back early, never below zero.
 */
export function capitalRoom(input: {
  share: Prisma.Decimal;
  contribution: Prisma.Decimal;
  taken: Prisma.Decimal;
}): { recoveredEgp: Prisma.Decimal; availableEgp: Prisma.Decimal } {
  const contribution = input.contribution.gt(0) ? input.contribution : ZERO;
  // Rounded down: a piastre more than his part is someone else's money.
  const part = contribution
    .mul(input.share)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  const recoveredEgp = part.gt(contribution) ? contribution : part;
  const left = recoveredEgp.sub(input.taken);
  return { recoveredEgp, availableEgp: left.gt(0) ? left : ZERO };
}
