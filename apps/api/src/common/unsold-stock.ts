// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; stock value in EGP must not become a float
import { Prisma } from '@prisma/client';

/**
 * What a cycle still holds on its shelves, and what it cost: every batch's
 * remaining units at its landed cost (§8, "unsold stock keeps its cost with
 * the cycle").
 *
 * Read by the settlement projection, by paying a settlement out (the "still
 * holds N units" refusal) and by a stock transfer refreshing an open
 * settlement — one definition, so leftovers moved out after a settlement was
 * approved are seen by the payout and not only by the next calculation (L5,
 * rule 11).
 */
export async function unsoldStock(
  db: {
    inventoryBatch: Pick<
      Prisma.TransactionClient['inventoryBatch'],
      'findMany'
    >;
  },
  cycleId: string,
) {
  const batches = await db.inventoryBatch.findMany({
    where: { cycleId },
    select: { remainingQty: true, landedUnitCostEgp: true },
  });
  const unitsRemaining = batches.reduce(
    (s, b) => s.add(b.remainingQty),
    new Prisma.Decimal(0),
  );
  const unsoldValue = batches.reduce(
    (s, b) =>
      s.add(new Prisma.Decimal(b.remainingQty).mul(b.landedUnitCostEgp)),
    new Prisma.Decimal(0),
  );
  return { unitsRemaining, unsoldValue };
}

/**
 * Put a cycle's live unsold figures on its open (draft or approved)
 * settlement. A transfer moves units out of one cycle and into another; the
 * profit and the payouts do not change (§8), but the "still holds" figures the
 * settlement shows would otherwise describe stock that has left.
 */
export async function refreshOpenSettlementStock(
  db: {
    inventoryBatch: Pick<
      Prisma.TransactionClient['inventoryBatch'],
      'findMany'
    >;
    settlement: Pick<
      Prisma.TransactionClient['settlement'],
      'findMany' | 'update'
    >;
  },
  cycleId: string,
) {
  const open = await db.settlement.findMany({
    where: { cycleId, status: { in: ['DRAFT', 'APPROVED'] } },
    select: { id: true },
  });
  if (open.length === 0) return;
  const { unitsRemaining, unsoldValue } = await unsoldStock(db, cycleId);
  for (const s of open) {
    await db.settlement.update({
      where: { id: s.id },
      data: {
        unitsRemaining,
        unsoldValueEgp: unsoldValue.toDecimalPlaces(
          2,
          Prisma.Decimal.ROUND_HALF_UP,
        ),
      },
    });
  }
}
