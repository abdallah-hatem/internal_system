// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; a unit cost in EGP must not become a float
import { Prisma } from '@prisma/client';
import { badRequest } from '../../common/api-error';
import { formatMoney, formatQty } from '../../common/money';
import type { LoadedShipment } from '../../common/shipment-load';
import type { ShipmentPosition } from '../../common/shipment-position';
import { CostingService, lineEventCost } from './costing.service';

/**
 * Correcting a leg's cost after goods arrived, and re-costing the cycle with it
 * (BUSINESS_LOGIC §2, owner 2026-10-17: "per-product cost is very important").
 *
 * A leg's cost used to be fixed the moment anything of its cycle was received
 * or lost, and a late freight bill went in as a cycle expense: the cycle's
 * profit came out right, every product's landed cost and every sale's COGS
 * did not. Now, while nothing has happened that a re-cost would have to undo
 * or silently overwrite, the leg can be corrected and every batch, purchase
 * row, sale allocation and return of the cycle follows it.
 *
 * What still keeps the cost fixed, each with its own code:
 * - a settlement in draft, approved or paid, or a cycle being settled, closed
 *   or cancelled — the figures were agreed on the old cost;
 * - a loss — its cost was booked at the old unit and refunds may hang off it;
 * - a stock transfer still standing — the other cycle bought at the old unit;
 * - a batch not at the cost its line computes now — a figure typed at receipt,
 *   which a re-cost would erase;
 * - purchase rows that do not pair one-to-one with the batches.
 *
 * The arithmetic is `lineEventCost`, the receipt's own: each line's batches are
 * replayed in the order they were received, so the last carries the rounding
 * residual exactly as a fresh receipt would have given it (CLAUDE.md rule 11).
 */

type Db = Prisma.TransactionClient;
const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** Why a leg's cost cannot move now; null while it can. */
export type LegCostLockReason =
  | 'LEG_COST_LOCKED_SETTLEMENT'
  | 'LEG_COST_LOCKED_LOSSES'
  | 'LEG_COST_LOCKED_TRANSFERS'
  | 'LEG_COST_LOCKED_OVERRIDE'
  | 'LEG_COST_LOCKED_LEDGER'
  | 'LEG_COST_LOCKED';

export interface LegCostState {
  /** The cost fields may be changed. */
  editable: boolean;
  reason: LegCostLockReason | null;
  /** What the reason's sentence names (the cycle, the product). */
  params: Record<string, string>;
  /**
   * Something of the cycle was received: a change re-prices it, sold units
   * included. False while the cost moves freely, as it always did.
   */
  recosts: boolean;
}

/** One received batch of a line, with the purchase row it booked. */
interface BatchRow {
  id: string;
  receivedQty: Prisma.Decimal;
  landedUnitCostEgp: Prisma.Decimal;
  ledgerId: string;
  ledgerAmount: Prisma.Decimal;
}

interface LineBatches {
  purchaseOrderItemId: string;
  productName: string;
  orderedQty: Prisma.Decimal;
  /** In the order they were received. */
  batches: BatchRow[];
}

export interface RecostPlan {
  state: LegCostState;
  /** Filled only when the cost is editable and something was received. */
  lines: LineBatches[];
}

/** Statuses in which a cycle's figures are being, or have been, settled. */
const FINAL_STATUSES = ['SETTLEMENT', 'CLOSED', 'CANCELLED'];
/** A settlement in any of these holds figures computed on the current cost. */
const STANDING_SETTLEMENTS = ['DRAFT', 'APPROVED', 'PAID'] as const;

/**
 * Each line's batches costed in receipt order with the legs as they are in the
 * costing given — the replay `recost` writes and `planRecost` compares with.
 */
function replay(
  costing: Awaited<ReturnType<CostingService['computeCycleLandedCosts']>>,
  line: LineBatches,
) {
  const costed = costing.items.find(
    (i) => i.purchaseOrderItemId === line.purchaseOrderItemId,
  );
  if (!costed) return null;
  const prior: Prisma.Decimal[] = [];
  return line.batches.map((b) => {
    const event = lineEventCost({
      orderedQty: line.orderedQty,
      landedTotalEgp: costed.totalLandedCostEgp,
      unitCostEgp: costed.landedUnitCostEgp,
      priorReceivedQtys: [...prior],
      // No losses: a cycle with one is not re-costed.
      priorLosses: [],
      qty: b.receivedQty,
    });
    prior.push(b.receivedQty);
    return { batch: b, unit: event.unitCostEgp, cost: event.costEgp };
  });
}

const locked = (
  reason: LegCostLockReason,
  params: Record<string, string>,
): RecostPlan => ({
  state: { editable: false, reason, params, recosts: false },
  lines: [],
});

/**
 * Whether the cost of this cycle's legs may change now, and — when it may and
 * something was received — every batch a change would re-cost, with its
 * purchase row. Reads only; call it under `lockCycle` before writing.
 */
export async function planRecost(
  db: Pick<
    Db,
    | 'settlement'
    | 'stockTransfer'
    | 'inventoryBatch'
    | 'inventoryMovement'
    | 'financialTransaction'
    | 'importCycle'
  >,
  costing: CostingService,
  cycle: LoadedShipment,
  position: ShipmentPosition,
): Promise<RecostPlan> {
  const { received, lost } = position.totals;
  // Nothing received or lost: the cost moves freely, as it always did (§2).
  if (received <= 0 && lost <= 0) {
    return {
      state: { editable: true, reason: null, params: {}, recosts: false },
      lines: [],
    };
  }
  const params = { cycle: cycle.code };

  const settlement = await db.settlement.findFirst({
    where: { cycleId: cycle.id, status: { in: [...STANDING_SETTLEMENTS] } },
  });
  if (settlement || FINAL_STATUSES.includes(cycle.status)) {
    return locked('LEG_COST_LOCKED_SETTLEMENT', params);
  }

  if (lost > 0 || cycle.shippingLegs.some((l) => l.losses.length > 0)) {
    return locked('LEG_COST_LOCKED_LOSSES', params);
  }

  const transfers = await db.stockTransfer.findMany({
    where: {
      status: 'ACTIVE',
      OR: [{ fromCycleId: cycle.id }, { toCycleId: cycle.id }],
    },
  });
  if (transfers.some((t) => t.status === 'ACTIVE')) {
    return locked('LEG_COST_LOCKED_TRANSFERS', params);
  }

  const batches = await db.inventoryBatch.findMany({
    where: { cycleId: cycle.id },
  });
  const orderLines = new Map(
    cycle.purchaseOrders.flatMap((po) => po.items.map((i) => [i.id, i])),
  );
  // Stock that did not come from one of this cycle's order lines has no cost
  // the legs decide; re-costing around it is not something to guess at.
  if (
    batches.some(
      (b) =>
        !b.sourcePoItemId ||
        b.transferredFromBatchId ||
        !orderLines.has(b.sourcePoItemId),
    )
  ) {
    return locked('LEG_COST_LOCKED', params);
  }

  // Receipt order: when each batch's receipt was written. A batch's
  // `createdAt` is the day it was counted in (§3, 2026-10-16), which a
  // back-dated receipt puts before an earlier one; the RECEIVE movement is
  // written with the receipt, so it keeps the order the receipts happened in.
  const movements = await db.inventoryMovement.findMany({
    where: {
      batchId: { in: batches.map((b) => b.id) },
      movementType: 'RECEIVE',
    },
    select: { batchId: true, occurredAt: true },
  });
  const receivedAt = new Map(
    movements.map((m) => [m.batchId, m.occurredAt.getTime()]),
  );
  const order = (b: (typeof batches)[number]) =>
    receivedAt.get(b.id) ?? b.createdAt.getTime();
  batches.sort(
    (a, b) =>
      order(a) - order(b) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : 1),
  );

  // The purchase rows a receipt books, one per batch, oldest first.
  const ledger = (
    await db.financialTransaction.findMany({
      where: { cycleId: cycle.id, relatedType: 'PURCHASE_ORDER_ITEM' },
    })
  )
    .filter((t) => t.type === 'PURCHASE_COST' && !t.reversalOfId)
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
    );

  const current = await costing.computeCycleLandedCosts(cycle.id, { db });
  const lines: LineBatches[] = [];
  for (const [poItemId, item] of orderLines) {
    const own = batches.filter((b) => b.sourcePoItemId === poItemId);
    const rows = ledger.filter((t) => t.relatedId === poItemId);
    if (own.length === 0 && rows.length === 0) continue;
    const product = item.product.name;
    if (own.length !== rows.length) {
      return locked('LEG_COST_LOCKED_LEDGER', { ...params, product });
    }
    const line: LineBatches = {
      purchaseOrderItemId: poItemId,
      productName: product,
      orderedQty: D(item.orderedQty),
      batches: own.map((b, i) => ({
        id: b.id,
        receivedQty: D(b.receivedQty),
        landedUnitCostEgp: D(b.landedUnitCostEgp),
        ledgerId: rows[i].id,
        ledgerAmount: D(rows[i].amount),
      })),
    };
    const costed = replay(current, line);
    if (!costed) return locked('LEG_COST_LOCKED', params);
    for (const c of costed) {
      // Not what the legs give today: a figure typed at receipt (§2), which
      // re-costing would silently replace.
      if (!c.batch.landedUnitCostEgp.toDecimalPlaces(4).equals(c.unit)) {
        return locked('LEG_COST_LOCKED_OVERRIDE', { ...params, product });
      }
      if (!c.batch.ledgerAmount.equals(c.cost)) {
        return locked('LEG_COST_LOCKED_LEDGER', { ...params, product });
      }
    }
    lines.push(line);
  }

  return {
    state: { editable: true, reason: null, params: {}, recosts: true },
    lines,
  };
}

/**
 * Refuse a cost change for the reason given — each code thrown by name, so the
 * client and the translation check (`41-error-messages`) both see it.
 */
export function refuseCostChange(
  reason: LegCostLockReason,
  params: Record<string, string>,
  leg: string,
): never {
  const cycle = params.cycle ?? '';
  const values = { ...params, leg };
  switch (reason) {
    case 'LEG_COST_LOCKED_SETTLEMENT':
      throw badRequest(
        'LEG_COST_LOCKED_SETTLEMENT',
        `Cycle ${cycle} has a settlement, or is being settled, closed or cancelled, so the cost of ${leg} cannot be recalculated. Record a late or corrected charge as a cycle expense.`,
        values,
      );
    case 'LEG_COST_LOCKED_LOSSES':
      throw badRequest(
        'LEG_COST_LOCKED_LOSSES',
        `Goods of cycle ${cycle} were marked lost at the current cost, so the cost of ${leg} cannot be recalculated. Record a late or corrected charge as a cycle expense.`,
        values,
      );
    case 'LEG_COST_LOCKED_TRANSFERS':
      throw badRequest(
        'LEG_COST_LOCKED_TRANSFERS',
        `Stock was moved into or out of cycle ${cycle} at the current cost, so the cost of ${leg} cannot be recalculated. Record a late or corrected charge as a cycle expense.`,
        values,
      );
    case 'LEG_COST_LOCKED_OVERRIDE':
      throw badRequest(
        'LEG_COST_LOCKED_OVERRIDE',
        `${params.product ?? ''} of cycle ${cycle} was received at a cost entered by hand, which recalculating would replace, so the cost of ${leg} cannot change. Record a late or corrected charge as a cycle expense.`,
        values,
      );
    case 'LEG_COST_LOCKED_LEDGER':
      throw badRequest(
        'LEG_COST_LOCKED_LEDGER',
        `The purchase entries of ${params.product ?? ''} in cycle ${cycle} do not match its received batches, so the cost of ${leg} cannot be recalculated. Record a late or corrected charge as a cycle expense.`,
        values,
      );
    default:
      throw badRequest(
        'LEG_COST_LOCKED',
        `Goods of cycle ${cycle} have already been received or marked lost, so the cost of ${leg} is fixed. Record a late or corrected charge as a cycle expense.`,
        values,
      );
  }
}

/** One batch's cost before and after, for the audit entry. */
export interface BatchRecost {
  batchId: string;
  product: string;
  receivedQty: string;
  oldUnitCostEgp: string;
  newUnitCostEgp: string;
}

/**
 * Write the cost the legs give NOW — call it inside the leg update's
 * transaction, after the leg is saved — onto every batch `plan` lists, its
 * purchase row, the sale allocations drawn from it and the returns of those.
 *
 * The batch is updated first: a sale confirming at the same moment holds that
 * row until it commits, so the allocations read afterwards include its own.
 */
export async function recost(
  tx: Db,
  costing: CostingService,
  cycleId: string,
  plan: RecostPlan,
): Promise<BatchRecost[]> {
  const after = await costing.computeCycleLandedCosts(cycleId, { db: tx });
  const changes: BatchRecost[] = [];
  const returns = new Set<string>();

  for (const line of plan.lines) {
    const costed = replay(after, line);
    if (!costed) {
      throw badRequest(
        'NO_LANDED_COST',
        `Could not determine landed unit cost for purchase order item ${line.purchaseOrderItemId}`,
      );
    }
    for (const { batch, unit, cost } of costed) {
      changes.push({
        batchId: batch.id,
        product: line.productName,
        receivedQty: batch.receivedQty.toString(),
        oldUnitCostEgp: batch.landedUnitCostEgp.toFixed(4),
        newUnitCostEgp: unit.toFixed(4),
      });

      await tx.inventoryBatch.update({
        where: { id: batch.id },
        data: { landedUnitCostEgp: unit, version: { increment: 1 } },
      });
      // The receipt's own wording, with the unit it now books.
      await tx.financialTransaction.update({
        where: { id: batch.ledgerId },
        data: {
          amount: cost,
          reason: `Auto: ${formatQty(batch.receivedQty)} units received at ${formatMoney(unit)} EGP/unit landed`,
        },
      });

      const allocations = await tx.saleItemAllocation.findMany({
        where: { inventoryBatchId: batch.id },
        select: { id: true, qty: true },
      });
      for (const a of allocations) {
        await tx.saleItemAllocation.update({
          where: { id: a.id },
          data: { unitCostEgp: unit, cogsEgp: money(D(a.qty).mul(unit)) },
        });
      }

      const returned = await tx.saleReturnItem.findMany({
        where: { inventoryBatchId: batch.id },
        select: { id: true, qty: true, restocked: true, saleReturnId: true },
      });
      for (const r of returned) {
        await tx.saleReturnItem.update({
          where: { id: r.id },
          data: {
            unitCostEgp: unit,
            cogsReversedEgp: r.restocked ? money(D(r.qty).mul(unit)) : D(0),
          },
        });
        returns.add(r.saleReturnId);
      }
    }
  }

  // A return's header is what its restocked lines put back, summed as the
  // return itself sums it: unrounded, then to the piastre.
  for (const id of returns) {
    const items = await tx.saleReturnItem.findMany({
      where: { saleReturnId: id },
      select: { qty: true, unitCostEgp: true, restocked: true },
    });
    const cogs = items
      .filter((i) => i.restocked)
      .reduce((s, i) => s.add(D(i.unitCostEgp).mul(D(i.qty))), D(0));
    await tx.saleReturn.update({
      where: { id },
      data: { cogsReversedEgp: money(cogs) },
    });
  }

  return changes;
}
