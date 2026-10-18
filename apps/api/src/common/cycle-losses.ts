// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; a loss in EGP must not become a float
import { Prisma } from '@prisma/client';

/**
 * The losses `cycleLossesEgp` sums, as a filter: one definition for the sum
 * and for Analytics' profit and loss, which reads the same rows one by one to
 * put each on its day (2026-10-18).
 */
export function shipmentLossWhere(
  cycleId: string | null,
  markedAt?: { gte?: Date; lt?: Date },
): Prisma.ShipmentLossWhereInput {
  return {
    ...(cycleId === null ? {} : { leg: { cycleId } }),
    ...(markedAt ? { createdAt: markedAt } : {}),
  };
}

/** The allocations `samplesWrittenOffEgp` sums, as a filter (as above). */
export function samplesWrittenOffWhere(
  cycleId: string | null,
  decidedAt?: { gte?: Date; lt?: Date },
): Prisma.SaleItemAllocationWhereInput {
  return {
    ...(cycleId === null ? {} : { inventoryBatch: { cycleId } }),
    saleItem: {
      saleOrder: {
        status: 'SAMPLES_WRITTEN_OFF',
        ...(decidedAt ? { samplesDecidedAt: decidedAt } : {}),
      },
    },
  };
}

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
    where: shipmentLossWhere(cycleId, markedAt),
    _sum: { costEgp: true },
  });
  return new Prisma.Decimal(_sum.costEgp ?? 0);
}

/**
 * What samples the shops kept or lost cost, in EGP (BUSINESS_LOGIC §4,
 * "Samples at shops", 2026-10-18): the landed cost on the allocations of every
 * samples order written off, charged to the cycle each batch came from.
 *
 * The same kind of figure as goods lost on the way — goods the cycle paid for
 * that will never sell — and read the same way: no money moves when samples
 * are written off (the cash left when they were bought), so it is not a ledger
 * row and every profit figure subtracts it on purpose. It is NOT a ledger
 * expense, NOT a cost of goods sold (nothing was sold, so it is in neither
 * COGS nor revenue), and NOT a cost recovery.
 *
 * Its day is the day the write-off was recorded (`samplesDecidedAt`).
 * `cycleId` null is every cycle at once — the dashboard's and the P&L's.
 */
export async function samplesWrittenOffEgp(
  db: {
    saleItemAllocation: Pick<
      Prisma.TransactionClient['saleItemAllocation'],
      'aggregate'
    >;
  },
  cycleId: string | null,
  decidedAt?: { gte?: Date; lt?: Date },
): Promise<Prisma.Decimal> {
  const { _sum } = await db.saleItemAllocation.aggregate({
    where: samplesWrittenOffWhere(cycleId, decidedAt),
    _sum: { cogsEgp: true },
  });
  return new Prisma.Decimal(_sum?.cogsEgp ?? 0);
}

/**
 * Everything a cycle wrote off — goods lost on the way and samples written
 * off — apart and together. Settlement, the dashboard, the P&L and the cycle
 * comparison all subtract `total`; the parts are what the payout's lines and
 * the P&L's expense lines show.
 */
export async function cycleWriteOffsEgp(
  db: Parameters<typeof cycleLossesEgp>[0] &
    Parameters<typeof samplesWrittenOffEgp>[0],
  cycleId: string | null,
  window?: { gte?: Date; lt?: Date },
) {
  const lostOnTheWay = await cycleLossesEgp(db, cycleId, window);
  const samplesWrittenOff = await samplesWrittenOffEgp(db, cycleId, window);
  return {
    lostOnTheWay,
    samplesWrittenOff,
    total: lostOnTheWay.add(samplesWrittenOff),
  };
}
