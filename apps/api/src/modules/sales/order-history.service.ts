import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { notFound } from '../../common/api-error';
import { businessDay } from '../../common/dates';
import { OWED_STATUSES } from '../../common/customer-balance';
import { heldUnitPrice, heldUnits } from '../../common/held-price';
import { isUuid } from '../../common/uuid';

const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const money = (c: number) => (c / 100).toFixed(2);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export type HistoryKind =
  | 'CREATED'
  | 'CONFIRMED'
  | 'SAMPLES_LEFT'
  | 'SAMPLES_BOUGHT'
  | 'SAMPLES_RETURNED'
  | 'SAMPLES_WRITTEN_OFF'
  | 'PAYMENT'
  | 'REVERSAL'
  | 'RETURN'
  | 'PRICE_ADJUSTED'
  | 'CANCELLED';

export interface HistoryEvent {
  kind: HistoryKind;
  /** The Cairo day it happened — a payment's day received, a return's day back. */
  date: string;
  /** When it was recorded. */
  at: string;
  /** Who recorded it, when the records say. */
  by: string | null;
  reference: string | null;
  /** The document's own figure: the order's total, the payment, the refund, what a lower price took off. */
  amount: string | null;
  /** What it did to what the order owes: positive owes more, negative less. */
  effect: string;
  /** What the order owed after it. */
  owes: string;
  method?: string | null;
  reason?: string | null;
  lines?: {
    product: string;
    productAr?: string | null;
    qty: string;
    unitPrice?: string;
    previousUnitPrice?: string;
    lineTotal?: string;
  }[];
}

/** Recorded instant first, then kind, so a sale is owed before it is paid. */
const RANK: Record<HistoryKind, number> = {
  CREATED: 0,
  SAMPLES_LEFT: 1,
  CONFIRMED: 2,
  SAMPLES_BOUGHT: 3,
  PAYMENT: 4,
  REVERSAL: 5,
  RETURN: 6,
  PRICE_ADJUSTED: 7,
  SAMPLES_RETURNED: 8,
  SAMPLES_WRITTEN_OFF: 9,
  CANCELLED: 10,
};

interface Draft extends Omit<HistoryEvent, 'effect' | 'owes'> {
  atMs: number;
  /** How it moves what is owed, applied in the order things were recorded. */
  apply: (owes: number) => number;
}

/**
 * An order's full history, on the order itself (BUSINESS_LOGIC §4, owner
 * 2026-10-22): "what products he started with, then what he returned, and any
 * price change, a complete view".
 *
 * Read from the records that already exist — the order and its lines, its
 * returns, its price adjustments, the payments allocated to it, and the audit
 * log for who confirmed or cancelled it — never a second copy of the figures.
 * What it owes is replayed in the order things were recorded, as the shop's
 * statement replays it, and must end on the order's own outstanding.
 */
@Injectable()
export class OrderHistoryService {
  constructor(private prisma: PrismaService) {}

  async history(id: string) {
    if (!isUuid(id)) throw notFound('saleOrder');
    const order = await this.prisma.saleOrder.findUnique({
      where: { id },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            product: { select: { name: true, nameAr: true } },
            returnItems: { select: { qty: true, inventoryBatchId: true } },
            priceAdjustments: {
              select: { newUnitPrice: true, createdAt: true },
            },
          },
        },
        returns: {
          include: {
            items: {
              include: {
                saleItem: {
                  select: { product: { select: { name: true, nameAr: true } } },
                },
              },
            },
          },
        },
        priceAdjustments: {
          include: {
            saleItem: {
              select: { product: { select: { name: true, nameAr: true } } },
            },
          },
        },
        paymentAllocations: { include: { payment: true } },
      },
    });
    if (!order) throw notFound('saleOrder');

    const paymentIds = order.paymentAllocations.map((a) => a.paymentId);
    const audit = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'SaleOrder', entityId: order.id },
          ...(paymentIds.length
            ? [{ entityType: 'Payment', entityId: { in: paymentIds } }]
            : []),
        ],
      },
      orderBy: { occurredAt: 'asc' },
      select: {
        action: true,
        entityType: true,
        entityId: true,
        occurredAt: true,
        actorUserId: true,
      },
    });
    const userIds = new Set<string>(
      [
        order.createdBy,
        ...order.returns.map((r) => r.createdBy),
        ...order.priceAdjustments.map((a) => a.createdBy),
        ...order.paymentAllocations.map((a) => a.payment.createdBy),
        ...audit.map((a) => a.actorUserId),
      ].filter((u): u is string => !!u),
    );
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: {
        id: true,
        email: true,
        partner: { select: { displayName: true } },
      },
    });
    const nameOf = (userId: string | null | undefined) => {
      const u = users.find((x) => x.id === userId);
      return u ? (u.partner?.displayName ?? u.email) : null;
    };
    const auditOf = (
      action: string,
      entityType = 'SaleOrder',
      entityId = order.id,
    ) =>
      audit.find(
        (a) =>
          a.action === action &&
          a.entityType === entityType &&
          a.entityId === entityId,
      );

    const total = cents(order.total);
    const drafts: Draft[] = [];
    const push = (d: Omit<Draft, 'date'> & { date?: string }) =>
      drafts.push({ date: businessDay(new Date(d.atMs)), ...d });

    const lineRows = order.items.map((i) => ({
      product: i.product.name,
      productAr: i.product.nameAr,
      qty: D(i.quantity).toString(),
      unitPrice: D(i.unitPrice).toFixed(2),
      lineTotal: D(i.lineTotal).toFixed(2),
    }));

    // How it began: samples left at the shop, or a sale entered as a draft.
    if (order.samplesLeftAt) {
      const left = auditOf('LEAVE_SAMPLES');
      push({
        kind: 'SAMPLES_LEFT',
        at: order.samplesLeftAt.toISOString(),
        atMs: order.samplesLeftAt.getTime(),
        by: nameOf(left?.actorUserId ?? order.createdBy),
        reference: order.orderNo,
        amount: null,
        lines: lineRows.map(({ product, productAr, qty }) => ({
          product,
          productAr,
          qty,
        })),
        apply: (o) => o,
      });
    } else {
      push({
        kind: 'CREATED',
        // On the sale's own day: a sale entered later is dated when it was made.
        date: businessDay(order.orderedAt),
        at: order.createdAt.toISOString(),
        atMs: order.createdAt.getTime(),
        by: nameOf(order.createdBy),
        reference: order.orderNo,
        amount: money(total),
        lines: lineRows,
        apply: (o) => o,
      });
    }

    // Owed from the moment it became a sale: confirmed, or the samples bought.
    const bought = auditOf('SAMPLES_BOUGHT');
    const SAMPLES_ONLY: string[] = [
      'SAMPLES',
      'SAMPLES_RETURNED',
      'SAMPLES_WRITTEN_OFF',
    ];
    if (order.samplesLeftAt) {
      if (bought || !SAMPLES_ONLY.includes(order.status)) {
        const atMs = (
          bought?.occurredAt ??
          order.samplesDecidedAt ??
          order.orderedAt
        ).getTime();
        push({
          kind: 'SAMPLES_BOUGHT',
          date: businessDay(order.orderedAt),
          at: new Date(atMs).toISOString(),
          atMs,
          by: nameOf(bought?.actorUserId),
          reference: order.orderNo,
          amount: money(total),
          lines: lineRows,
          apply: () => total,
        });
      }
    } else if (!order.samplesLeftAt && order.status !== 'DRAFT') {
      const confirmed = auditOf('CONFIRM');
      const atMs = (confirmed?.occurredAt ?? order.createdAt).getTime() + 1;
      push({
        kind: 'CONFIRMED',
        date: businessDay(order.orderedAt),
        at: new Date(atMs).toISOString(),
        atMs,
        by: nameOf(confirmed?.actorUserId ?? order.createdBy),
        reference: order.orderNo,
        amount: money(total),
        apply: () => total,
      });
    }

    for (const a of order.paymentAllocations) {
      const p = a.payment;
      const amount = cents(a.amount);
      push({
        kind: 'PAYMENT',
        date: dayOf(p.receivedOn),
        at: a.createdAt.toISOString(),
        atMs: a.createdAt.getTime(),
        by: nameOf(p.createdBy),
        reference: p.reference,
        amount: money(amount),
        method: p.method,
        apply: (o) => o - amount,
      });
      if (p.status === 'REVERSED') {
        const reversed = auditOf('REVERSE', 'Payment', p.id);
        const atMs = Math.max(
          (reversed?.occurredAt ?? p.updatedAt).getTime(),
          a.createdAt.getTime() + 1,
        );
        push({
          kind: 'REVERSAL',
          at: new Date(atMs).toISOString(),
          atMs,
          by: nameOf(reversed?.actorUserId),
          reference: p.reference,
          amount: money(amount),
          method: p.method,
          apply: (o) => o + amount,
        });
      }
    }

    // Units back per line as returns are replayed, so the one that brings the
    // last unit home leaves nothing owed (a returned order owes nothing).
    const returnedSoFar = new Map<string, Prisma.Decimal>();
    for (const r of order.returns) {
      const refund = cents(r.refundEgp);
      push({
        kind: 'RETURN',
        date: dayOf(r.returnedOn),
        at: r.createdAt.toISOString(),
        atMs: r.createdAt.getTime(),
        by: nameOf(r.createdBy),
        reference: r.reference,
        amount: money(refund),
        method: r.refundMethod,
        reason: r.reason,
        lines: mergeLines(
          r.items.map((it) => ({
            product: it.saleItem.product.name,
            productAr: it.saleItem.product.nameAr,
            qty: D(it.qty),
            unitPrice: D(it.unitPrice),
          })),
        ),
        apply: (o) => {
          for (const it of r.items) {
            returnedSoFar.set(
              it.saleItemId,
              (returnedSoFar.get(it.saleItemId) ?? D(0)).add(D(it.qty)),
            );
          }
          const all = order.items.every((i) =>
            (returnedSoFar.get(i.id) ?? D(0)).gte(D(i.quantity)),
          );
          if (all) return 0;
          return r.refundMethod === 'CREDIT_NOTE' ? Math.max(o - refund, 0) : o;
        },
      });
    }

    for (const a of order.priceAdjustments) {
      const amount = cents(a.amountEgp);
      push({
        kind: 'PRICE_ADJUSTED',
        date: dayOf(a.adjustedOn),
        at: a.createdAt.toISOString(),
        atMs: a.createdAt.getTime(),
        by: nameOf(a.createdBy),
        reference: order.orderNo,
        amount: money(amount),
        reason: a.reason,
        lines: [
          {
            product: a.saleItem.product.name,
            productAr: a.saleItem.product.nameAr,
            qty: D(a.qty).toString(),
            previousUnitPrice: D(a.previousUnitPrice).toFixed(2),
            unitPrice: D(a.newUnitPrice).toFixed(2),
          },
        ],
        apply: (o) => o - amount,
      });
    }

    for (const [action, kind] of [
      ['SAMPLES_RETURNED', 'SAMPLES_RETURNED'],
      ['SAMPLES_WRITTEN_OFF', 'SAMPLES_WRITTEN_OFF'],
      ['CANCEL', 'CANCELLED'],
    ] as const) {
      const row = auditOf(action);
      if (!row) continue;
      push({
        kind,
        at: row.occurredAt.toISOString(),
        atMs: row.occurredAt.getTime(),
        by: nameOf(row.actorUserId),
        reference: order.orderNo,
        amount: null,
        apply: () => 0,
      });
    }

    // Replay in the order things were recorded…
    const byRecording = [...drafts].sort(
      (x, y) => x.atMs - y.atMs || RANK[x.kind] - RANK[y.kind],
    );
    const effects = new Map<Draft, number>();
    let owes = 0;
    for (const d of byRecording) {
      const next = d.apply(owes);
      effects.set(d, next - owes);
      owes = next;
    }
    // …and show them by the day they happened, the running figure following.
    const shown = [...drafts].sort(
      (x, y) =>
        (x.date < y.date ? -1 : x.date > y.date ? 1 : 0) ||
        x.atMs - y.atMs ||
        RANK[x.kind] - RANK[y.kind],
    );
    let running = 0;
    const events: HistoryEvent[] = shown.map((d) => {
      const effect = effects.get(d) ?? 0;
      running += effect;
      const event: HistoryEvent & Partial<Pick<Draft, 'atMs' | 'apply'>> = {
        ...d,
        effect: money(effect),
        owes: money(running),
      };
      delete event.atMs;
      delete event.apply;
      return event;
    });

    const owesNow = (OWED_STATUSES as readonly string[]).includes(order.status)
      ? cents(order.outstanding)
      : 0;

    return {
      data: {
        orderId: order.id,
        orderNo: order.orderNo,
        status: order.status,
        events,
        /** Per product: what the shop started with, sent back, holds, and at what price now. */
        products: order.items.map((i) => ({
          saleItemId: i.id,
          product: i.product.name,
          productAr: i.product.nameAr,
          startedWith: D(i.quantity).toString(),
          returned: D(i.quantity).sub(heldUnits(i)).toString(),
          holds: heldUnits(i).toString(),
          soldAt: (D(i.quantity).gt(0)
            ? D(i.lineTotal).div(D(i.quantity))
            : D(0)
          ).toFixed(2),
          priceNow: heldUnitPrice(i).toFixed(2),
        })),
        owes: money(owesNow),
        /** The replay's end; equal to `owes` unless the stored figures disagree. */
        replayedOwes: money(owes),
      },
    };
  }
}

/** A return's lines, one per product: batches split a line, a person reads one. */
function mergeLines(
  lines: {
    product: string;
    productAr: string | null;
    qty: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
  }[],
) {
  const merged = new Map<string, (typeof lines)[number]>();
  for (const l of lines) {
    const key = `${l.product}|${l.unitPrice.toFixed(2)}`;
    const seen = merged.get(key);
    merged.set(key, seen ? { ...seen, qty: seen.qty.add(l.qty) } : l);
  }
  return [...merged.values()].map((l) => ({
    product: l.product,
    productAr: l.productAr,
    qty: l.qty.toString(),
    unitPrice: l.unitPrice.toFixed(2),
  }));
}
