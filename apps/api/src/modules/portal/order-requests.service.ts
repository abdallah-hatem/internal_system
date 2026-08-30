import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { badRequest, conflict, notFound } from '../../common/api-error';
import { nextReferenceNumber, pad } from '../../common/references';
import { availableByProduct } from '../../common/available-stock';
import { channelFor, priceOn } from './portal-pricing';
import { PortalNotifier } from '../notifications/portal-notifier.service';

/**
 * A shop asking to buy, and the stock that waits while the owner decides.
 *
 * The hold is the reason this is more than a form. Submitting a request sets
 * units aside so a second shop cannot be promised the same ones, and that hold
 * has a deadline — 48 hours, agreed with the owner on 2026-08-30 — because an
 * unanswered request that holds stock forever is how the reservation table came
 * to be written and then left unused.
 *
 * When the deadline passes the units go back on the shelf and the request stays
 * answerable. Expiry is not a decision; it only stops the request from costing
 * anything while it waits.
 */

/** Agreed 2026-08-30. Written down in docs/business-rules.md. */
export const HOLD_HOURS = 48;

@Injectable()
export class OrderRequestsService {
  constructor(
    private prisma: PrismaService,
    private notifier: PortalNotifier,
  ) {}

  // ── Submitting ──────────────────────────────────────────────────────

  /**
   * Take a request, and hold the stock behind it.
   *
   * All of it in one transaction: checking availability and then taking the
   * hold in two would let two shops both pass the check before either wrote a
   * reservation, and both would be told yes for the same units.
   */
  async submit(
    customerId: string,
    data: { items: { productId: string; quantity: number }[]; note?: string },
  ) {
    if (!data.items?.length) {
      throw badRequest('REQUEST_NEEDS_ITEM', 'A request must ask for at least one product.');
    }

    // Summed per product before anything is checked: two lines of 40 against 60
    // in stock is 80, and checking each line alone would wave it through. The
    // sales service learned this the same way.
    const wanted = new Map<string, Prisma.Decimal>();
    for (const item of data.items) {
      const qty = new Prisma.Decimal(item.quantity ?? 0);
      if (qty.lte(0)) {
        throw badRequest('REQUEST_QTY_INVALID', 'Every line must ask for more than zero.');
      }
      wanted.set(item.productId, (wanted.get(item.productId) ?? new Prisma.Decimal(0)).add(qty));
    }

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, type: true, verificationStatus: true },
    });
    if (!customer) throw notFound('customer');

    // An unverified shop may browse and may ask for something imported, but it
    // cannot hold stock. Nothing has been agreed with them yet, and a hold is
    // a promise.
    if (customer.verificationStatus !== 'VERIFIED') {
      throw badRequest(
        'SHOP_NOT_VERIFIED',
        'Your account is still being reviewed, so orders cannot be placed yet.',
      );
    }

    const channel = channelFor({ customer });
    const productIds = [...wanted.keys()];

    const created = await this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, status: 'ACTIVE' },
        include: { prices: { select: { channel: true, amount: true, effectiveTo: true } } },
      });
      if (products.length !== productIds.length) {
        // A product id that is not a product. A clear refusal, not a foreign
        // key failing deep in Prisma as "an unexpected error occurred".
        throw notFound('product');
      }

      const available = await availableByProduct(tx, productIds);

      for (const product of products) {
        const asked = wanted.get(product.id)!;
        const have = available.get(product.id) ?? new Prisma.Decimal(0);
        if (asked.gt(have)) {
          // All three params, because the translation interpolates all three.
          // next-intl does not throw on a missing ICU argument — it returns the
          // key path — so a shop would have read the literal string
          // "errors.NOT_ENOUGH_STOCK" on the screen.
          throw badRequest(
            'NOT_ENOUGH_STOCK',
            `Only ${have.toString()} of ${product.name} is in stock, so ${asked.toString()} cannot be sold.`,
            { available: have.toString(), product: product.name, wanted: asked.toString() },
          );
        }
        if (!priceOn(product.prices, channel)) {
          throw badRequest('PRODUCT_NOT_PRICED', `${product.name} has no price yet.`, {
            product: product.name,
          });
        }
      }

      const last = await tx.orderRequest.findFirst({
        orderBy: { requestNo: 'desc' },
        select: { requestNo: true },
      });
      const year = new Date().getFullYear();
      const requestNo = `REQ-${year}-${pad(nextReferenceNumber(last?.requestNo, 4), 4)}`;

      const holdExpiresAt = new Date(Date.now() + HOLD_HOURS * 60 * 60 * 1000);

      const request = await tx.orderRequest.create({
        data: {
          requestNo,
          customerId,
          note: data.note,
          holdExpiresAt,
          items: {
            create: products.map((p) => ({
              productId: p.id,
              qtyRequested: wanted.get(p.id)!,
              unitPrice: priceOn(p.prices, channel)!,
            })),
          },
        },
        include: { items: true },
      });

      await this.holdStock(tx, request.id, wanted, holdExpiresAt);

      return this.detail(tx, request.id, customerId);
    });

    // After the commit, never inside it. A notification is not part of the
    // request, and a transaction held open while a push service is reached is
    // a transaction holding row locks on inventory for the duration.
    await this.notifier.orderRequestSubmitted({
      requestId: created.id,
      requestNo: created.requestNo,
      shopName: (await this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { displayName: true },
      }))!.displayName,
    });

    return { data: created };
  }

  /**
   * Set the units aside, oldest batch first.
   *
   * FIFO matches how a sale allocates, so a request holds the same units the
   * order would have taken. Holding the newest instead would leave the oldest
   * stock ageing on the shelf behind a hold that never touches it.
   */
  private async holdStock(
    tx: Prisma.TransactionClient,
    orderRequestId: string,
    wanted: Map<string, Prisma.Decimal>,
    expiresAt: Date,
  ) {
    for (const [productId, qty] of wanted) {
      let remaining = qty;

      const batches = await tx.inventoryBatch.findMany({
        where: { productId, verificationStatus: 'VERIFIED', saleableQty: { gt: 0 } },
        orderBy: { createdAt: 'asc' },
      });

      for (const batch of batches) {
        if (remaining.lte(0)) break;

        // What is free on THIS batch, not what the batch holds: an earlier
        // request may already be sitting on part of it.
        const heldHere = await tx.inventoryReservation.aggregate({
          where: {
            batchId: batch.id,
            status: 'ACTIVE',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          _sum: { qty: true },
        });
        const free = new Prisma.Decimal(batch.saleableQty).sub(heldHere._sum.qty ?? 0);
        if (free.lte(0)) continue;

        const take = Prisma.Decimal.min(free, remaining);
        await tx.inventoryReservation.create({
          data: { batchId: batch.id, orderRequestId, qty: take, expiresAt, status: 'ACTIVE' },
        });
        remaining = remaining.sub(take);
      }

      if (remaining.gt(0)) {
        // The availability check above passed and yet the batches cannot cover
        // it. That means something changed under us inside the transaction, and
        // the honest response is to fail rather than hold less than was asked
        // for and let the shop believe otherwise.
        throw conflict(
          'STOCK_TAKEN_MEANWHILE',
          'Some of that stock was taken while your request was being placed. Please try again.',
        );
      }
    }
  }

  // ── Reading ─────────────────────────────────────────────────────────

  /** Every request this shop has made. Never anyone else's. */
  async listForShop(customerId: string) {
    const rows = await this.prisma.orderRequest.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: {
        items: { include: { product: { select: { name: true, sku: true } } } },
        saleOrder: { select: { id: true, orderNo: true, total: true, status: true } },
      },
    });

    return { data: rows.map((r) => this.present(r)) };
  }

  async detailForShop(customerId: string, id: string) {
    return { data: await this.detail(this.prisma, id, customerId) };
  }

  /**
   * One request, scoped to its owner.
   *
   * `customerId` is part of the lookup rather than checked after it. A find
   * followed by an `if` is the shape that gets forgotten, and forgetting it
   * here means one shop reading another's prices and quantities.
   */
  private async detail(db: Prisma.TransactionClient | PrismaService, id: string, customerId: string) {
    const row = await db.orderRequest.findFirst({
      where: { id, customerId },
      include: {
        items: { include: { product: { select: { name: true, sku: true } } } },
        saleOrder: { select: { id: true, orderNo: true, total: true, status: true } },
      },
    });
    if (!row) throw notFound('orderRequest');
    return this.present(row);
  }

  private present(r: any) {
    const holdLive =
      r.status === 'PENDING' && r.holdExpiresAt && new Date(r.holdExpiresAt) > new Date();

    return {
      id: r.id,
      requestNo: r.requestNo,
      status: r.status,
      note: r.note,
      decisionNote: r.decisionNote,
      // Reported as live or not rather than as a raw timestamp the storefront
      // would have to compare against its own clock — a phone with the wrong
      // time would otherwise show a hold that has expired as still running.
      hold: {
        live: Boolean(holdLive),
        expiresAt: r.holdExpiresAt,
        releasedAt: r.holdReleasedAt,
      },
      items: r.items.map((i: any) => ({
        productId: i.productId,
        name: i.product.name,
        sku: i.product.sku,
        qtyRequested: i.qtyRequested.toString(),
        qtyApproved: i.qtyApproved?.toString() ?? null,
        unitPrice: i.unitPrice.toFixed(2),
      })),
      order: r.saleOrder
        ? {
            id: r.saleOrder.id,
            orderNo: r.saleOrder.orderNo,
            total: r.saleOrder.total.toFixed(2),
            status: r.saleOrder.status,
          }
        : null,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
    };
  }

  // ── Withdrawing ─────────────────────────────────────────────────────

  /** A shop changing its mind, which must give the stock back. */
  async cancel(customerId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.orderRequest.findFirst({ where: { id, customerId } });
      if (!request) throw notFound('orderRequest');
      if (request.status !== 'PENDING') {
        throw conflict(
          'REQUEST_ALREADY_DECIDED',
          'This request has already been answered and cannot be withdrawn.',
        );
      }

      await tx.inventoryReservation.updateMany({
        where: { orderRequestId: id, status: 'ACTIVE' },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      await tx.orderRequest.update({
        where: { id },
        data: { status: 'CANCELLED', holdReleasedAt: new Date() },
      });

      return { data: await this.detail(tx, id, customerId) };
    });
  }
}
