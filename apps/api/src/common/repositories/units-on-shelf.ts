import { Prisma } from '@prisma/client';

/**
 * Units in stock: every batch's remaining quantity, summed — the units on the
 * shelf, the same "stock on hand" the low-stock rule counts (§3,
 * `low-stock.ts`). The one definition behind the dashboard's Units in stock,
 * the Inventory tab's card and the Products tab's cards (CLAUDE.md §11).
 *
 * - A sample out at a shop has left the shelf: drawing it lowered its batch's
 *   remaining quantity, so it is not counted (GUESS, as the existing card).
 * - A unit held for a customer is still on the shelf, so it is counted
 *   (`remainingQty`, not `saleableQty`; nothing holds stock today, §3).
 *
 * `products` narrows it to the products a list's filters match (the Products
 * tab, `productListWhere`); left out, it is every product. Summed by the
 * database, so it is the whole set, never a page of it (LEARNINGS).
 */
export async function unitsOnShelf(
  db: Pick<Prisma.TransactionClient, 'inventoryBatch'>,
  products?: Prisma.ProductWhereInput,
): Promise<number> {
  const { _sum } = await db.inventoryBatch.aggregate({
    where: products ? { product: products } : {},
    _sum: { remainingQty: true },
  });
  return Number(
    (_sum.remainingQty ?? new Prisma.Decimal(0)).toDecimalPlaces(2),
  );
}
