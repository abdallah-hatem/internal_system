// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { paidAndValueOf } from './profit-on-collected';
import { REALISED_SALE_STATUSES } from './units-sold';

/**
 * Profit taken before a cycle is settled (BUSINESS_LOGIC §8, owner
 * 2026-11-08: "I am allowed to take some of my share profit any time mid
 * cycle and its recorded, and the profit we made does not change").
 *
 * The one definition of the rules every reader shares (rule 11): what a
 * settlement takes off a payout, what a partner still owes after one, and how
 * much of a cycle's profit counts as collected.
 */

const ZERO = new Prisma.Decimal(0);
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/**
 * The ledger category of the cash a draw took. Money out, but not an expense
 * and not a cost of the cycle — it is a partner's profit paid early, as the
 * payout (`settlement`) is his profit paid late — so it sits in
 * CAPITALISED_CATEGORIES (ledger-categories.ts) and the cycle's profit never
 * sees it. It IS cash: cash on hand goes down by it.
 */
export const PROFIT_DRAW_CATEGORY = 'profit_draw';

/** The ledger rows' `relatedType`: owned by a draw, undone only from there. */
export const PROFIT_DRAW_RELATED = 'PROFIT_DRAW';

/** The settlement line a payout's draws are written as (negative). */
export const PROFIT_DRAWN_COMPONENT = 'PROFIT_DRAWN';

/** Cycle states that take no draw and no undo: being split, split, never ordered. */
export const CLOSED_FOR_DRAWS = ['SETTLEMENT', 'CLOSED', 'CANCELLED'];

type Db = Pick<Prisma.TransactionClient, 'profitDraw'>;

/** A draw that stands: not undone. */
export const STANDING_DRAW = { reversedAt: null } as const;

/**
 * What a settlement of `cycleId` takes off each of these people's payouts:
 * his standing draws on that cycle, plus whatever he still owes from an
 * earlier payout (CARRIED, on any cycle) — `byPartner`, the PROFIT_DRAWN line
 * — and the capital he took back early from that cycle (`capitalByUser`, the
 * CAPITAL_TAKEN_EARLY line) — none of them yet taken by a paid settlement.
 * Read again at approval and payment, so a draw or an undo after the figures
 * were worked out is never paid on stale lines. Core partners and investors
 * alike: an investor can take capital early, and so can owe.
 */
export async function deductionsFor(
  db: Db,
  cycleId: string,
  partnerUserIds: string[],
): Promise<{
  byPartner: Map<string, Prisma.Decimal>;
  capitalByUser: Map<string, Prisma.Decimal>;
  drawIds: string[];
}> {
  const byPartner = new Map<string, Prisma.Decimal>();
  const capitalByUser = new Map<string, Prisma.Decimal>();
  if (partnerUserIds.length === 0) {
    return { byPartner, capitalByUser, drawIds: [] };
  }
  const rows = await db.profitDraw.findMany({
    where: {
      ...STANDING_DRAW,
      settledById: null,
      partnerUserId: { in: partnerUserIds },
      OR: [
        { kind: 'DRAW', cycleId },
        { kind: 'CAPITAL', cycleId },
        { kind: 'CARRIED' },
      ],
    },
    select: { id: true, kind: true, partnerUserId: true, amountEgp: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  for (const r of rows) {
    const into = r.kind === 'CAPITAL' ? capitalByUser : byPartner;
    into.set(
      r.partnerUserId,
      (into.get(r.partnerUserId) ?? ZERO).add(r.amountEgp),
    );
  }
  return { byPartner, capitalByUser, drawIds: rows.map((r) => r.id) };
}

/**
 * What a partner still owes after a payout that came to less than he had
 * already taken (owner 2026-11-08: "they owe it back"): the part of a negative
 * payout his draws account for — never more than he drew, so a loss beyond
 * that is what it always was. Zero when the payout covers the draws.
 *
 * `payable` is his payout with the draws already off it; `drawn` what was
 * taken off (positive).
 */
export function owedAfterPayout(
  payable: Prisma.Decimal,
  drawn: Prisma.Decimal,
): Prisma.Decimal {
  if (payable.gte(0) || drawn.lte(0)) return ZERO;
  const short = payable.neg();
  return short.lt(drawn) ? short : drawn;
}

/**
 * How much of a cycle's sales the customers have paid (owner 2026-11-08: "use
 * the dashboard's proportional reading for profit draws"): each realised
 * order's part from this cycle's batches, weighted by the share of that order
 * paid — through `paidAndValueOf`, the dashboard's own reading (rule 11) —
 * over that part in all. Every pound collected carries the same share of the
 * cycle's profit. Zero when nothing is sold.
 */
export async function cycleSalesPaid(
  db: Pick<Prisma.TransactionClient, 'saleItemAllocation'>,
  cycleId: string,
): Promise<{
  revenueEgp: Prisma.Decimal;
  paidEgp: Prisma.Decimal;
  share: Prisma.Decimal;
}> {
  const allocations = await db.saleItemAllocation.findMany({
    where: {
      inventoryBatch: { cycleId },
      saleItem: { saleOrder: { status: { in: [...REALISED_SALE_STATUSES] } } },
    },
    select: {
      qty: true,
      saleItem: {
        select: {
          quantity: true,
          lineTotal: true,
          saleOrder: {
            select: {
              outstanding: true,
              paymentAllocations: {
                select: { amount: true, payment: { select: { status: true } } },
              },
              returns: { select: { refundMethod: true, refundEgp: true } },
            },
          },
        },
      },
    },
  });
  let revenue = ZERO;
  let paid = ZERO;
  for (const a of allocations) {
    const item = a.saleItem;
    const itemQty = new Prisma.Decimal(item.quantity);
    if (itemQty.lte(0)) continue;
    const part = new Prisma.Decimal(a.qty).mul(item.lineTotal).div(itemQty);
    const { paid: p, value } = paidAndValueOf(item.saleOrder);
    revenue = revenue.add(part);
    if (value.gt(0)) {
      const f = Prisma.Decimal.min(Prisma.Decimal.max(p.div(value), ZERO), 1);
      paid = paid.add(part.mul(f));
    }
  }
  return {
    revenueEgp: money(revenue),
    paidEgp: money(paid),
    share: revenue.gt(0) ? paid.div(revenue) : ZERO,
  };
}

/**
 * The profit a cycle has collected: its profit so far times the share of its
 * sales paid, never below zero (owner 2026-11-08). A loss collects nothing.
 */
export function collectedProfit(
  profit: Prisma.Decimal,
  sharePaid: Prisma.Decimal,
): Prisma.Decimal {
  const part = money(profit.mul(sharePaid));
  return part.gt(0) ? part : ZERO;
}
