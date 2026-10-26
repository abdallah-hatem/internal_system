import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationEvent } from '../modules/notifications/notifications.service';
import { formatMoney } from './money';

/**
 * What one partner did, told to the others (owner 2026-10-25: Fares recorded a
 * sale and the owner was not told). A sale confirmed, a payment recorded, a
 * return, a payment reversed and an order cancelled each reach every active
 * core partner except the one who did it — in the app and pushed (§10).
 *
 * Called after the write has committed (LEARNINGS: never inside
 * `$transaction`), and never fails it: the sale stands whether or not the
 * news got out, so a failure is logged and swallowed — including a failure
 * reading what the news says, which is why `news` may be a function: it runs
 * inside the guard, and not at all when there is no notifier.
 */

const logger = new Logger('PartnerNews');

export interface PartnerNotifier {
  createForMultipleUsers(
    userIds: string[],
    data: NotificationEvent,
  ): Promise<unknown>;
}

type Db = Pick<PrismaService, 'user'>;

export async function tellOtherPartners(
  db: Db,
  notifier: PartnerNotifier | undefined,
  actorId: string | undefined,
  news: NotificationEvent | (() => Promise<NotificationEvent | null>),
): Promise<void> {
  if (!notifier) return;
  let eventType = typeof news === 'function' ? 'news' : news.eventType;
  try {
    const event = typeof news === 'function' ? await news() : news;
    if (!event) return;
    eventType = event.eventType;
    const [partners, actor] = await Promise.all([
      db.user.findMany({
        where: {
          role: 'CORE_PARTNER',
          status: 'ACTIVE',
          ...(actorId ? { id: { not: actorId } } : {}),
        },
        select: { id: true },
      }),
      actorId
        ? db.user.findUnique({
            where: { id: actorId },
            select: { email: true, partner: { select: { displayName: true } } },
          })
        : null,
    ]);
    if (partners.length === 0) return;
    const by = actor?.partner?.displayName ?? actor?.email ?? '—';
    await notifier.createForMultipleUsers(
      partners.map((p) => p.id),
      { ...event, params: { ...event.params, by } },
    );
  } catch (err) {
    logger.warn(
      `${eventType} not sent: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

type Money = Parameters<typeof formatMoney>[0];
const egp = (v: unknown) => formatMoney(v as Money);

/** A confirmed sale (one-step, walk-in, samples bought, or a draft confirmed). */
export function saleNews(order: {
  id: string;
  orderNo: string;
  total: unknown;
  customerId: string;
  customer?: { displayName: string } | null;
}): NotificationEvent {
  return {
    eventType: 'SALE_CONFIRMED',
    code: 'SALE_RECORDED',
    params: {
      shop: order.customer?.displayName ?? '—',
      orderNo: order.orderNo,
      total: egp(order.total),
    },
    payload: { orderId: order.id, customerId: order.customerId },
  };
}

export function paymentNews(payment: {
  id: string;
  amount: unknown;
  method: string | null;
  customerId: string;
  shop: string;
  orders: string[];
}): NotificationEvent {
  return {
    eventType: 'PAYMENT_RECEIVED',
    code: 'PAYMENT_RECORDED',
    params: {
      shop: payment.shop,
      amount: egp(payment.amount),
      method: payment.method ?? 'CASH',
      orders: payment.orders.join(', ') || '—',
    },
    payload: { paymentId: payment.id, customerId: payment.customerId },
  };
}

export function returnNews(r: {
  id: string;
  reference: string;
  refundEgp: unknown;
  refundMethod: string;
  reason: string;
  orderId: string;
  orderNo: string;
  shop: string;
  items: { product: string; qty: unknown }[];
}): NotificationEvent {
  return {
    eventType: 'SALE_RETURNED',
    code:
      r.refundMethod === 'CASH' ? 'SALE_RETURNED_CASH' : 'SALE_RETURNED_CREDIT',
    params: {
      shop: r.shop,
      reference: r.reference,
      orderNo: r.orderNo,
      refund: egp(r.refundEgp),
      reason: r.reason,
      items: r.items.map((i) => `${Number(i.qty)} × ${i.product}`).join(', '),
    },
    payload: { orderId: r.orderId, returnId: r.id },
  };
}

export function reversalNews(p: {
  id: string;
  amount: unknown;
  customerId: string;
  shop: string;
  reason: string;
}): NotificationEvent {
  return {
    eventType: 'PAYMENT_REVERSED',
    code: 'PAYMENT_REVERSED',
    params: { shop: p.shop, amount: egp(p.amount), reason: p.reason },
    payload: { paymentId: p.id, customerId: p.customerId },
  };
}

export function cancelNews(order: {
  id: string;
  orderNo: string;
  total: unknown;
  customerId: string;
  shop: string;
}): NotificationEvent {
  return {
    eventType: 'ORDER_CANCELLED',
    code: 'ORDER_CANCELLED',
    params: {
      shop: order.shop,
      orderNo: order.orderNo,
      total: egp(order.total),
    },
    payload: { orderId: order.id, customerId: order.customerId },
  };
}
