// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { REALISED_SALE_STATUSES } from './units-sold';

/**
 * The profit in the cash collected, and the profit still to come with what is
 * owed (owner 2026-11-06, option B: the "+N profit" pill on Cash from sales
 * and the Analytics Sales cash card).
 *
 * For every realised sale order (`REALISED_SALE_STATUSES` — CONFIRMED,
 * PARTIALLY_PAID, PAID; drafts, cancelled orders and samples still at a shop
 * are not sales) with a total above zero:
 *
 *   paid      = Σ its payment allocations whose payment stands (RECORDED);
 *               a reversed payment's allocation is not money in
 *   value     = paid + outstanding
 *   cost      = Σ its lines' COGS (`sale_item_allocations.cogs_egp`)
 *               − Σ cost given back by returns (`cogs_reversed_egp`; zero for
 *               damaged goods, whose cost stays a cost)
 *   profit    = value − cost                       (negative is a loss, kept)
 *   collected = profit × paid / value              (0 when value is 0)
 *
 *   profitOnCollectedEgp = Σ collected
 *   profitToCollectEgp   = Σ profit − Σ collected
 *
 * GUESS (owner accepted in chat 2026-11-06, "for a part-paid order, its profit
 * counts the share paid"): a part-paid order's profit is split in proportion
 * to what was paid — every pound collected carries the same share of profit.
 *
 * One definition (CLAUDE.md §11), read by `/analytics/dashboard`.
 */

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);

/** A sale order as the split reads it. */
export interface ProfitOrder {
  status: string;
  total: Prisma.Decimal.Value;
  outstanding: Prisma.Decimal.Value;
  paymentAllocations: readonly {
    amount: Prisma.Decimal.Value;
    payment: { status: string };
  }[];
  items: readonly {
    allocations: readonly { cogsEgp: Prisma.Decimal.Value }[];
    returnItems: readonly { cogsReversedEgp: Prisma.Decimal.Value }[];
  }[];
  /** Cash handed back leaves the payment and outstanding as they were, so it is read here. */
  returns?: readonly {
    refundMethod: string;
    refundEgp: Prisma.Decimal.Value;
  }[];
}

export interface ProfitOnCollected {
  totalProfitEgp: Prisma.Decimal;
  profitOnCollectedEgp: Prisma.Decimal;
  profitToCollectEgp: Prisma.Decimal;
}

const REALISED: readonly string[] = REALISED_SALE_STATUSES;

/** The split over orders already loaded. Filters them itself, so any caller gets the same rule. */
export function splitProfit(orders: readonly ProfitOrder[]): ProfitOnCollected {
  let total = D(0);
  let collected = D(0);
  for (const o of orders) {
    if (!REALISED.includes(o.status) || !D(o.total).gt(0)) continue;
    // Cash refunded went back out of what was paid: without it a refunded
    // sale's money still counted as collected profit (2026-11-06).
    const cashRefunded = (o.returns ?? [])
      .filter((r) => r.refundMethod === 'CASH')
      .reduce((s, r) => s.add(D(r.refundEgp)), D(0));
    const paid = o.paymentAllocations
      .filter((a) => a.payment.status === 'RECORDED')
      .reduce((s, a) => s.add(D(a.amount)), D(0))
      .sub(cashRefunded);
    const value = paid.add(D(o.outstanding));
    const cost = o.items.reduce(
      (s, i) =>
        i.returnItems.reduce(
          (c, r) => c.sub(D(r.cogsReversedEgp)),
          i.allocations.reduce((c, a) => c.add(D(a.cogsEgp)), s),
        ),
      D(0),
    );
    const profit = value.sub(cost);
    total = total.add(profit);
    if (!value.isZero()) collected = collected.add(profit.mul(paid).div(value));
  }
  return {
    totalProfitEgp: total,
    profitOnCollectedEgp: collected,
    profitToCollectEgp: total.sub(collected),
  };
}

/** What each order is loaded with. */
export const PROFIT_ORDER_SELECT = {
  status: true,
  total: true,
  outstanding: true,
  paymentAllocations: {
    select: { amount: true, payment: { select: { status: true } } },
  },
  items: {
    select: {
      allocations: { select: { cogsEgp: true } },
      returnItems: { select: { cogsReversedEgp: true } },
    },
  },
  returns: { select: { refundMethod: true, refundEgp: true } },
} satisfies Prisma.SaleOrderSelect;

export async function profitOnCollected(db: {
  saleOrder: Pick<Prisma.TransactionClient['saleOrder'], 'findMany'>;
}): Promise<ProfitOnCollected> {
  const orders = await db.saleOrder.findMany({
    where: {
      status: { in: [...REALISED_SALE_STATUSES] },
      total: { gt: 0 },
    },
    select: PROFIT_ORDER_SELECT,
  });
  return splitProfit(orders);
}
