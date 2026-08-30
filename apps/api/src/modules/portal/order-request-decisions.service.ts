import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { SalesService } from '../sales/sales.service';
import { badRequest, conflict, notFound } from '../../common/api-error';
import { availableByProduct } from '../../common/available-stock';

/**
 * Answering a request, from the office side.
 *
 * The owner can part-fill and can drop a line — 10 asked for, 6 in stock, so 6
 * approved and the shop is told why. What is approved is what becomes the
 * order, which is why the approved quantities are written onto the request
 * before the order is made: the record of what was asked and what was given
 * has to survive, or a shop querying an invoice has nothing to point at.
 *
 * The order itself is made by `sales.create` and `confirmOrder`. This service
 * decides quantities; it does not know how to price, allocate or confirm an
 * order, and there is exactly one place that does.
 */
@Injectable()
export class OrderRequestDecisionsService {
  constructor(
    private prisma: PrismaService,
    private sales: SalesService,
  ) {}

  /** Everything waiting for an answer, newest first. */
  async listPending() {
    const rows = await this.prisma.orderRequest.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: {
        customer: { select: { id: true, displayName: true, type: true } },
        items: { include: { product: { select: { name: true, sku: true } } } },
      },
    });

    const productIds = [...new Set(rows.flatMap((r) => r.items.map((i) => i.productId)))];
    const available = await availableByProduct(this.prisma, productIds);

    return {
      data: rows.map((r) => ({
        id: r.id,
        requestNo: r.requestNo,
        customer: r.customer,
        note: r.note,
        createdAt: r.createdAt,
        hold: {
          live: Boolean(r.holdExpiresAt && r.holdExpiresAt > new Date()),
          expiresAt: r.holdExpiresAt,
        },
        items: r.items.map((i) => ({
          productId: i.productId,
          name: i.product.name,
          sku: i.product.sku,
          qtyRequested: i.qtyRequested.toString(),
          unitPrice: i.unitPrice.toFixed(2),
          // What could still be given, this request's own hold included, so
          // the screen can show "6 of 10 available" without the request being
          // counted against itself.
          couldGive: (available.get(i.productId) ?? new Prisma.Decimal(0))
            .add(i.qtyRequested)
            .toString(),
        })),
      })),
    };
  }

  /**
   * Approve, in whole or in part.
   *
   * `lines` names the quantity and price actually granted per product. A
   * product left out of `lines` is dropped, and a quantity of zero is the same
   * thing said explicitly.
   */
  async approve(
    id: string,
    actorId: string,
    decision: {
      lines: { productId: string; qtyApproved: number; unitPrice?: number }[];
      decisionNote?: string;
    },
  ) {
    const request = await this.prisma.orderRequest.findUnique({
      where: { id },
      include: { items: true, customer: { select: { type: true, verificationStatus: true } } },
    });
    if (!request) throw notFound('orderRequest');
    if (request.status !== 'PENDING') {
      throw conflict('REQUEST_ALREADY_DECIDED', 'This request has already been answered.');
    }
    if (request.customer.verificationStatus !== 'VERIFIED') {
      throw badRequest(
        'SHOP_NOT_VERIFIED',
        'This shop is not verified yet, so an order cannot be raised for it.',
      );
    }

    const granted = new Map(decision.lines.map((l) => [l.productId, l]));
    for (const productId of granted.keys()) {
      if (!request.items.some((i) => i.productId === productId)) {
        // Approving something that was never asked for would put a line on the
        // shop's order that they never saw a price for.
        throw badRequest(
          'LINE_NOT_REQUESTED',
          'A line was approved that this request never asked for.',
        );
      }
    }

    const kept = request.items
      .map((item) => {
        const line = granted.get(item.productId);
        const qty = new Prisma.Decimal(line?.qtyApproved ?? 0);
        return {
          item,
          qty,
          unitPrice: new Prisma.Decimal(line?.unitPrice ?? item.unitPrice),
        };
      })
      .filter((l) => l.qty.gt(0));

    for (const line of kept) {
      if (line.qty.gt(line.item.qtyRequested)) {
        // More than was asked for. The shop would receive — and be billed for —
        // goods it never requested.
        throw badRequest(
          'APPROVED_MORE_THAN_REQUESTED',
          'A line cannot be approved for more than was requested.',
          { product: line.item.productId },
        );
      }
      if (line.unitPrice.lte(0)) {
        throw badRequest('PRICE_INVALID', 'An approved line must carry a price above zero.');
      }
    }

    if (kept.length === 0) {
      // Approving nothing is a decline wearing a different word, and it would
      // leave a request marked APPROVED against an order for nothing.
      throw badRequest(
        'NOTHING_APPROVED',
        'Nothing was approved. Decline the request instead, so the shop is told why.',
      );
    }

    // Re-check against stock as it is NOW, not as it was when the hold was
    // taken. The hold may have lapsed while the request sat waiting, and
    // approving on the strength of an expired hold would confirm an order for
    // goods that have since been sold.
    const available = await availableByProduct(
      this.prisma,
      kept.map((l) => l.item.productId),
      { orderRequestId: id },
    );

    // Named, not "that product". A refusal a shop cannot act on is barely
    // better than none, and the owner reading it needs to know which line.
    const names = new Map(
      (
        await this.prisma.product.findMany({
          where: { id: { in: kept.map((l) => l.item.productId) } },
          select: { id: true, name: true },
        })
      ).map((p) => [p.id, p.name]),
    );
    for (const line of kept) {
      const have = available.get(line.item.productId) ?? new Prisma.Decimal(0);
      if (line.qty.gt(have)) {
        const name = names.get(line.item.productId) ?? 'that product';
        throw badRequest(
          'NOT_ENOUGH_STOCK',
          `Only ${have.toString()} of ${name} is in stock, so ${line.qty.toString()} cannot be sold.`,
          { available: have.toString(), product: name, wanted: line.qty.toString() },
        );
      }
    }

    // Release this request's holds before the order allocates. The order takes
    // the same units through the normal FIFO path, and leaving the holds in
    // place would have them counted twice — once as held, once as sold.
    await this.prisma.inventoryReservation.updateMany({
      where: { orderRequestId: id, status: 'ACTIVE' },
      data: { status: 'CONSUMED', releasedAt: new Date() },
    });

    const order = await this.sales.create(
      {
        customerId: request.customerId,
        channel: request.customer.type,
        currency: 'EGP',
        items: kept.map((l) => ({
          productId: l.item.productId,
          quantity: Number(l.qty),
          unitPrice: Number(l.unitPrice),
        })),
      },
      actorId,
    );

    const created = (order as any).data ?? order;
    await this.sales.confirmOrder(created.id, actorId, created.version);

    await this.prisma.$transaction([
      ...kept.map((l) =>
        this.prisma.orderRequestItem.update({
          where: { id: l.item.id },
          data: { qtyApproved: l.qty, unitPrice: l.unitPrice },
        }),
      ),
      // Everything not kept is recorded as approved for zero rather than left
      // null, so "dropped" and "not yet decided" cannot be confused later.
      ...request.items
        .filter((i) => !kept.some((k) => k.item.id === i.id))
        .map((i) =>
          this.prisma.orderRequestItem.update({
            where: { id: i.id },
            data: { qtyApproved: new Prisma.Decimal(0) },
          }),
        ),
      this.prisma.orderRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          decisionNote: decision.decisionNote,
          decidedAt: new Date(),
          decidedBy: actorId,
          saleOrderId: created.id,
          holdReleasedAt: new Date(),
        },
      }),
    ]);

    return { data: { requestId: id, orderId: created.id, orderNo: created.orderNo } };
  }

  /** Turn it down, and give the stock back. */
  async decline(id: string, actorId: string, decisionNote: string) {
    if (!decisionNote?.trim()) {
      // A refusal with no reason leaves the shop guessing whether to ask again,
      // and the owner with no record of why they said no.
      throw badRequest('REASON_REQUIRED', 'Tell the shop why, so they know what to do next.');
    }

    return this.prisma.$transaction(async (tx) => {
      const request = await tx.orderRequest.findUnique({ where: { id } });
      if (!request) throw notFound('orderRequest');
      if (request.status !== 'PENDING') {
        throw conflict('REQUEST_ALREADY_DECIDED', 'This request has already been answered.');
      }

      await tx.inventoryReservation.updateMany({
        where: { orderRequestId: id, status: 'ACTIVE' },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });

      await tx.orderRequest.update({
        where: { id },
        data: {
          status: 'DECLINED',
          decisionNote,
          decidedAt: new Date(),
          decidedBy: actorId,
          holdReleasedAt: new Date(),
        },
      });

      return { data: { requestId: id, status: 'DECLINED' } };
    });
  }

  /**
   * Put lapsed holds back on the shelf.
   *
   * Run on a schedule. `availableByProduct` already ignores a hold past its
   * deadline, so stock is never wrongly withheld between the deadline and this
   * running — the sweep is bookkeeping, not the rule. The rule is the deadline.
   */
  async releaseExpiredHolds() {
    const now = new Date();
    const { count } = await this.prisma.inventoryReservation.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lte: now } },
      data: { status: 'RELEASED', releasedAt: now },
    });

    await this.prisma.orderRequest.updateMany({
      where: { status: 'PENDING', holdExpiresAt: { lte: now }, holdReleasedAt: null },
      data: { holdReleasedAt: now },
    });

    return { released: count };
  }
}
