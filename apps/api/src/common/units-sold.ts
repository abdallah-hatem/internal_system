// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; quantities must not become floats
import { Prisma } from '@prisma/client';

/**
 * Sale states whose goods have left the business, so the sale counts whether
 * or not the customer has finished paying.
 *
 * Draft and cancelled orders must never be counted — a draft is a quote that
 * has reserved nothing, and including them inflates every figure. Samples
 * still at a shop (SAMPLES) are not sold either; "They're buying" turns the
 * order CONFIRMED in place, and from then on it counts. A fully returned order
 * (RETURNED) nets to nothing, so leaving it out changes no total.
 */
export const REALISED_SALE_STATUSES = [
  'CONFIRMED',
  'PARTIALLY_PAID',
  'PAID',
] as const;

/** The sale lines whose units count as sold: on a realised order. */
export const SOLD_LINE_WHERE = {
  saleOrder: { status: { in: [...REALISED_SALE_STATUSES] } },
} satisfies Prisma.SaleItemWhereInput;

type Qty = Prisma.Decimal.Value;

/** A sale line as the units-sold count reads it. */
export interface SoldLine {
  quantity: Qty;
  returnItems: readonly { qty: Qty }[];
}

const D = (v: Qty) => new Prisma.Decimal(v);

/** One line's units still sold: what went out less what came back. */
export function lineUnitsSold(line: SoldLine): Prisma.Decimal {
  return line.returnItems.reduce((s, r) => s.sub(D(r.qty)), D(line.quantity));
}

/**
 * Units sold, net of returns (BUSINESS_LOGIC §3, owner 2026-10-26): the lines
 * of realised sales (`SOLD_LINE_WHERE`), each less the units handed back on a
 * credit note or for cash. A price lowered after the sale changes what the
 * units brought in, not how many there were, so it is not read here.
 *
 * One definition (CLAUDE.md §11) for the analytics top products and a product
 * page's Units sold card, so the two never disagree about the same product.
 */
export function netUnitsSold(lines: readonly SoldLine[]): Prisma.Decimal {
  return lines.reduce((sum, l) => sum.add(lineUnitsSold(l)), D(0));
}

/** For a response: to the thousandth, the column's own places. */
export function unitsFigure(units: Prisma.Decimal): number {
  return Number(units.toDecimalPlaces(3));
}
