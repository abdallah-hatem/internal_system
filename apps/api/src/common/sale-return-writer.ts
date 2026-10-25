// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal and the refund method are values, not data access
import { Prisma, RefundMethod } from '@prisma/client';
import { nextReferenceNumber, pad } from './references';

/**
 * Units handed back on a sale (BUSINESS_LOGIC §5) — the one definition of
 * which batches they go back to and what that writes. A return the shop makes
 * (`ReturnsService`) and units given back by an order edit (§4 "Editing a
 * confirmed order", 2026-10-25) both come through here, so an edit lowering a
 * quantity puts stock and cost back exactly as a return does.
 */

const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export interface TraceableLine {
  id: string;
  returnItems: { qty: Prisma.Decimal.Value; inventoryBatchId: string }[];
  allocations: {
    inventoryBatchId: string;
    qty: Prisma.Decimal.Value;
    unitCostEgp: Prisma.Decimal.Value;
    createdAt: Date;
  }[];
}

export interface ReturnLine {
  saleItemId: string;
  batchId: string;
  qty: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  restock: boolean;
}

/**
 * Which batches `wanted` units of a line come back to: the most recently
 * allocated batch first — the last units to leave are the ones handed back —
 * each at the cost it left at. `untraced` is what could not be matched to a
 * batch (more than the line still holds there).
 */
export function traceBack(
  line: TraceableLine,
  wanted: Prisma.Decimal,
  unitPrice: Prisma.Decimal,
  restock = true,
): { lines: ReturnLine[]; untraced: Prisma.Decimal } {
  const lines: ReturnLine[] = [];
  let outstanding = wanted;
  const allocations = [...line.allocations].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
  // Units already back per batch, spent as they are matched, so a batch drawn
  // twice for the line is not counted as emptied twice.
  const back = new Map<string, Prisma.Decimal>();
  for (const r of line.returnItems) {
    back.set(
      r.inventoryBatchId,
      (back.get(r.inventoryBatchId) ?? D(0)).add(D(r.qty)),
    );
  }
  for (const alloc of allocations) {
    if (outstanding.lte(0)) break;
    const takenBack = back.get(alloc.inventoryBatchId) ?? D(0);
    const fromHere = D(alloc.qty);
    const used = Prisma.Decimal.min(takenBack, fromHere);
    back.set(alloc.inventoryBatchId, takenBack.sub(used));
    const available = fromHere.sub(used);
    if (available.lte(0)) continue;
    const qty = Prisma.Decimal.min(outstanding, available);
    lines.push({
      saleItemId: line.id,
      batchId: alloc.inventoryBatchId,
      qty,
      unitPrice,
      unitCost: D(alloc.unitCostEgp),
      restock,
    });
    outstanding = outstanding.sub(qty);
  }
  return { lines, untraced: outstanding };
}

/** What the lines refund and the cost they put back (damaged goods: none). */
export function returnFigures(lines: ReturnLine[]) {
  let refund = D(0);
  let cogs = D(0);
  for (const r of lines) {
    refund = refund.add(r.unitPrice.mul(r.qty));
    if (r.restock) cogs = cogs.add(r.unitCost.mul(r.qty));
  }
  return { refundEgp: money(refund), cogsReversedEgp: money(cogs) };
}

/**
 * The return's own records, inside the caller's transaction: the return and
 * its lines, the units back on their batches, the movements, and the ledger
 * rows. What the order owes, and its status, are the caller's to set.
 */
export async function writeReturnWithin(
  tx: Prisma.TransactionClient,
  order: { id: string; orderNo: string; currency: string },
  lines: ReturnLine[],
  meta: {
    returnedOn: Date;
    reason: string;
    refundMethod: RefundMethod;
    actorId?: string;
    editId?: string;
  },
) {
  const { refundEgp, cogsReversedEgp } = returnFigures(lines);
  const year = new Date().getFullYear();
  const last = await tx.saleReturn.findFirst({
    where: { reference: { startsWith: `RET-${year}` } },
    orderBy: { reference: 'desc' },
    select: { reference: true },
  });
  const saleReturn = await tx.saleReturn.create({
    data: {
      saleOrderId: order.id,
      reference: `RET-${year}-${pad(nextReferenceNumber(last?.reference, 5), 5)}`,
      returnedOn: meta.returnedOn,
      reason: meta.reason,
      refundMethod: meta.refundMethod,
      refundEgp,
      cogsReversedEgp,
      createdBy: meta.actorId,
      editId: meta.editId,
    },
  });

  for (const r of lines) {
    await tx.saleReturnItem.create({
      data: {
        saleReturnId: saleReturn.id,
        saleItemId: r.saleItemId,
        inventoryBatchId: r.batchId,
        qty: r.qty,
        unitPrice: money(r.unitPrice),
        refundEgp: money(r.unitPrice.mul(r.qty)),
        unitCostEgp: r.unitCost,
        cogsReversedEgp: r.restock ? money(r.unitCost.mul(r.qty)) : D(0),
        restocked: r.restock,
      },
    });

    if (r.restock) {
      await tx.inventoryBatch.update({
        where: { id: r.batchId },
        data: {
          remainingQty: { increment: r.qty },
          saleableQty: { increment: r.qty },
        },
      });
    }

    await tx.inventoryMovement.create({
      data: {
        batchId: r.batchId,
        movementType: r.restock ? 'RETURN' : 'WRITE_OFF',
        qtyDelta: r.restock ? r.qty : D(0),
        // The movement carries no free-text reason column; the link to
        // the return, and the reason on it, is the reference pair.
        referenceType: 'SALE_RETURN',
        referenceId: saleReturn.id,
        createdBy: meta.actorId,
      },
    });
  }

  // Revenue that is no longer earned, and the cost that comes back with it.
  await tx.financialTransaction.create({
    data: {
      type: 'SALE_RETURN',
      category: 'revenue',
      direction: 'OUTFLOW',
      amount: refundEgp,
      currency: order.currency,
      relatedType: 'SALE_RETURN',
      relatedId: saleReturn.id,
      reason: `Return ${saleReturn.reference} against ${order.orderNo}: ${meta.reason}`,
      createdBy: meta.actorId,
    },
  });

  if (meta.refundMethod === RefundMethod.CASH) {
    await tx.financialTransaction.create({
      data: {
        type: 'REFUND_PAID',
        category: 'refund',
        direction: 'OUTFLOW',
        amount: refundEgp,
        currency: order.currency,
        relatedType: 'SALE_RETURN',
        relatedId: saleReturn.id,
        reason: `Cash refunded for ${saleReturn.reference}`,
        createdBy: meta.actorId,
      },
    });
  }

  return { saleReturn, refundEgp, cogsReversedEgp };
}
