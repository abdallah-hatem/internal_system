/**
 * COPY of `apps/api/src/common/sale-totals.ts` — the formula the server stores.
 *
 * The order form shows a running total as lines are typed, and it must be the
 * figure the saved order will carry. Next cannot import across apps, so this is
 * a copy, and `sale-totals.test.ts` runs both files over the same grid of lines
 * and fails the moment they disagree. Change the API's file first, then this.
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
