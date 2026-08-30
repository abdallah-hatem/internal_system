import { Prisma } from '@prisma/client';

/**
 * What can actually be sold right now.
 *
 * One definition, because three screens ask the question and they must not
 * answer it differently: the public catalogue tells a shop whether to bother
 * asking, the internal inventory page tells the office what is on the shelf,
 * and `sales.create` decides whether an order may exist at all. A storefront
 * that counts a held unit as available promises stock the office has already
 * committed, and the shop finds out at approval — which is the shape of the
 * `CAPITALISED_CATEGORIES` drift in `CLAUDE.md` rule 11, one screen right and
 * another wrong, looked for in the wrong place because it reads as a display
 * bug.
 *
 *     available = saleable across verified batches − units held by live requests
 *
 * `saleableQty` alone was correct while `InventoryReservation` sat unused. It
 * stops being correct the moment an order request can hold stock, and the
 * whole point of putting it here is that it stops being correct in one place.
 */

/** Anything that can run these queries — the client or a transaction. */
type Db = Pick<Prisma.TransactionClient, 'inventoryBatch' | 'inventoryReservation'>;

const zero = () => new Prisma.Decimal(0);

/**
 * Units of one product a customer could be given today.
 *
 * `exclude` leaves one request's own hold out of the subtraction, which is what
 * approving needs: the units it is about to consume are held by the very
 * request being approved, and counting them against itself would refuse every
 * approval of a fully-held request.
 */
export async function availableQty(
  db: Db,
  productId: string,
  exclude?: { orderRequestId?: string; saleOrderId?: string },
): Promise<Prisma.Decimal> {
  const byProduct = await availableByProduct(db, [productId], exclude);
  return byProduct.get(productId) ?? zero();
}

/**
 * The same answer for many products at once.
 *
 * The catalogue renders a page of products and asking per product would be one
 * round trip each — the reason this exists rather than a loop over the single
 * form.
 */
export async function availableByProduct(
  db: Db,
  productIds: string[],
  exclude?: { orderRequestId?: string; saleOrderId?: string },
): Promise<Map<string, Prisma.Decimal>> {
  const result = new Map<string, Prisma.Decimal>();
  if (productIds.length === 0) return result;

  // Only verified batches. Stock that has arrived but not been checked is not
  // on the shelf, and the catalogue must not offer it.
  const batches = await db.inventoryBatch.groupBy({
    by: ['productId'],
    where: { productId: { in: productIds }, verificationStatus: 'VERIFIED' },
    _sum: { saleableQty: true },
  });
  for (const row of batches) {
    result.set(row.productId, new Prisma.Decimal(row._sum.saleableQty ?? 0));
  }

  // Live holds, taken off the top. A hold whose clock has run out is not live
  // even if the sweeper has not reached it yet — the deadline is what the shop
  // was told, so the deadline is what counts, not how promptly a job ran.
  const held = await db.inventoryReservation.findMany({
    where: {
      status: 'ACTIVE',
      batch: { productId: { in: productIds }, verificationStatus: 'VERIFIED' },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      ...(exclude?.orderRequestId ? { orderRequestId: { not: exclude.orderRequestId } } : {}),
      ...(exclude?.saleOrderId ? { saleOrderId: { not: exclude.saleOrderId } } : {}),
    },
    select: { qty: true, batch: { select: { productId: true } } },
  });

  for (const hold of held) {
    const id = hold.batch.productId;
    result.set(id, (result.get(id) ?? zero()).sub(hold.qty));
  }

  // A negative can only mean holds outlived the stock behind them — a batch
  // written down after a hold was taken. Zero is the honest answer to "how
  // many can I have"; the discrepancy is a data problem for check-data.sh,
  // not something to report as a negative quantity on a product card.
  for (const [id, qty] of result) {
    if (qty.lt(0)) result.set(id, zero());
  }

  return result;
}

/**
 * The band a customer sees.
 *
 * Never a count. A public page saying "12 left" tells a competitor the exact
 * position, and a shop does not need the number to decide whether to ask —
 * only whether it is worth asking.
 */
export type StockBand = 'IN_STOCK' | 'LOW' | 'OUT';

export function stockBand(available: Prisma.Decimal, lowAt = 5): StockBand {
  if (available.lte(0)) return 'OUT';
  return available.lte(lowAt) ? 'LOW' : 'IN_STOCK';
}
