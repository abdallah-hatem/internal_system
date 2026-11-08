// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';

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
 * What a settlement of `cycleId` takes off each of these partners' payouts:
 * his standing draws on that cycle, plus whatever he still owes from an
 * earlier payout (CARRIED, on any cycle) — none of them yet taken by a paid
 * settlement. Read again at approval and payment, so a draw or an undo after
 * the figures were worked out is never paid on stale lines.
 */
export async function deductionsFor(
  db: Db,
  cycleId: string,
  partnerUserIds: string[],
): Promise<{
  byPartner: Map<string, Prisma.Decimal>;
  drawIds: string[];
}> {
  const byPartner = new Map<string, Prisma.Decimal>();
  if (partnerUserIds.length === 0) return { byPartner, drawIds: [] };
  const rows = await db.profitDraw.findMany({
    where: {
      ...STANDING_DRAW,
      settledById: null,
      partnerUserId: { in: partnerUserIds },
      OR: [{ kind: 'DRAW', cycleId }, { kind: 'CARRIED' }],
    },
    select: { id: true, partnerUserId: true, amountEgp: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  for (const r of rows) {
    byPartner.set(
      r.partnerUserId,
      (byPartner.get(r.partnerUserId) ?? ZERO).add(r.amountEgp),
    );
  }
  return { byPartner, drawIds: rows.map((r) => r.id) };
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
 * The part of a cycle's revenue not yet paid by the customers, as an
 * allocation reads it: each realised order's part from this cycle's batches,
 * times the share of that order still outstanding.
 *
 * GUESS (2026-11-08): money owed is counted against profit first, and the
 * cycle's part of an order is read before returns — both make the figure
 * larger, never smaller, so what a partner may take can only err low.
 */
export async function uncollectedRevenueEgp(
  db: Pick<Prisma.TransactionClient, 'saleItemAllocation'>,
  cycleId: string,
): Promise<Prisma.Decimal> {
  const allocations = await db.saleItemAllocation.findMany({
    where: {
      inventoryBatch: { cycleId },
      saleItem: {
        saleOrder: { status: { in: ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'] } },
      },
    },
    select: {
      qty: true,
      saleItem: {
        select: {
          quantity: true,
          lineTotal: true,
          saleOrder: { select: { total: true, outstanding: true } },
        },
      },
    },
  });
  let owed = ZERO;
  for (const a of allocations) {
    const item = a.saleItem;
    const itemQty = new Prisma.Decimal(item.quantity);
    const total = new Prisma.Decimal(item.saleOrder.total);
    if (itemQty.lte(0) || total.lte(0)) continue;
    const revenue = new Prisma.Decimal(a.qty).mul(item.lineTotal).div(itemQty);
    const outstanding = Prisma.Decimal.min(
      Prisma.Decimal.max(new Prisma.Decimal(item.saleOrder.outstanding), ZERO),
      total,
    );
    owed = owed.add(revenue.mul(outstanding).div(total));
  }
  return money(owed);
}

/**
 * The profit a cycle has actually collected: its profit so far less what the
 * customers still owe on its sales, never below zero (owner 2026-11-08: "up to
 * his share of profit already collected").
 */
export function collectedProfit(
  profit: Prisma.Decimal,
  uncollected: Prisma.Decimal,
): Prisma.Decimal {
  const left = money(profit.sub(uncollected));
  return left.gt(0) ? left : ZERO;
}
