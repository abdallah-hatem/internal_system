import { saleLineTotals, type SaleLineInput } from './sale-totals';

/**
 * Selling below cost — the one definition (BUSINESS_LOGIC §4, DECIDED
 * 2026-10-11 by the owner). He sold 90 helmets at 1,000 that had landed at
 * 2,616.67 each and nothing told him. This is what tells him; it **warns and
 * never refuses** — a clearance sale or a favour to a shop is his to make.
 *
 * **What a line costs** is what confirming it would charge as COGS: the units
 * it would draw under FIFO, oldest received batch first, each batch at its own
 * landed cost, every allocation rounded to the cent as `confirmWithin` stores
 * it. A line that spans two batches costs exactly those units, so a price above
 * the weighted cost is not a loss even when it is under the newer batch.
 * Lines of the same product draw in order, the second after the first, as
 * confirming does.
 *
 * **What a line earns** is its total after the line discount, from
 * `saleLineTotals` — the stored figure, not quantity × a rounded unit price,
 * so a price that is at cost to the cent across the line is not flagged by
 * per-unit rounding.
 *
 * **No stock, no warning.** A line the shelf cannot cover in full is not
 * costed: confirming refuses it (`INSUFFICIENT_STOCK`) and that refusal is the
 * message. A line still being typed — no product, no quantity — is not costed
 * either and draws nothing, so it cannot push a real line onto a dearer batch.
 *
 * Pure and integer-only: quantities in thousandths, unit costs in
 * ten-thousandths, money in cents, products in BigInt so a large line cannot
 * lose a piastre. The layers are read, never changed.
 */

/** One batch on the shelf, in FIFO order: what can be drawn, at what landed cost. */
export interface CostLayer {
  qty: number | string | { toString(): string };
  unitCostEgp: number | string | { toString(): string };
}

export interface CostCheckLineInput extends SaleLineInput {
  productId: string;
}

export type UncostedReason = 'NO_STOCK' | 'INCOMPLETE';

export interface LineCostCheck {
  productId: string;
  /** The stock covers the whole line, so its cost is known. */
  costed: boolean;
  /** Why it was not costed; absent when it was. */
  reason?: UncostedReason;
  /** COGS confirming would record for this line. 0 when not costed. */
  costCents: number;
  /** The line total after its discount. */
  netCents: number;
  /** cost − net when that is positive; 0 otherwise. */
  lossCents: number;
  belowCost: boolean;
}

export interface CostCheck {
  lines: LineCostCheck[];
  totalLossCents: number;
}

// BigInt() rather than literals with an n suffix: the web app type-checks
// this file from its tests with an older target, which refuses that syntax.
const ZERO = BigInt(0);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);
const THOUSAND = BigInt(1000);
/** Ten-millionths (qty thousandths x cost ten-thousandths) in a cent. */
const PER_CENT_OF_COST = BigInt(100_000);

function roundHalfAway(x: bigint, divisor: bigint): bigint {
  const negative = x < ZERO;
  const abs = negative ? -x : x;
  const q = (abs + divisor / TWO) / divisor;
  return negative ? -q : q;
}

/** A decimal as an integer at `places`, half away from zero; null when not a finite number. */
function scaled(
  value: number | string | { toString(): string } | null | undefined,
  places: number,
): bigint | null {
  // A Prisma Decimal prints itself exactly; Number() of the object would not.
  const n = Number(
    typeof value === 'object' && value !== null ? value.toString() : value,
  );
  if (!Number.isFinite(n)) return null;
  // toFixed first, as sale-totals does: 1.255 × 1000 is 1254.9999… in binary.
  const fixed = Number((n * 10 ** places).toFixed(6));
  return BigInt(Math.sign(fixed) * Math.round(Math.abs(fixed)));
}

/** Cents of qty (thousandths) × unit cost (ten-thousandths): 1e-7 → 1e-2. */
function costOf(qtyMilli: bigint, costTenThousandths: bigint): bigint {
  return roundHalfAway(qtyMilli * costTenThousandths, PER_CENT_OF_COST);
}

export function priceAgainstCost(
  lines: readonly CostCheckLineInput[],
  layersByProduct: ReadonlyMap<string, readonly CostLayer[]>,
): CostCheck {
  // What is left in each batch as the lines draw, per product. A copy: the
  // caller's layers are left as they were.
  const left = new Map<string, { qty: bigint; cost: bigint }[]>();
  const shelf = (productId: string) => {
    let rows = left.get(productId);
    if (!rows) {
      rows = (layersByProduct.get(productId) ?? [])
        .map((l) => ({
          qty: scaled(l.qty, 3) ?? ZERO,
          cost: scaled(l.unitCostEgp, 4) ?? ZERO,
        }))
        .filter((l) => l.qty > ZERO);
      left.set(productId, rows);
    }
    return rows;
  };

  let totalLossCents = 0;
  const checked = lines.map((line): LineCostCheck => {
    const netCents = saleLineTotals(line).lineTotalCents;
    const uncosted = (reason: UncostedReason): LineCostCheck => ({
      productId: line.productId,
      costed: false,
      reason,
      costCents: 0,
      netCents,
      lossCents: 0,
      belowCost: false,
    });

    const qtyMilli = scaled(line.quantity, 3);
    if (!line.productId || qtyMilli === null || qtyMilli <= ZERO) {
      return uncosted('INCOMPLETE');
    }

    const rows = shelf(line.productId);
    const onShelf = rows.reduce((s, r) => s + r.qty, ZERO);
    // Not drawn at all when it cannot be met: confirming would roll the whole
    // sale back, so these units were never taken from anyone after it.
    if (onShelf < qtyMilli) return uncosted('NO_STOCK');

    let wanted = qtyMilli;
    let cost = ZERO;
    for (const row of rows) {
      if (wanted === ZERO) break;
      const take = row.qty < wanted ? row.qty : wanted;
      if (take === ZERO) continue;
      cost += costOf(take, row.cost);
      row.qty -= take;
      wanted -= take;
    }

    const costCents = Number(cost);
    const lossCents = Math.max(0, costCents - netCents);
    totalLossCents += lossCents;
    return {
      productId: line.productId,
      costed: true,
      costCents,
      netCents,
      lossCents,
      belowCost: lossCents > 0,
    };
  });

  return { lines: checked, totalLossCents };
}

/**
 * A line's cents as a per-unit figure for the sentence ("each costs 2,616.67"),
 * two places, half away from zero, as a decimal string. Only for showing: the
 * comparison is always on the line's own cents.
 */
export function unitFigure(cents: number, quantity: number | string): string {
  const qtyMilli = scaled(quantity, 3);
  if (qtyMilli === null || qtyMilli === ZERO) return '0.00';
  const perUnit = roundHalfAway(BigInt(cents) * THOUSAND, qtyMilli);
  return centsText(perUnit);
}

/** Cents as "1234.50". */
export function centsText(cents: number | bigint): string {
  const c = BigInt(cents);
  const sign = c < ZERO ? '-' : '';
  const abs = c < ZERO ? -c : c;
  return `${sign}${abs / HUNDRED}.${String(abs % HUNDRED).padStart(2, '0')}`;
}
