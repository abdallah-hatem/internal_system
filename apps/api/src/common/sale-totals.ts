/**
 * What a sale line and a sale order come to — the one formula.
 *
 *     gross      = quantity × unit price, rounded to the cent
 *     line total = gross − discount         (a discount may not exceed gross)
 *     order      = Σ line totals
 *
 * The sales service stores these figures, and the order form shows them as
 * they are typed. Both must say the same thing, or the screen promises one
 * total and the saved order carries another. The web app keeps a copy of this
 * file at `apps/web/src/lib/sale-totals.ts` (Next cannot import across apps),
 * and `sale-totals.test.ts` there runs both over the same grid of lines and
 * fails if they ever disagree. Change this one, then that one.
 *
 * Pure and dependency-free on purpose, so the copy is a copy and not a port.
 * Arithmetic is in integers — thousandths of a unit, cents of a price — so no
 * float drift reaches a stored amount (BUSINESS_LOGIC §11). Quantities carry
 * at most three decimals and prices two, as the columns do.
 */

export interface SaleLineInput {
  quantity: number | string;
  unitPrice: number | string;
  discount?: number | string | null;
}

export interface SaleLineTotals {
  grossCents: number;
  discountCents: number;
  lineTotalCents: number;
}

export interface SaleOrderTotals {
  lines: SaleLineTotals[];
  subtotalCents: number;
}

/** Round half away from zero, which is what Postgres does to a NUMERIC. */
function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

function scaled(
  value: number | string | null | undefined,
  places: number,
): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  // toFixed first: 1.255 × 1000 is 1254.9999999999998 in binary, and rounding
  // that straight would lose a unit the person typed.
  return roundHalfAway(Number((n * 10 ** places).toFixed(6)));
}

export function saleLineTotals(line: SaleLineInput): SaleLineTotals {
  const qtyMilli = scaled(line.quantity, 3);
  const priceCents = scaled(line.unitPrice, 2);
  // qty (×1000) × price (×100) is in hundred-thousandths; back to cents.
  const grossCents = roundHalfAway((qtyMilli * priceCents) / 1000);
  const discountCents = scaled(line.discount, 2);
  return {
    grossCents,
    discountCents,
    lineTotalCents: grossCents - discountCents,
  };
}

export function saleOrderTotals(lines: SaleLineInput[]): SaleOrderTotals {
  const totals = lines.map(saleLineTotals);
  return {
    lines: totals,
    subtotalCents: totals.reduce((sum, l) => sum + l.lineTotalCents, 0),
  };
}

/** Cents as the decimal string a NUMERIC(18,2) column takes, e.g. "1234.50". */
export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
