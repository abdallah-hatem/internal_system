// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; a loss in EGP must not become a float
import { Prisma } from '@prisma/client';

/**
 * What a cycle lost on the way, in EGP (BUSINESS_LOGIC §2, §8, §9 — 2026-10-10).
 *
 * Goods marked lost are a loss against the cycle's profit, but no money moves
 * when they are marked — the cash left when they were bought — so a loss is
 * its own record (`ShipmentLoss`), never a ledger row. That means neither
 * settlement nor analytics sees it by reading the ledger, and both have to
 * subtract it on purpose.
 *
 * This is the one definition they both read (CLAUDE.md rule 11). Two copies
 * would drift the first time one changed, and the drift would show up as a
 * settlement and a dashboard disagreeing about the same cycle's profit.
 *
 * The backfill's losses are recorded at zero cost (their cost was already
 * spread over the batches, §1), so they add nothing here, as intended.
 *
 * `cycleId` null is every cycle at once — the dashboard's net profit, which
 * is the business's, not one cycle's, and must subtract the same figure.
 */
export async function cycleLossesEgp(
  db: {
    shipmentLoss: Pick<Prisma.TransactionClient['shipmentLoss'], 'aggregate'>;
  },
  cycleId: string | null,
  /**
   * Only losses marked in this window (Analytics' profit and loss, 2026-10-18):
   * a loss has no date but the moment it was marked, so that is its day.
   */
  markedAt?: { gte?: Date; lt?: Date },
): Promise<Prisma.Decimal> {
  const { _sum } = await db.shipmentLoss.aggregate({
    where: {
      ...(cycleId === null ? {} : { leg: { cycleId } }),
      ...(markedAt ? { createdAt: markedAt } : {}),
    },
    _sum: { costEgp: true },
  });
  return new Prisma.Decimal(_sum.costEgp ?? 0);
}
