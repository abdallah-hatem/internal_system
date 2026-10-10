// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money in EGP must not become a float
import { Prisma } from '@prisma/client';

/**
 * Refunds, in EGP (BUSINESS_LOGIC §6, 2026-10-10).
 *
 * `refundEgp` is the one conversion: the order-level cap, the loss cap, the
 * ledger row and the cycle page's "refunded so far" all add refunds up through
 * it, so the figure checked is the figure booked and the figure shown
 * (CLAUDE.md rule 11).
 */

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);

/** A refund in EGP, to the cent, half up — what its ledger row holds. */
export function refundEgp(r: {
  amount: Prisma.Decimal.Value;
  fxRateToEgp: Prisma.Decimal.Value;
}): Prisma.Decimal {
  return D(r.amount)
    .mul(D(r.fxRateToEgp))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * The refunds that count (B5b, §6 §9): a reversed refund — money handed back —
 * counts toward no cap and no profit. Every query that adds refunds up filters
 * with this, and every in-memory sum with `counts`, so "which refunds count"
 * is answered once (rule 11).
 */
export const COUNTING_REFUND = { reversedAt: null } as const;

/** Does this refund still count? (The in-memory form of `COUNTING_REFUND`.) */
export function counts(r: { reversedAt?: Date | null }): boolean {
  return r.reversedAt == null;
}

type Qty = Prisma.Decimal.Value;

/** A loss as the shipment loader reads it. */
export interface LossRow {
  id: string;
  legId: string;
  purchaseOrderItemId: string;
  qty: Qty;
  unitCostEgp: Qty;
  costEgp: Qty;
  reason: string | null;
  createdAt: Date;
}

/** A loss with what has been paid back on it — the cycle page's shape. */
export interface LossWithRefunds {
  id: string;
  legId: string;
  purchaseOrderItemId: string;
  qty: number;
  unitCostEgp: string;
  costEgp: string;
  reason: string | null;
  createdAt: Date;
  refundedEgp: string;
  unrecoveredEgp: string;
  refunds: {
    id: string;
    amountEgp: string;
    currency: string;
    amount: string;
    recordedOn: string;
    payerType: 'SHIPPING_PROVIDER' | 'SUPPLIER';
    payerName: string;
    /** Set when the refund was undone; it then counts toward nothing. */
    reversedAt: Date | null;
    reversalReason: string | null;
  }[];
}

/**
 * Each loss with its refunds, refunded so far and what is still unrecovered.
 * Reversed refunds are in the list, marked, and out of both figures.
 * One query for all of them; the payer is the shipping company when the
 * refund names one, otherwise the order's supplier.
 */
export async function lossesWithRefunds(
  db: {
    supplierRefund: Pick<
      Prisma.TransactionClient['supplierRefund'],
      'findMany'
    >;
  },
  losses: LossRow[],
): Promise<LossWithRefunds[]> {
  const rows =
    losses.length === 0
      ? []
      : await db.supplierRefund.findMany({
          where: { shipmentLossId: { in: losses.map((l) => l.id) } },
          orderBy: [{ recordedOn: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            shipmentLossId: true,
            amount: true,
            currency: true,
            fxRateToEgp: true,
            recordedOn: true,
            reversedAt: true,
            reversalReason: true,
            payerShippingProvider: { select: { name: true } },
            purchaseOrder: { select: { supplier: { select: { name: true } } } },
          },
        });

  return losses.map((loss) => {
    const refunds = rows
      .filter((r) => r.shipmentLossId === loss.id)
      .map((r) => ({
        id: r.id,
        amountEgp: refundEgp(r).toFixed(2),
        currency: r.currency,
        amount: D(r.amount).toFixed(2),
        recordedOn: r.recordedOn.toISOString().slice(0, 10),
        payerType: r.payerShippingProvider
          ? ('SHIPPING_PROVIDER' as const)
          : ('SUPPLIER' as const),
        payerName:
          r.payerShippingProvider?.name ?? r.purchaseOrder.supplier.name,
        reversedAt: r.reversedAt ?? null,
        reversalReason: r.reversalReason ?? null,
      }));
    // Reversed refunds are listed — the history stays visible — but the money
    // went back, so they are not part of what was refunded.
    const refunded = refunds
      .filter(counts)
      .reduce((s, r) => s.add(r.amountEgp), D(0));
    const cost = D(loss.costEgp);
    return {
      id: loss.id,
      legId: loss.legId,
      purchaseOrderItemId: loss.purchaseOrderItemId,
      qty: Number(D(loss.qty).toString()),
      unitCostEgp: D(loss.unitCostEgp).toFixed(4),
      costEgp: cost.toFixed(2),
      reason: loss.reason,
      createdAt: loss.createdAt,
      refundedEgp: refunded.toFixed(2),
      unrecoveredEgp: cost.sub(refunded).toFixed(2),
      refunds,
    };
  });
}
