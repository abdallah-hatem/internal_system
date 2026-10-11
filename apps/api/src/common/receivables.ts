import { businessDay } from './dates';

/**
 * Who owes what (I1, 2026-10-11; BUSINESS_LOGIC §7).
 *
 * One row per customer with something owed, the largest balance first. What a
 * customer owes is the same rule as everywhere else (`customer-balance.ts`):
 * the outstanding of their CONFIRMED and PARTIALLY_PAID orders. The caller
 * reads those orders with `OWED_STATUSES`; this only adds them up, so the
 * total here and a customer's balance on their own page cannot differ.
 *
 * What is **overdue** is the payment plans' figure (§7: the cumulative amount
 * promised by today less what came in) — a shop without a plan has nothing
 * overdue, because nothing was promised by a date. Shown never above what the
 * customer owes now: a plan can promise more than is still owed after a
 * return, and "overdue 500 of a 100 balance" says something untrue.
 *
 * Pure: no Nest, no Prisma. Money is added in whole cents.
 */

type Money = number | string | { toString(): string };

export interface OwingOrder {
  customerId: string;
  outstanding: Money;
  orderedAt: Date;
  customer: { displayName: string; phone: string | null; isWalkIn?: boolean };
}

export interface Receivable {
  customerId: string;
  customer: string;
  phone: string | null;
  /** What they owe across their open orders, "1250.25". */
  outstanding: string;
  openOrders: number;
  /** The day in Cairo the oldest order still owing was placed. */
  oldestUnpaidOn: string;
  oldestUnpaidAt: string;
}

export interface ReceivableWithOverdue extends Receivable {
  /** What is behind on their payment plan, "0.00" when nothing is. */
  overdue: string;
}

const cents = (m: Money) => Math.round(Number(m.toString()) * 100);
const money = (c: number) => (c / 100).toFixed(2);

export function receivablesByCustomer(
  orders: readonly OwingOrder[],
): Receivable[] {
  const by = new Map<
    string,
    { row: OwingOrder; cents: number; count: number; oldest: Date }
  >();
  for (const o of orders) {
    if (o.customer.isWalkIn) continue;
    const c = cents(o.outstanding);
    if (!(c > 0)) continue;
    const seen = by.get(o.customerId);
    if (!seen) {
      by.set(o.customerId, { row: o, cents: c, count: 1, oldest: o.orderedAt });
    } else {
      seen.cents += c;
      seen.count += 1;
      if (o.orderedAt < seen.oldest) seen.oldest = o.orderedAt;
    }
  }
  return [...by.values()]
    .sort(
      (a, b) =>
        b.cents - a.cents ||
        a.row.customer.displayName.localeCompare(b.row.customer.displayName),
    )
    .map((v) => ({
      customerId: v.row.customerId,
      customer: v.row.customer.displayName,
      phone: v.row.customer.phone,
      outstanding: money(v.cents),
      openOrders: v.count,
      oldestUnpaidOn: businessDay(v.oldest),
      oldestUnpaidAt: v.oldest.toISOString(),
    }));
}

export function withOverdue(
  receivables: readonly Receivable[],
  overduePlans: readonly { customer: { id: string }; overdueEgp: Money }[],
  { overdueOnly = false }: { overdueOnly?: boolean } = {},
): ReceivableWithOverdue[] {
  const overdue = new Map<string, number>();
  for (const p of overduePlans) {
    overdue.set(
      p.customer.id,
      (overdue.get(p.customer.id) ?? 0) + cents(p.overdueEgp),
    );
  }
  return receivables
    .map((r) => ({
      ...r,
      overdue: money(
        Math.min(overdue.get(r.customerId) ?? 0, cents(r.outstanding)),
      ),
    }))
    .filter((r) => !overdueOnly || cents(r.overdue) > 0);
}
