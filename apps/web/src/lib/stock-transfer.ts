/**
 * Leftover stock moved to another cycle at its cost (BUSINESS_LOGIC §8, L5) —
 * what the web needs to offer the move only where the server would accept it.
 *
 * The two status lists are COPIES of `apps/api/src/common/stock-transfers.ts`.
 * Next cannot import across apps; `stock-transfer.test.ts` compares the two and
 * fails the moment they disagree. Change the API's first, then these.
 */

/** A cycle hands leftovers on only while selling or settling, not paid out. */
export const TRANSFER_SOURCE_STATUSES = ['SELLING', 'SETTLEMENT'] as const;

/** A cycle being settled, closed or cancelled takes nothing in. */
export const TRANSFER_TARGET_REFUSED = ['SETTLEMENT', 'CLOSED', 'CANCELLED'] as const;

/** Whether "Move leftovers" belongs on a cycle in `status` at all. */
export function canMoveFrom(status: string | undefined | null): boolean {
  return !!status && (TRANSFER_SOURCE_STATUSES as readonly string[]).includes(status);
}

/** The cycles that may take `fromId`'s leftovers: not itself, not settling, closed or cancelled. */
export function transferTargets<T extends { id: string; status: string }>(cycles: T[], fromId: string): T[] {
  return cycles.filter(
    (c) => c.id !== fromId && !(TRANSFER_TARGET_REFUSED as readonly string[]).includes(c.status),
  );
}

/** One product A could move, as `GET /cycles/:id/transfers/movable` answers. */
export interface MovableProduct {
  productId: string;
  productName: string;
  sku: string;
  available: string;
  /** Oldest check-in first — the order the server takes them in. */
  batches: { id: string; available: string; unitCostEgp: string; arrivedOn: string | null }[];
}

export interface MovableAnswer {
  cycle: { id: string; code: string; status: string };
  refusal: { code: string; message: string; params?: Record<string, string | number> } | null;
  products: MovableProduct[];
}

/**
 * What moving `qty` of a product costs, taken oldest batch first at each
 * batch's own landed cost, to the piastre — the preview of the server's
 * `planTransferLines`, which has the last word.
 */
export function moveCost(product: Pick<MovableProduct, 'batches'>, qty: number): number {
  let left = Math.round(qty * 1000);
  let cents = 0;
  for (const b of product.batches) {
    if (left <= 0) break;
    const take = Math.min(left, Math.round(Number(b.available) * 1000));
    if (take <= 0) continue;
    cents += Math.round((take / 1000) * Number(b.unitCostEgp) * 100);
    left -= take;
  }
  return cents / 100;
}

export interface TransferLine {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  sourceBatchId: string;
  destBatchId: string | null;
  qty: string;
  unitCostEgp: string;
  costEgp: string;
}

export interface Transfer {
  id: string;
  status: 'ACTIVE' | 'REVERSED';
  movedOn: string;
  reason: string;
  createdAt: string;
  createdBy: { id: string; name: string };
  reversedAt: string | null;
  reversalReason: string | null;
  reversedBy: { id: string; name: string } | null;
  fromCycle: { id: string; code: string };
  toCycle: { id: string; code: string };
  totalCostEgp: string;
  lines: TransferLine[];
  undo: { allowed: true } | { allowed: false; code: string; params: Record<string, string | number> };
}

/** `GET /cycles/:id/transfers`. */
export interface CycleTransfers {
  out: Transfer[];
  in: Transfer[];
}
