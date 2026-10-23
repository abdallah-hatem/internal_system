import type { OrderStatus, Prisma } from '@prisma/client';

import { assertDayRange, businessDay } from './dates';
import { SAMPLES_STATUSES } from './samples';

/**
 * A customer's statement (BUSINESS_LOGIC §7b, 2026-10-11): every sale,
 * payment, return and reversal that moved what the shop owes, in date order,
 * with a running balance.
 *
 * The rule it must keep: **the closing balance is the balance the app shows**
 * — `owedBy` (customer-balance.ts), the sum of `outstanding` over the shop's
 * CONFIRMED and PARTIALLY_PAID orders. A statement that disagreed with the
 * balance tile would be two answers to "what does this shop owe".
 *
 * So the statement is not a second set of rules about what a payment or a
 * return does. It replays, order by order and in the order things happened,
 * exactly the changes the services make to `outstanding` and `status`:
 *
 * - a sale is confirmed: owes its total;
 * - money is allocated (`PaymentsService.allocateWithin`): owes that much less;
 * - a return on credit note (`ReturnsService`): owes the refund less, never
 *   below zero; a cash return changes nothing owed; the return that brings
 *   every line back makes the order RETURNED, which owes nothing (§5);
 * - a payment is reversed (`PaymentsService.reverse`): each order it was on
 *   owes that allocation again, and is owed again even if it was returned.
 *
 * Each event's effect on the balance is what it did to that order's share of
 * it — so the rows add up to the stored figures by construction, and
 * `34-business-invariants` checks that they do.
 *
 * A draft never owed anything and a cancelled order is one that never
 * happened (§4): neither appears. The walk-in record has no account (§4) and
 * no statement.
 */

export type StatementKind =
  'SALE' | 'PAYMENT' | 'RETURN' | 'REVERSAL' | 'ADJUSTMENT';

export interface StatementRow {
  kind: StatementKind;
  /** The calendar day it happened, in Cairo — YYYY-MM-DD. */
  date: string;
  /** Order number, return reference, or a payment's own reference. */
  reference: string | null;
  /** The orders it touched, by number. */
  orders: string[];
  /** The document's own figure: the sale total, the payment, the refund. */
  amount: string;
  /** What it did to the balance: positive owes more, negative owes less. */
  effect: string;
  /** The running balance after this row. */
  balance: string;
  /** Payment method, or a return's refund method. */
  method: string | null;
  /**
   * What it did to the profit (owner 2026-10-23): a sale its total less the
   * landed cost of the units it drew; a return the profit on the units given
   * back, negative; a price cut the cut, negative. Null for money moving — a
   * payment or a reversal is cash, not profit.
   */
  profit: string | null;
  /** A payment's money that went on no order, so changed nothing owed. */
  unapplied?: string;
  /** Ids for the client to link to. */
  orderId?: string;
  paymentId?: string;
}

export interface Statement {
  customer: { id: string; displayName: string; phone: string | null };
  from: string | null;
  to: string | null;
  openingBalance: string;
  rows: StatementRow[];
  /** What was added and taken off within the range. */
  debits: string;
  credits: string;
  closingBalance: string;
  /** The shop's profit within the range: its rows' profit, summed. */
  profit: string;
}

/** Everything about one shop the replay needs. */
export interface StatementSource {
  orders: {
    id: string;
    orderNo: string;
    status: string;
    total: Prisma.Decimal | number | string;
    orderedAt: Date;
    items: {
      id: string;
      quantity: Prisma.Decimal | number | string;
      /** The landed cost of the units each line drew (its allocations' COGS). */
      allocations?: { cogsEgp: Prisma.Decimal | number | string }[];
    }[];
  }[];
  payments: {
    id: string;
    amount: Prisma.Decimal | number | string;
    receivedOn: Date;
    method: string | null;
    reference: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    allocations: {
      saleOrderId: string;
      amount: Prisma.Decimal | number | string;
      createdAt: Date;
    }[];
  }[];
  returns: {
    id: string;
    saleOrderId: string;
    reference: string;
    returnedOn: Date;
    refundMethod: string;
    refundEgp: Prisma.Decimal | number | string;
    /** The cost put back with the units (zero for damaged goods, which stay spent). */
    cogsReversedEgp?: Prisma.Decimal | number | string;
    createdAt: Date;
    items: { saleItemId: string; qty: Prisma.Decimal | number | string }[];
  }[];
  /** Prices lowered after the sale (§4, 2026-10-22): owed less, on that day. */
  adjustments?: {
    id: string;
    saleOrderId: string;
    adjustedOn: Date;
    amountEgp: Prisma.Decimal | number | string;
    createdAt: Date;
  }[];
}

/**
 * Statuses that never owed anything and are left out. Samples left at a shop
 * are not a sale until the shop buys (§4, samples at shops, 2026-10-18): open,
 * returned or written off, they never reach the statement. Bought, the order
 * is CONFIRMED and appears on the day the shop decided.
 */
const NEVER_OWED: string[] = ['DRAFT', 'CANCELLED', ...SAMPLES_STATUSES];

const cents = (v: Prisma.Decimal | number | string) =>
  Math.round(Number(v) * 100);
const money = (c: number) => (c / 100).toFixed(2);
/** Thousandths, for quantities: "2.5 of 2.5 returned" compares exactly. */
const milli = (v: Prisma.Decimal | number | string) =>
  Math.round(Number(v) * 1000);

interface Event {
  kind: StatementKind;
  date: string;
  /** When it was recorded — orders same-day events, and the replay. */
  at: number;
  /** Kind first on a tie, so a sale is owed before it is paid. */
  rank: number;
  key: string;
  reference: string | null;
  orders: string[];
  amount: number;
  effect: number;
  method: string | null;
  /** Cents of profit, or null for cash moving. */
  profit: number | null;
  unapplied?: number;
  orderId?: string;
  paymentId?: string;
}

const RANK: Record<StatementKind, number> = {
  SALE: 0,
  PAYMENT: 1,
  RETURN: 2,
  REVERSAL: 3,
  ADJUSTMENT: 4,
};

/** What happens to one order's outstanding, and when. */
type Change =
  | { type: 'ALLOCATE'; at: number; cents: number; paymentId: string }
  | { type: 'RETURN'; at: number; returnId: string }
  | { type: 'REVERSE'; at: number; cents: number; paymentId: string }
  | { type: 'ADJUST'; at: number; cents: number; adjustmentId: string };

/**
 * The statement, from what is stored. Pure: the rows are handed in.
 *
 * `from`/`to` are calendar days, both included. Everything dated before
 * `from` is the opening balance; nothing after `to` is counted.
 */
export function buildStatement(
  customer: Statement['customer'],
  source: StatementSource,
  range: { from?: string; to?: string } = {},
): Statement {
  assertDayRange(range.from, range.to);

  const orders = source.orders.filter((o) => !NEVER_OWED.includes(o.status));
  const byOrder = new Map(orders.map((o) => [o.id, o]));
  const returns = source.returns.filter((r) => byOrder.has(r.saleOrderId));
  const adjustments = (source.adjustments ?? []).filter((a) =>
    byOrder.has(a.saleOrderId),
  );

  // ── Each order's own history, replayed in the order it happened ─────────
  const allocationEffect = new Map<string, number>(); // payment → effect
  const reversalEffect = new Map<string, number>(); // payment → effect
  const returnEffect = new Map<string, number>(); // return → effect
  const adjustmentEffect = new Map<string, number>(); // adjustment → effect

  for (const order of orders) {
    const changes: Change[] = [];
    for (const p of source.payments) {
      for (const a of p.allocations) {
        if (a.saleOrderId !== order.id) continue;
        changes.push({
          type: 'ALLOCATE',
          at: a.createdAt.getTime(),
          cents: cents(a.amount),
          paymentId: p.id,
        });
        if (p.status === 'REVERSED') {
          changes.push({
            type: 'REVERSE',
            at: Math.max(p.updatedAt.getTime(), a.createdAt.getTime()),
            cents: cents(a.amount),
            paymentId: p.id,
          });
        }
      }
    }
    for (const r of returns) {
      if (r.saleOrderId === order.id)
        changes.push({
          type: 'RETURN',
          at: r.createdAt.getTime(),
          returnId: r.id,
        });
    }
    for (const a of adjustments) {
      if (a.saleOrderId === order.id)
        changes.push({
          type: 'ADJUST',
          at: a.createdAt.getTime(),
          cents: cents(a.amountEgp),
          adjustmentId: a.id,
        });
    }
    changes.sort((x, y) => x.at - y.at);

    let outstanding = cents(order.total);
    let returned = false;
    const owing = () => (returned ? 0 : outstanding);
    const returnedQty = new Map<string, number>();
    for (const change of changes) {
      const before = owing();
      if (change.type === 'ALLOCATE') {
        outstanding -= change.cents;
      } else if (change.type === 'REVERSE') {
        outstanding += change.cents;
        returned = false;
      } else if (change.type === 'ADJUST') {
        outstanding -= change.cents;
      } else {
        const r = returns.find((x) => x.id === change.returnId)!;
        if (r.refundMethod === 'CREDIT_NOTE') {
          outstanding = Math.max(outstanding - cents(r.refundEgp), 0);
        }
        for (const it of r.items) {
          returnedQty.set(
            it.saleItemId,
            (returnedQty.get(it.saleItemId) ?? 0) + milli(it.qty),
          );
        }
        if (
          order.items.every(
            (it) => (returnedQty.get(it.id) ?? 0) >= milli(it.quantity),
          )
        ) {
          returned = true;
        }
      }
      const delta = owing() - before;
      const bucket =
        change.type === 'ALLOCATE'
          ? allocationEffect
          : change.type === 'REVERSE'
            ? reversalEffect
            : change.type === 'ADJUST'
              ? adjustmentEffect
              : returnEffect;
      const id =
        change.type === 'RETURN'
          ? change.returnId
          : change.type === 'ADJUST'
            ? change.adjustmentId
            : change.paymentId;
      bucket.set(id, (bucket.get(id) ?? 0) + delta);
    }
  }

  // ── The rows a person reads ──────────────────────────────────────────────
  const events: Event[] = [];
  for (const o of orders) {
    events.push({
      kind: 'SALE',
      date: businessDay(o.orderedAt),
      at: o.orderedAt.getTime(),
      rank: RANK.SALE,
      key: o.id,
      reference: o.orderNo,
      orders: [o.orderNo],
      amount: cents(o.total),
      effect: cents(o.total),
      method: null,
      // The sale's total less what its units cost (the cycle's own COGS).
      profit:
        cents(o.total) -
        o.items.reduce(
          (sum, it) =>
            sum +
            (it.allocations ?? []).reduce((c, a) => c + cents(a.cogsEgp), 0),
          0,
        ),
      orderId: o.id,
    });
  }
  const orderNos = (ids: string[]) =>
    [...new Set(ids)]
      .map((id) => byOrder.get(id)?.orderNo)
      .filter((n): n is string => !!n);
  for (const p of source.payments) {
    const mine = p.allocations.filter((a) => byOrder.has(a.saleOrderId));
    const applied = mine.reduce((s, a) => s + cents(a.amount), 0);
    events.push({
      kind: 'PAYMENT',
      date: businessDay(p.receivedOn.toISOString().slice(0, 10)),
      at: p.createdAt.getTime(),
      rank: RANK.PAYMENT,
      key: p.id,
      reference: p.reference,
      orders: orderNos(mine.map((a) => a.saleOrderId)),
      amount: cents(p.amount),
      effect: allocationEffect.get(p.id) ?? 0,
      method: p.method,
      profit: null,
      unapplied: cents(p.amount) - applied,
      paymentId: p.id,
    });
    if (p.status === 'REVERSED') {
      events.push({
        kind: 'REVERSAL',
        date: businessDay(p.updatedAt),
        at: p.updatedAt.getTime(),
        rank: RANK.REVERSAL,
        key: `${p.id}:reversed`,
        reference: p.reference,
        orders: orderNos(mine.map((a) => a.saleOrderId)),
        amount: applied,
        effect: reversalEffect.get(p.id) ?? 0,
        method: p.method,
        profit: null,
        paymentId: p.id,
      });
    }
  }
  for (const r of returns) {
    events.push({
      kind: 'RETURN',
      date: businessDay(r.returnedOn.toISOString().slice(0, 10)),
      at: r.createdAt.getTime(),
      rank: RANK.RETURN,
      key: r.id,
      reference: r.reference,
      orders: orderNos([r.saleOrderId]),
      amount: cents(r.refundEgp),
      effect: returnEffect.get(r.id) ?? 0,
      method: r.refundMethod,
      // The profit on the units given back: their price less the cost that
      // came back with them (a damaged unit's cost stays spent).
      profit: -(cents(r.refundEgp) - cents(r.cogsReversedEgp ?? 0)),
      orderId: r.saleOrderId,
    });
  }

  for (const a of adjustments) {
    const orderNo = byOrder.get(a.saleOrderId)!.orderNo;
    events.push({
      kind: 'ADJUSTMENT',
      date: a.adjustedOn.toISOString().slice(0, 10),
      at: a.createdAt.getTime(),
      rank: RANK.ADJUSTMENT,
      key: a.id,
      reference: orderNo,
      orders: [orderNo],
      amount: cents(a.amountEgp),
      effect: adjustmentEffect.get(a.id) ?? 0,
      method: null,
      // A lower price is profit given up, all of it (§4).
      profit: -cents(a.amountEgp),
      orderId: a.saleOrderId,
    });
  }

  events.sort(
    (a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      a.at - b.at ||
      a.rank - b.rank ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const from = range.from ?? null;
  const to = range.to ?? null;
  let opening = 0;
  let running = 0;
  let debits = 0;
  let credits = 0;
  let profit = 0;
  const rows: StatementRow[] = [];
  for (const e of events) {
    if (to && e.date > to) continue;
    if (from && e.date < from) {
      opening += e.effect;
      running += e.effect;
      continue;
    }
    running += e.effect;
    if (e.effect > 0) debits += e.effect;
    else credits -= e.effect;
    profit += e.profit ?? 0;
    rows.push({
      kind: e.kind,
      date: e.date,
      reference: e.reference,
      orders: e.orders,
      amount: money(e.amount),
      effect: money(e.effect),
      balance: money(running),
      method: e.method,
      profit: e.profit === null ? null : money(e.profit),
      ...(e.unapplied ? { unapplied: money(e.unapplied) } : {}),
      ...(e.orderId ? { orderId: e.orderId } : {}),
      ...(e.paymentId ? { paymentId: e.paymentId } : {}),
    });
  }

  return {
    customer,
    from,
    to,
    openingBalance: money(opening),
    rows,
    debits: money(debits),
    credits: money(credits),
    closingBalance: money(running),
    profit: money(profit),
  };
}

type Db = Pick<
  Prisma.TransactionClient,
  'customer' | 'saleOrder' | 'payment' | 'saleReturn' | 'salePriceAdjustment'
>;

/** Reads one shop's history for `buildStatement`. */
export async function loadStatementSource(
  db: Db,
  customerId: string,
): Promise<StatementSource> {
  const [orders, payments, returns, adjustments] = await Promise.all([
    db.saleOrder.findMany({
      where: {
        customerId,
        status: { notIn: NEVER_OWED as OrderStatus[] },
      },
      select: {
        id: true,
        orderNo: true,
        status: true,
        total: true,
        orderedAt: true,
        items: {
          select: {
            id: true,
            quantity: true,
            allocations: { select: { cogsEgp: true } },
          },
        },
      },
    }),
    db.payment.findMany({
      where: { customerId },
      select: {
        id: true,
        amount: true,
        receivedOn: true,
        method: true,
        reference: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        allocations: {
          select: { saleOrderId: true, amount: true, createdAt: true },
        },
      },
    }),
    db.saleReturn.findMany({
      where: { saleOrder: { customerId } },
      select: {
        id: true,
        saleOrderId: true,
        reference: true,
        returnedOn: true,
        refundMethod: true,
        refundEgp: true,
        cogsReversedEgp: true,
        createdAt: true,
        items: { select: { saleItemId: true, qty: true } },
      },
    }),
    db.salePriceAdjustment.findMany({
      where: { saleOrder: { customerId } },
      select: {
        id: true,
        saleOrderId: true,
        adjustedOn: true,
        amountEgp: true,
        createdAt: true,
      },
    }),
  ]);
  return { orders, payments, returns, adjustments };
}
