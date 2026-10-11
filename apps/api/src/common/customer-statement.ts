import type { Prisma } from '@prisma/client';

import { assertDayRange, businessDay } from './dates';

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

export type StatementKind = 'SALE' | 'PAYMENT' | 'RETURN' | 'REVERSAL';

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
}

/** Everything about one shop the replay needs. */
export interface StatementSource {
  orders: {
    id: string;
    orderNo: string;
    status: string;
    total: Prisma.Decimal | number | string;
    orderedAt: Date;
    items: { id: string; quantity: Prisma.Decimal | number | string }[];
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
    createdAt: Date;
    items: { saleItemId: string; qty: Prisma.Decimal | number | string }[];
  }[];
}

/** Statuses that never owed anything and are left out. */
const NEVER_OWED = ['DRAFT', 'CANCELLED'];

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
  unapplied?: number;
  orderId?: string;
  paymentId?: string;
}

const RANK: Record<StatementKind, number> = {
  SALE: 0,
  PAYMENT: 1,
  RETURN: 2,
  REVERSAL: 3,
};

/** What happens to one order's outstanding, and when. */
type Change =
  | { type: 'ALLOCATE'; at: number; cents: number; paymentId: string }
  | { type: 'RETURN'; at: number; returnId: string }
  | { type: 'REVERSE'; at: number; cents: number; paymentId: string };

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

  // ── Each order's own history, replayed in the order it happened ─────────
  const allocationEffect = new Map<string, number>(); // payment → effect
  const reversalEffect = new Map<string, number>(); // payment → effect
  const returnEffect = new Map<string, number>(); // return → effect

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
            : returnEffect;
      const id = change.type === 'RETURN' ? change.returnId : change.paymentId;
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
      orderId: r.saleOrderId,
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
    rows.push({
      kind: e.kind,
      date: e.date,
      reference: e.reference,
      orders: e.orders,
      amount: money(e.amount),
      effect: money(e.effect),
      balance: money(running),
      method: e.method,
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
  };
}

type Db = Pick<
  Prisma.TransactionClient,
  'customer' | 'saleOrder' | 'payment' | 'saleReturn'
>;

/** Reads one shop's history for `buildStatement`. */
export async function loadStatementSource(
  db: Db,
  customerId: string,
): Promise<StatementSource> {
  const [orders, payments, returns] = await Promise.all([
    db.saleOrder.findMany({
      where: { customerId, status: { notIn: ['DRAFT', 'CANCELLED'] } },
      select: {
        id: true,
        orderNo: true,
        status: true,
        total: true,
        orderedAt: true,
        items: { select: { id: true, quantity: true } },
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
        createdAt: true,
        items: { select: { saleItemId: true, qty: true } },
      },
    }),
  ]);
  return { orders, payments, returns };
}
