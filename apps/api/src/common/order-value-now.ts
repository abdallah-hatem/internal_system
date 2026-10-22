// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { heldUnitPrice, heldUnits, type HeldLine } from './held-price';

/**
 * What a sale order is worth now (BUSINESS_LOGIC §4, owner 2026-10-22,
 * "Option A"): what was sold, less what came back at the price it was
 * refunded at, less every price cut.
 *
 *     line now  = line total − Σ refunds on the line − Σ cuts on the line
 *     order now = order total − Σ refunds − Σ cuts
 *
 * Read from the stored figures the order's outstanding was moved by — each
 * return line's `refundEgp`, each adjustment's `amountEgp` — never re-priced,
 * so for an order still owed it always holds that
 *
 *     value now − payments standing + cash refunded = outstanding
 *
 * (a credit note lowers what is owed; a cash refund hands the money back
 * instead, so the order still owes what it did and the shop holds the cash).
 * A line's units held, and the price they are at, come from `held-price.ts`,
 * the definition the adjustment and the return already share.
 *
 * One definition for every screen that shows an order's total: the Sales
 * list, the order popup, a customer's orders. The order's own `total` stays
 * what was sold and is shown beneath when the two differ.
 */

const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);

/**
 * What a sale line must be loaded with to say what it is worth now. Spread
 * into a `saleItem` include; Prisma loads each relation in one query for the
 * whole page of orders, not one per row.
 */
export const VALUE_NOW_ITEM_INCLUDE = {
  returnItems: {
    select: { qty: true, refundEgp: true, inventoryBatchId: true },
  },
  priceAdjustments: {
    select: { newUnitPrice: true, createdAt: true, amountEgp: true },
  },
} as const;

export interface ValueNowLine extends HeldLine {
  quantity: Prisma.Decimal.Value;
  lineTotal: Prisma.Decimal.Value;
  returnItems: {
    qty: Prisma.Decimal.Value;
    refundEgp: Prisma.Decimal.Value;
    inventoryBatchId: string;
  }[];
  priceAdjustments: {
    newUnitPrice: Prisma.Decimal.Value;
    createdAt: Date;
    amountEgp: Prisma.Decimal.Value;
  }[];
}

export interface LineValueNow {
  /** Units sent back, every return counted. */
  returnedQty: string;
  /** Units the shop still holds: sold less returned. */
  heldQty: string;
  /** The price per unit it was sold at, after the line's discount. */
  soldUnitPrice: string;
  /** The price per unit of what it holds now: the last cut's, or as sold. */
  unitPriceNow: string;
  /** Whether a price cut was ever recorded on the line. */
  priceCut: boolean;
  /** What the line is worth now: held units at their price; nothing for returned ones. */
  lineValueNow: string;
}

function lineTakenOff(line: ValueNowLine) {
  const refunded = line.returnItems.reduce(
    (s, r) => s.add(D(r.refundEgp)),
    D(0),
  );
  return line.priceAdjustments.reduce(
    (s, a) => s.add(D(a.amountEgp)),
    refunded,
  );
}

export function lineValueNow(line: ValueNowLine): LineValueNow {
  const sold = D(line.quantity);
  const held = heldUnits(line);
  return {
    returnedQty: sold.sub(held).toString(),
    heldQty: held.toString(),
    soldUnitPrice: (sold.gt(0) ? D(line.lineTotal).div(sold) : D(0)).toFixed(2),
    unitPriceNow: heldUnitPrice(line).toFixed(2),
    priceCut: line.priceAdjustments.length > 0,
    lineValueNow: D(line.lineTotal).sub(lineTakenOff(line)).toFixed(2),
  };
}

/** The order's value now, to the cent, as a decimal string. */
export function orderValueNow(order: {
  total: Prisma.Decimal.Value;
  items: ValueNowLine[];
}): string {
  return order.items
    .reduce((s, i) => s.sub(lineTakenOff(i)), D(order.total))
    .toFixed(2);
}

/**
 * The order as loaded, with `valueNowEgp` on it and each line's figures on
 * the line. The return lines and adjustments it was worked out from are left
 * off: the order's History is where they are read.
 */
export function withValueNow<
  L extends ValueNowLine,
  O extends { total: Prisma.Decimal.Value; items: L[] },
>(order: O) {
  return {
    ...order,
    valueNowEgp: orderValueNow(order),
    items: order.items.map((item) => {
      const { returnItems: _r, priceAdjustments: _p, ...rest } = item;
      return { ...rest, ...lineValueNow(item) };
    }),
  };
}
