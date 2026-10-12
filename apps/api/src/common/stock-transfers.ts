// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; quantities and money must not become floats
import { Prisma } from '@prisma/client';
import { badRequest } from './api-error';
import { formatQty } from './money';

/**
 * Leftover stock moving to another cycle at its cost (BUSINESS_LOGIC §8 —
 * owner 2026-10-11, built L5). The rules, written once: the service, the
 * cycle page's "Move leftovers" and the transfers list all read these, so the
 * button is offered exactly when the server would accept (rule 11).
 *
 * Pure except `cycleTransfersInEgp`, which reads.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);
const ZERO = new Prisma.Decimal(0);
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** A cycle can hand leftovers on only once it is selling or settling (§8). */
export const TRANSFER_SOURCE_STATUSES = ['SELLING', 'SETTLEMENT'] as const;

/** A cycle being settled, closed or cancelled takes nothing in. */
export const TRANSFER_TARGET_REFUSED = [
  'SETTLEMENT',
  'CLOSED',
  'CANCELLED',
] as const;

/** Codes the transfer refusals carry (rule 9) — the web translates each. */
type Cycle = { id: string; code: string; status: string };

/**
 * Why `cycle` cannot hand leftovers on, or null. `paid`: the cycle has a PAID
 * settlement — its partners have had their capital back, so moving stock out
 * now would take value from a cycle already split.
 */
export function sourceRefusal(cycle: Cycle, opts: { paid: boolean }) {
  if (!(TRANSFER_SOURCE_STATUSES as readonly string[]).includes(cycle.status)) {
    return badRequest(
      'TRANSFER_SOURCE_NOT_SELLING',
      `Cycle ${cycle.code} is ${cycle.status}. Leftovers can be moved only from a cycle that is selling or being settled.`,
      { cycle: cycle.code, status: cycle.status },
    );
  }
  if (opts.paid) {
    return badRequest(
      'TRANSFER_SOURCE_PAID',
      `Cycle ${cycle.code} has been paid out; its stock can no longer move.`,
      { cycle: cycle.code },
    );
  }
  return null;
}

/** Why `to` cannot take `from`'s leftovers, or null. */
export function targetRefusal(from: Pick<Cycle, 'id' | 'code'>, to: Cycle) {
  if (from.id === to.id) {
    return badRequest(
      'TRANSFER_SAME_CYCLE',
      `Leftovers cannot be moved from ${from.code} to itself.`,
      { cycle: from.code },
    );
  }
  if ((TRANSFER_TARGET_REFUSED as readonly string[]).includes(to.status)) {
    return badRequest(
      'TRANSFER_TARGET_CLOSED',
      `Cycle ${to.code} is ${to.status} and cannot take stock in.`,
      { cycle: to.code, status: to.status },
    );
  }
  return null;
}

/** One verified batch on the giving cycle, as `planTransferLines` reads it. */
export interface ShelfBatch {
  id: string;
  productId: string;
  productName: string;
  /** Sellable on the shelf (`saleableQty`). */
  saleableQty: Prisma.Decimal.Value;
  /** Units on this batch held for a shop's request right now. */
  heldQty: Prisma.Decimal.Value;
  landedUnitCostEgp: Prisma.Decimal.Value;
  createdAt: Date;
}

/** What one batch gives: the line written and the units its new batch gets. */
export interface PlannedLine {
  productId: string;
  productName: string;
  sourceBatchId: string;
  qty: Prisma.Decimal;
  unitCostEgp: Prisma.Decimal;
  costEgp: Prisma.Decimal;
}

/** What can be moved off one batch: sellable less held, never below zero. */
export function movableOn(b: Pick<ShelfBatch, 'saleableQty' | 'heldQty'>) {
  const free = D(b.saleableQty).sub(D(b.heldQty));
  return free.isNegative() ? ZERO : free;
}

/** Oldest check-in first (§3), the batch id breaking a tie — the order sales draw in. */
export function fifo<T extends { createdAt: Date; id: string }>(rows: T[]) {
  return [...rows].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
  );
}

/**
 * Turn "this many of each product" into lines, one per source batch, oldest
 * check-in first — the units that would have sold first move first.
 *
 * Refuses: no lines; a product twice; zero, negative or not a number; more
 * than is on the shelf (sellable, less what is held for a shop's request) —
 * including a product the cycle never had, whose shelf is zero.
 *
 * Each line is costed at its batch's own landed unit cost, never re-priced
 * (§3), to the piastre.
 */
export function planTransferLines(
  batches: ShelfBatch[],
  wanted: { productId: string; qty: Prisma.Decimal.Value }[],
  names: Map<string, string> = new Map(),
): PlannedLine[] {
  if (wanted.length === 0) {
    throw badRequest(
      'TRANSFER_NO_LINES',
      'Say how many of which product to move.',
    );
  }
  const nameOf = (id: string) =>
    batches.find((b) => b.productId === id)?.productName ?? names.get(id) ?? id;

  const seen = new Set<string>();
  for (const w of wanted) {
    if (seen.has(w.productId)) {
      throw badRequest(
        'TRANSFER_DUPLICATE_PRODUCT',
        `${nameOf(w.productId)} is listed twice; give one quantity per product.`,
        { product: nameOf(w.productId) },
      );
    }
    seen.add(w.productId);
    let qty: Prisma.Decimal;
    try {
      qty = D(w.qty);
    } catch {
      qty = ZERO;
    }
    if (!qty.isFinite() || qty.lte(0)) {
      throw badRequest(
        'TRANSFER_QTY_NOT_POSITIVE',
        `The quantity of ${nameOf(w.productId)} to move must be more than zero.`,
        { product: nameOf(w.productId) },
      );
    }
  }

  const lines: PlannedLine[] = [];
  for (const w of wanted) {
    const own = fifo(batches.filter((b) => b.productId === w.productId));
    const available = own.reduce((s, b) => s.add(movableOn(b)), ZERO);
    const requested = D(w.qty);
    if (requested.gt(available)) {
      throw badRequest(
        'TRANSFER_MORE_THAN_ON_SHELF',
        `Only ${formatQty(available)} of ${nameOf(w.productId)} can be moved; ${formatQty(requested)} was asked for.`,
        {
          product: nameOf(w.productId),
          available: formatQty(available),
          requested: formatQty(requested),
        },
      );
    }
    let left = requested;
    for (const b of own) {
      if (left.lte(0)) break;
      const take = Prisma.Decimal.min(left, movableOn(b));
      if (take.lte(0)) continue;
      const unit = D(b.landedUnitCostEgp);
      lines.push({
        productId: b.productId,
        productName: b.productName,
        sourceBatchId: b.id,
        qty: take,
        unitCostEgp: unit,
        costEgp: money(take.mul(unit)),
      });
      left = left.sub(take);
    }
  }
  return lines;
}

/** Sum of the lines' costs — the amount each side of the ledger pair carries. */
export function transferTotalEgp(lines: { costEgp: Prisma.Decimal.Value }[]) {
  return lines.reduce<Prisma.Decimal>((s, l) => s.add(D(l.costEgp)), ZERO);
}

/** A destination batch as the undo checks it. Null: it is gone. */
export interface DestBatchState {
  remainingQty: Prisma.Decimal.Value;
  saleableQty: Prisma.Decimal.Value;
  reservedQty: Prisma.Decimal.Value;
  /** Sale allocations of any status — a cancelled sale is still history on it. */
  allocations: number;
  /** Holds of any status. */
  reservations: number;
  returns: number;
  /** Lines of a later transfer that moved its units on. */
  movedOn: number;
}

/**
 * Why a transfer cannot be undone, or null (§8: "only while none of the moved
 * units has sold in B and A has not been paid out").
 *
 * "Sold" is read strictly: any sale ever drawn from the moved batch — even one
 * since cancelled — any hold, any return, or the units moved on again. The
 * batch then has history of its own, and undoing would erase it.
 */
export function undoRefusal(input: {
  status: string;
  from: Cycle;
  fromPaid: boolean;
  to: Cycle;
  lines: {
    productName: string;
    qty: Prisma.Decimal.Value;
    dest: DestBatchState | null;
  }[];
}) {
  if (input.status !== 'ACTIVE') {
    return badRequest(
      'TRANSFER_ALREADY_UNDONE',
      'This transfer has already been undone.',
    );
  }
  if (
    !(TRANSFER_SOURCE_STATUSES as readonly string[]).includes(
      input.from.status,
    ) ||
    input.fromPaid
  ) {
    return badRequest(
      'TRANSFER_SOURCE_PAID',
      `Cycle ${input.from.code} has been paid out; its stock can no longer move.`,
      { cycle: input.from.code },
    );
  }
  if (
    (TRANSFER_TARGET_REFUSED as readonly string[]).includes(input.to.status)
  ) {
    return badRequest(
      'TRANSFER_TARGET_CLOSED',
      `Cycle ${input.to.code} is ${input.to.status} and cannot take stock in.`,
      { cycle: input.to.code, status: input.to.status },
    );
  }
  for (const l of input.lines) {
    const d = l.dest;
    const qty = D(l.qty);
    const untouched =
      !!d &&
      d.allocations === 0 &&
      d.reservations === 0 &&
      d.returns === 0 &&
      d.movedOn === 0 &&
      D(d.remainingQty).eq(qty) &&
      D(d.saleableQty).eq(qty) &&
      D(d.reservedQty).eq(0);
    if (!untouched) {
      return badRequest(
        'TRANSFER_UNITS_SOLD',
        `Some of the ${l.productName} moved to ${input.to.code} has been sold or used there; the move is permanent now.`,
        { product: l.productName, cycle: input.to.code },
      );
    }
  }
  return null;
}

/**
 * What the partners are asked to fund: the landed cost, plus stock moved in
 * from another cycle at its cost (§8, L5), less what friends paid (§18) —
 * never below zero. The arithmetic of `CostingService.fundingFor`.
 */
export function toFundEgp(input: {
  landed: Prisma.Decimal.Value;
  transferredIn: Prisma.Decimal.Value;
  financed: Prisma.Decimal.Value;
}) {
  const rest = D(input.landed)
    .add(D(input.transferredIn))
    .sub(D(input.financed));
  return { rest, toFund: rest.isNegative() ? ZERO : rest };
}

/**
 * The cost of the stock moved into `cycleId` by transfers that stand. Read by
 * `CostingService.fundingFor` — the one place a cycle's cost to fund is worked
 * out (rule 11).
 */
export async function cycleTransfersInEgp(
  db: {
    stockTransferLine: Pick<
      Prisma.TransactionClient['stockTransferLine'],
      'aggregate'
    >;
  },
  cycleId: string,
): Promise<Prisma.Decimal> {
  const { _sum } = await db.stockTransferLine.aggregate({
    where: { transfer: { toCycleId: cycleId, status: 'ACTIVE' } },
    _sum: { costEgp: true },
  });
  return D(_sum.costEgp);
}

/**
 * The cost of the leftovers moved OUT of `cycleId` by transfers that stand.
 * Shown on the cycle's payout breakdown (§8 "a payout explains itself", L7):
 * moved at cost, they make no profit and no loss for the giving cycle, so the
 * line is a note beside the figures, never a cost inside them.
 */
export async function cycleTransfersOutEgp(
  db: {
    stockTransferLine: Pick<
      Prisma.TransactionClient['stockTransferLine'],
      'aggregate'
    >;
  },
  cycleId: string,
): Promise<Prisma.Decimal> {
  const { _sum } = await db.stockTransferLine.aggregate({
    where: { transfer: { fromCycleId: cycleId, status: 'ACTIVE' } },
    _sum: { costEgp: true },
  });
  return D(_sum.costEgp);
}
