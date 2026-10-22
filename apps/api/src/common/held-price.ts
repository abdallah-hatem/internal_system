// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';

/**
 * What a sale line's units the shop still holds are priced at, and where they
 * came from (BUSINESS_LOGIC §4, "Lowering a price after the order is
 * confirmed", owner 2026-10-22).
 *
 * One definition for the price adjustment, which lowers it, and the return,
 * which refunds at it: a unit handed back after its price was lowered is
 * refunded at the lower price, never the one it was first sold at.
 */

const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);

export interface HeldLine {
  quantity: Prisma.Decimal.Value;
  lineTotal: Prisma.Decimal.Value;
  returnItems: { qty: Prisma.Decimal.Value; inventoryBatchId: string }[];
  allocations?: {
    inventoryBatchId: string;
    qty: Prisma.Decimal.Value;
    createdAt: Date;
  }[];
  priceAdjustments?: {
    newUnitPrice: Prisma.Decimal.Value;
    createdAt: Date;
  }[];
}

/**
 * The price per unit of what the shop holds now: the last adjustment's new
 * price, or — never adjusted — the line's total over its quantity, so a line
 * discount stays in the same proportion it was given.
 */
export function heldUnitPrice(line: HeldLine): Prisma.Decimal {
  const last = [...(line.priceAdjustments ?? [])].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0];
  if (last) return D(last.newUnitPrice);
  const sold = D(line.quantity);
  return sold.gt(0) ? D(line.lineTotal).div(sold) : D(0);
}

/** Units the shop still holds on the line: sold less returned. */
export function heldUnits(line: HeldLine): Prisma.Decimal {
  return line.returnItems.reduce((s, r) => s.sub(D(r.qty)), D(line.quantity));
}

/**
 * The held units per batch they were drawn from: each allocation less what
 * came back to that batch. Oldest allocation first, as they were sold.
 */
export function heldByBatch(
  line: HeldLine,
): { inventoryBatchId: string; qty: Prisma.Decimal }[] {
  const byBatch = new Map<string, Prisma.Decimal>();
  for (const a of [...(line.allocations ?? [])].sort(
    (x, y) => x.createdAt.getTime() - y.createdAt.getTime(),
  )) {
    byBatch.set(
      a.inventoryBatchId,
      (byBatch.get(a.inventoryBatchId) ?? D(0)).add(D(a.qty)),
    );
  }
  for (const r of line.returnItems) {
    const held = byBatch.get(r.inventoryBatchId);
    if (held) byBatch.set(r.inventoryBatchId, held.sub(D(r.qty)));
  }
  return [...byBatch]
    .map(([inventoryBatchId, qty]) => ({ inventoryBatchId, qty }))
    .filter((b) => b.qty.gt(0));
}
