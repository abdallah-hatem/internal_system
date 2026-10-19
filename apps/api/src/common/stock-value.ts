import type { Prisma } from '@prisma/client';
import { scaled } from './default-price';

type Numeric = Prisma.Decimal | number | string;

/** The columns' own places: quantities to thousandths, unit costs to 4 places. */
const QTY_PLACES = 3;
const COST_PLACES = 4;

/**
 * What the stock on the shelf cost us: each batch's remaining units × its
 * landed unit cost (purchase + its share of freight and fees, §2), summed and
 * rounded once, half up, to the piastre.
 *
 * One definition (CLAUDE.md §11) for the dashboard's Inventory Value and a
 * product page's Stock value (owner 2026-10-19), so the products' figures
 * add up to the dashboard's. Exact integer arithmetic, as default-price.ts
 * does it: in floats 3 × 0.1 is 0.30000000000000004.
 */
export function stockValueEgp(
  batches: readonly { remainingQty: Numeric; landedUnitCostEgp: Numeric }[],
): number {
  const places = QTY_PLACES + COST_PLACES;
  const total = batches.reduce(
    (sum, b) =>
      sum +
      scaled(b.remainingQty, QTY_PLACES) *
        scaled(b.landedUnitCostEgp, COST_PLACES),
    0n,
  );
  const unit = 10n ** BigInt(places - 2);
  const sign = total < 0n ? -1n : 1n;
  const abs = total * sign;
  const cents = (abs / unit + ((abs % unit) * 2n >= unit ? 1n : 0n)) * sign;
  return Number(cents) / 100;
}
