import { pageSize, cursorPage } from '../../common/dto/pagination.dto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { nextReferenceNumber, pad } from '../../common/references';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '@prisma/client';
import { isUniqueViolation } from '../../prisma/unique-violation';

import { badRequest, conflict, notFound } from '../../common/api-error';
import { assertVerified } from '../../common/verified-customer';
import { availableQty } from '../../common/available-stock';
import { businessToday, instantRange } from '../../common/dates';
import {
  PAYMENT_METHODS,
  type PaymentMethod,
  walkInCustomer,
} from '../../common/walk-in';
import { PaymentsService } from '../payments/payments.service';
import {
  NotificationsService,
  notifyLowStock,
  type LowStockNotifier,
} from '../notifications/notifications.service';
import { crossedIntoLowStock, findLowStock } from '../../common/low-stock';
import {
  centsToDecimalString,
  saleOrderTotals,
} from '../../common/sale-totals';

/** The client or a transaction — whichever the caller holds. */
type Db = Prisma.TransactionClient;

/**
 * How many times a sale is tried when another took its order number first.
 * Each loss means one more sale committed in between, so this is how many
 * sales may land at the same instant before the last of them is refused.
 */
const ORDER_NUMBER_ATTEMPTS = 10;

export interface CreateSaleOrderInput {
  /** Who is buying. Left out of a walk-in sale, which has no customer of its own. */
  customerId?: string;
  channel: string;
  currency: string;
  items: {
    productId: string;
    quantity: number;
    unitPrice: number;
    discount?: number;
  }[];
  /** Create and confirm in one transaction (BUSINESS_LOGIC §4, 2026-10-10). */
  confirm?: boolean;
  /**
   * A buyer who is not a shop (BUSINESS_LOGIC §4, 2026-10-11): created,
   * confirmed and paid in full in one step, on the shared walk-in record.
   */
  walkIn?: boolean;
  /** How a walk-in sale was paid. Only with `walkIn`; cash when unsaid. */
  payment?: { method?: string };
}

const refuseShape = (field: string, message: string) =>
  badRequest('VALIDATION_FAILED', message, { fields: field });

@Injectable()
export class SalesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private payments: PaymentsService,
    /**
     * A sale that takes a product into low stock says so (BUSINESS_LOGIC §3,
     * 2026-10-11), through `notifyLowStock`, after the commit.
     */
    @Inject(NotificationsService) private notifications: LowStockNotifier,
  ) {}

  async findAll(pagination: {
    cursor?: string;
    limit?: number;
    customerId?: string;
    status?: string;
    channel?: string;
    /** Calendar days, YYYY-MM-DD, both included, on the day it was ordered. */
    from?: string;
    to?: string;
  }) {
    const {
      cursor,
      limit: rawLimit = 20,
      customerId,
      status,
      channel,
      from,
      to,
    } = pagination;
    const limit = pageSize(rawLimit);
    const ordered = instantRange(from, to);
    const where: any = {
      ...(customerId ? { customerId } : {}),
      ...(status ? { status } : {}),
      ...(channel ? { channel } : {}),
      ...(ordered ? { orderedAt: ordered } : {}),
    };

    const items = await this.prisma.saleOrder.findMany({
      where,
      ...cursorPage(cursor, limit),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        customer: true,
        items: { include: { product: true } },
      },
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    return {
      data,
      meta: {
        nextCursor: hasMore ? data[data.length - 1].id : null,
        limit,
      },
    };
  }

  async findById(id: string) {
    const order = await this.prisma.saleOrder.findUnique({
      where: { id },
      include: {
        customer: true,
        items: {
          include: {
            product: true,
            allocations: { include: { inventoryBatch: true } },
          },
        },
        paymentAllocations: { include: { payment: true } },
      },
    });
    if (!order) throw notFound('saleOrder');
    return { data: order };
  }

  /**
   * Create an order — a draft, or with `confirm: true` a confirmed one.
   *
   * DECIDED 2026-10-10 (BUSINESS_LOGIC §4): created and confirmed in one step,
   * both or neither. The draft and the confirmation run in one transaction
   * through the same `confirmWithin` that `POST /:id/confirm` uses, so a
   * refusal from either (not enough stock, a discount larger than its line)
   * leaves nothing behind — no draft for someone to find later and wonder
   * about.
   *
   * `idempotencyKey` is the form's one key per opened dialog. A request
   * carrying a key this person already created an order with gets that order
   * back instead of a second one: a double-click on "Create & confirm", or a
   * retry after the network dropped, must not sell the goods twice.
   *
   * The key is stored on the order, unique per creator, the way a payment
   * stores its key (`PaymentsService.create`). It lived in a map in this
   * process, which does not hold on Vercel: the retry lands on another
   * instance that never saw the first. Two requests that both read "not there
   * yet" are settled by the index — the loser's insert fails, its transaction
   * rolls back, and it answers with the winner's order.
   *
   * A refusal stores nothing, so fixing the lines and retrying from the same
   * dialog actually runs.
   */
  async create(
    data: CreateSaleOrderInput,
    actorId: string,
    idempotencyKey?: string,
  ) {
    const key = idempotencyKey?.trim() || undefined;
    if (key) {
      const existing = await this.findByKey(actorId, key);
      if (existing) return existing;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.createOnce(data, actorId, key);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if (key) {
          const existing = await this.findByKey(actorId, key);
          if (existing) return existing;
        }
        // Not this request's own retry, so it lost the race for the order
        // number: two sales read the same highest ORD- number before either
        // wrote, and `order_no`'s unique index refused the second. Its
        // transaction has rolled back, nothing of it is left, and running it
        // again reads the winner's number and takes the next one. Every check
        // runs again too — the winner may have sold the last of the stock.
        if (attempt >= ORDER_NUMBER_ATTEMPTS) throw e;
      }
    }
  }

  /** The order this person already created with this key, if any. */
  private async findByKey(actorId: string, idempotencyKey: string) {
    const order = await this.prisma.saleOrder.findUnique({
      where: {
        createdBy_idempotencyKey: { createdBy: actorId, idempotencyKey },
      },
      include: { items: true, customer: true },
    });
    return order ? { data: order } : null;
  }

  private async createOnce(
    data: CreateSaleOrderInput,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<{ data: unknown }> {
    const walkIn = this.walkInRequest(data);
    if (walkIn) {
      return this.createWalkIn(data, walkIn.method, actorId, idempotencyKey);
    }

    if (data?.confirm !== true) {
      const draft = await this.prepareDraft(
        this.prisma,
        data,
        actorId,
        idempotencyKey,
      );
      const order = await this.prisma.saleOrder.create({
        data: draft,
        include: { items: true, customer: true },
      });

      await this.audit.log({
        actorUserId: actorId,
        action: 'CREATE',
        entityType: 'SaleOrder',
        entityId: order.id,
        afterJson: order,
      });

      return { data: order };
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      const draft = await this.prepareDraft(tx, data, actorId, idempotencyKey);
      const order = await tx.saleOrder.create({
        data: draft,
        include: { items: true, customer: true },
      });
      const confirmed = await this.confirmWithin(
        tx,
        order.id,
        actorId,
        order.version,
      );
      return { order, confirmed };
    });

    // After the commit, for the reason given in `confirmOrder`.
    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'SaleOrder',
      entityId: outcome.order.id,
      afterJson: outcome.order,
    });
    await this.audit.log(outcome.confirmed.audit);
    await notifyLowStock(
      this.prisma,
      this.notifications,
      outcome.confirmed.lowStock,
    );

    return {
      data: { ...outcome.confirmed.data, customer: outcome.order.customer },
    };
  }

  /**
   * Whether this is a walk-in sale, and how it was paid — or a refusal for a
   * body that asks for two contradictory things.
   *
   * Checked before anything is read or written. A walk-in sale names no
   * customer, cannot be a draft (it is paid on the spot, §4), and is always
   * B2C; a payment method on an ordinary sale would be silently ignored, so it
   * is refused rather than dropped.
   */
  private walkInRequest(
    data: CreateSaleOrderInput,
  ): { method: PaymentMethod } | null {
    if (data?.walkIn !== undefined && typeof data.walkIn !== 'boolean') {
      throw refuseShape('walkIn', 'walkIn must be true or false.');
    }
    if (data?.walkIn !== true) {
      if (data?.payment !== undefined) {
        throw refuseShape(
          'payment',
          'A payment is taken with the sale only on a walk-in sale.',
        );
      }
      return null;
    }
    if (data.customerId !== undefined && data.customerId !== null) {
      throw refuseShape(
        'customerId',
        'A walk-in sale has no customer; send walkIn or customerId, not both.',
      );
    }
    if (data.confirm === false) {
      throw badRequest(
        'WALK_IN_NOT_DRAFT',
        'A walk-in sale is paid on the spot, so it cannot be saved as a draft.',
      );
    }
    if (data.channel !== undefined && data.channel !== 'B2C') {
      throw refuseShape('channel', 'A walk-in sale is always at B2C prices.');
    }
    if (
      data.payment !== undefined &&
      (data.payment === null || typeof data.payment !== 'object')
    ) {
      throw refuseShape('payment', 'payment must be { method }.');
    }
    const method = data.payment?.method ?? 'CASH';
    if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
      throw refuseShape(
        'payment.method',
        `payment.method must be one of ${PAYMENT_METHODS.join(', ')}.`,
      );
    }
    return { method: method as PaymentMethod };
  }

  /**
   * A walk-in sale (BUSINESS_LOGIC §4, DECIDED 2026-10-11): created, confirmed
   * and paid in full, in ONE transaction, or none of it.
   *
   * Nothing here is a second copy. The order is checked and built by
   * `prepareDraft`, confirmed by `confirmWithin`, and the money is received
   * by `PaymentsService.recordWithin`, which allocates through
   * `allocateWithin` — the same paths a sale and a payment take on their own.
   * A refusal from any of them (not enough stock, a discount larger than its
   * line) rolls back the order, the stock, the payment and, on the first
   * walk-in sale ever, the walk-in record itself.
   *
   * Dated today in Cairo (§7a), not in UTC: a sale at 00:30 is that day's.
   * An order worth nothing (every line free) owes nothing and takes no
   * payment — a zero payment would say money moved when none did.
   */
  private async createWalkIn(
    data: CreateSaleOrderInput,
    method: PaymentMethod,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<{ data: unknown }> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const walkIn = await walkInCustomer(tx);
      const draft = await this.prepareDraft(
        tx,
        {
          ...data,
          customerId: walkIn.id,
          channel: 'B2C',
          currency: data.currency ?? 'EGP',
        },
        actorId,
        idempotencyKey,
        { walkIn: true },
      );
      const order = await tx.saleOrder.create({
        data: draft,
        include: { items: true, customer: true },
      });
      const confirmed = await this.confirmWithin(
        tx,
        order.id,
        actorId,
        order.version,
      );
      const paid = new Prisma.Decimal(order.total).gt(0)
        ? await this.payments.recordWithin(
            tx,
            {
              customerId: walkIn.id,
              amount: Number(order.total),
              currency: order.currency,
              receivedOn: new Date(businessToday()),
              method,
              reference: order.orderNo,
              orderId: order.id,
            },
            actorId,
          )
        : null;
      const settled = await tx.saleOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true, customer: true },
      });
      return { order, confirmed, paid, settled };
    });

    // After the commit, for the reason given in `confirmOrder`.
    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'SaleOrder',
      entityId: outcome.order.id,
      afterJson: { ...outcome.order, walkIn: true },
    });
    await this.audit.log(outcome.confirmed.audit);
    if (outcome.paid) await this.payments.logRecorded(outcome.paid, actorId);
    await notifyLowStock(
      this.prisma,
      this.notifications,
      outcome.confirmed.lowStock,
    );

    return {
      data: {
        ...outcome.settled,
        allocations: outcome.confirmed.data.allocations,
        totalCogs: outcome.confirmed.data.totalCogs,
        payment: outcome.paid?.payment ?? null,
      },
    };
  }

  /**
   * Every check a new order must pass, and the row it becomes.
   *
   * Takes the client or a transaction: on the create-and-confirm path it runs
   * inside the transaction, where reaching for `this.prisma` would wait on the
   * one connection the transaction already holds.
   */
  private async prepareDraft(
    db: Db,
    data: CreateSaleOrderInput,
    actorId: string,
    idempotencyKey?: string,
    { walkIn = false }: { walkIn?: boolean } = {},
  ) {
    // Validate customer exists
    if (!data?.customerId) {
      throw badRequest('CUSTOMER_REQUIRED', 'customerId is required');
    }
    const customer = await db.customer.findUnique({
      where: { id: data.customerId },
    });
    if (!customer) {
      throw notFound('customer');
    }
    assertVerified(customer);
    // The walk-in record is sold to only as a walk-in sale, which is paid on
    // the spot. Named by id on an ordinary sale it would become a draft, or
    // a confirmed order owing money, on a record that must never owe (§4).
    if (customer.isWalkIn && !walkIn) {
      throw badRequest(
        'WALK_IN_RESERVED',
        'The walk-in record is kept by the system; sell to it with walkIn: true.',
      );
    }

    // Validate items array
    if (!data.items || data.items.length === 0) {
      throw badRequest(
        'ORDER_NEEDS_ITEM',
        'Order must contain at least one item',
      );
    }

    // What can be sold right now, from the one definition of it.
    //
    // This was a local aggregate over saleable quantity, which was correct
    // while `InventoryReservation` sat unused. The storefront now lets a shop
    // hold stock while the owner decides, and a local copy here would have gone
    // on selling the held units — the storefront and the office disagreeing
    // about the same shelf, which shows up as a wrong figure on one screen and
    // a right one on the other. `availableQty` subtracts live holds and is read
    // by the catalogue, the request flow and this, all three.
    const availableFor = (productId: string) => availableQty(db, productId);

    // Summed per product, not checked line by line: two lines of 40 against 60
    // in stock is 80, and checking each alone would wave it through.
    const wantedPerProduct = new Map<string, Prisma.Decimal>();
    for (const item of data.items) {
      if (!item.productId || !item.quantity) continue;
      const soFar =
        wantedPerProduct.get(item.productId) ?? new Prisma.Decimal(0);
      wantedPerProduct.set(item.productId, soFar.add(item.quantity));
    }

    // Validate each item
    for (const item of data.items) {
      if (!item.productId) {
        throw badRequest(
          'ITEM_NEEDS_PRODUCT',
          'Each item must have a productId',
        );
      }
      const product = await db.product.findUnique({
        where: { id: item.productId },
      });
      if (!product) {
        throw notFound('product');
      }
      if (!item.quantity || item.quantity <= 0) {
        throw badRequest(
          'QTY_NOT_POSITIVE',
          `Invalid quantity for product ${item.productId}: must be greater than 0`,
        );
      }
      if (item.unitPrice == null || item.unitPrice < 0) {
        throw badRequest(
          'PRICE_NEGATIVE',
          `Invalid unitPrice for product ${item.productId}: must be 0 or greater`,
        );
      }
      // A negative discount is a price rise the line does not show: the
      // customer is charged more than quantity × price, under a column named
      // "discount". Refused here, the one place every create path passes
      // through — draft, create & confirm, and the storefront's approval.
      // (Orders have no edit path; a confirmed order is changed by a return.)
      if (item.discount != null && Number(item.discount) < 0) {
        throw badRequest(
          'DISCOUNT_NEGATIVE',
          `A discount cannot be negative (${item.discount}).`,
          { discount: String(item.discount) },
        );
      }
    }

    // You cannot sell what is not there — and you should be told now, not at
    // the end. Only confirming checked this, so an order for 600 against 60 in
    // stock was built, priced and saved before anything objected.
    for (const [productId, wanted] of wantedPerProduct) {
      const available = await availableFor(productId);
      if (wanted.gt(available)) {
        const product = await db.product.findUnique({
          where: { id: productId },
          select: { name: true },
        });
        throw badRequest(
          'NOT_ENOUGH_STOCK',
          `Only ${available.toFixed(3)} of ${product?.name ?? 'that product'} ` +
            `is in stock, so ${wanted.toFixed(3)} cannot be sold.`,
          {
            available: available.toFixed(3),
            product: product?.name ?? 'that product',
            wanted: wanted.toFixed(3),
          },
        );
      }
    }

    // Generate order number: ORD-YYYY-XXXXX
    const year = new Date().getFullYear();
    const last = await db.saleOrder.findFirst({
      where: { orderNo: { startsWith: `ORD-${year}` } },
      orderBy: { orderNo: 'desc' },
      select: { orderNo: true },
    });
    const orderNo = `ORD-${year}-${pad(nextReferenceNumber(last?.orderNo, 5), 5)}`;

    // The figures come from `saleOrderTotals`, the one formula the order form
    // also shows while it is being typed (`common/sale-totals.ts`).
    const totals = saleOrderTotals(data.items);
    const itemsData = data.items.map((item, i) => {
      const line = totals.lines[i];

      // A discount cannot exceed what the line is worth. Without this the line
      // went negative and took the order with it: a 100 line discounted by
      // 9,999 produced an order totalling -9,899 — a sale that owes money to
      // the customer, and one that would have been counted as revenue.
      if (line.discountCents > line.grossCents) {
        const discount = centsToDecimalString(line.discountCents);
        const gross = centsToDecimalString(line.grossCents);
        throw badRequest(
          'DISCOUNT_EXCEEDS_LINE',
          `Discount ${discount} is more than the line is worth (${gross}).`,
          { discount, gross },
        );
      }

      return {
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: centsToDecimalString(line.discountCents),
        lineTotal: centsToDecimalString(line.lineTotalCents),
      };
    });
    const subtotal = centsToDecimalString(totals.subtotalCents);

    return {
      orderNo,
      customerId: customer.id,
      channel: data.channel,
      currency: data.currency,
      status: 'DRAFT' as const,
      subtotal,
      discount: 0,
      total: subtotal,
      outstanding: subtotal,
      createdBy: actorId,
      idempotencyKey: idempotencyKey ?? null,
      items: { create: itemsData },
    };
  }

  async confirmOrder(id: string, actorId: string, version: number) {
    const outcome = await this.prisma.$transaction((tx) =>
      this.confirmWithin(tx, id, actorId, version),
    );

    // The audit row is written after the commit. `this.audit` uses the outer
    // client, and `connection_limit: 1` means a transaction holds the only
    // connection there is — an audit write from inside waits for one that
    // cannot arrive until the transaction ends, and the transaction cannot
    // end until it returns. P2028 at exactly the ceiling, every time.
    await this.audit.log(outcome.audit);
    // Likewise after the commit: an alert for stock that never left would
    // send somebody to reorder what is still on the shelf.
    await notifyLowStock(this.prisma, this.notifications, outcome.lowStock);
    return { data: outcome.data };
  }

  /**
   * Confirming, inside a transaction the caller owns: FIFO allocation, the
   * stock leaving, the status. The one definition of it — `confirmOrder` and
   * the create-and-confirm path both call this, so a rule added here applies
   * to both and cannot be skipped by choosing the other button.
   */
  private async confirmWithin(
    tx: Db,
    id: string,
    actorId: string,
    version: number,
  ) {
    const order = await tx.saleOrder.findUnique({
      where: { id },
      include: { items: { include: { product: true } } },
    });
    if (!order) throw notFound('order');
    if (order.status !== 'DRAFT')
      throw badRequest(
        'ONLY_DRAFT_CONFIRMABLE',
        'Only draft orders can be confirmed',
      );
    if (order.version !== version)
      throw conflict(
        'ORDER_VERSION_CONFLICT',
        'Version conflict — order was modified',
      );

    const allocations: unknown[] = [];
    let totalCogs = new Prisma.Decimal(0);
    /** How much of each product this sale took, for the low-stock check. */
    const sold = new Map<string, number>();

    for (const item of order.items) {
      sold.set(
        item.productId,
        (sold.get(item.productId) ?? 0) + Number(item.quantity),
      );
      // Quantities and costs stay in Decimal: this COGS is written to the
      // allocation and is what cycle profit is later calculated from, so a
      // float rounding drift here would quietly misstate every settlement.
      let remainingQty = new Prisma.Decimal(item.quantity);

      // FIFO: oldest verified receipt first, batch id breaking any tie.
      const batches = await tx.inventoryBatch.findMany({
        where: {
          productId: item.productId,
          verificationStatus: 'VERIFIED',
          saleableQty: { gt: 0 },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      for (const batch of batches) {
        if (remainingQty.lte(0)) break;
        const available = new Prisma.Decimal(batch.saleableQty);
        const allocQty = Prisma.Decimal.min(remainingQty, available);

        if (allocQty.lte(0)) continue;

        // Confirming is the point the goods leave: these are counter sales
        // to shops and marketplace sales, with no separate dispatch step.
        //
        // remainingQty is what is physically in the room and must fall too.
        // Previously only saleable moved to reserved, so remainingQty never
        // dropped and nothing ever released the reservation — inventory
        // value and unsold-stock-at-close were overstated by everything ever
        // sold, and a returned unit could push a batch above the quantity
        // that arrived.
        await tx.inventoryBatch.update({
          where: { id: batch.id },
          data: {
            saleableQty: { decrement: allocQty },
            remainingQty: { decrement: allocQty },
          },
        });

        // Create movement
        await tx.inventoryMovement.create({
          data: {
            batchId: batch.id,
            movementType: 'SALE',
            qtyDelta: allocQty.neg(),
            referenceType: 'SALE_ORDER',
            referenceId: id,
            createdBy: actorId,
          },
        });

        const unitCost = new Prisma.Decimal(batch.landedUnitCostEgp);
        const cogs = allocQty.mul(unitCost).toDecimalPlaces(2);
        totalCogs = totalCogs.add(cogs);

        // Create allocation
        const allocation = await tx.saleItemAllocation.create({
          data: {
            saleItemId: item.id,
            inventoryBatchId: batch.id,
            qty: allocQty,
            unitCostEgp: unitCost,
            cogsEgp: cogs,
          },
        });

        allocations.push(allocation);
        remainingQty = remainingQty.sub(allocQty);
      }

      if (remainingQty.gt(0)) {
        throw badRequest(
          'INSUFFICIENT_STOCK',
          `Insufficient stock for ${item.product.name}. Missing: ${remainingQty.toFixed(3)}`,
          { product: item.product.name, missing: remainingQty.toFixed(3) },
        );
      }
    }

    // Low stock after this sale, by the one rule (common/low-stock.ts), read
    // through `tx` so it sees the stock this sale just took. Only products
    // the sale took *into* low stock: one already low stays quiet until it
    // has been back above its minimum (BUSINESS_LOGIC §3, 2026-10-11). The
    // alert itself is sent by the caller, after the commit.
    const lowStock = crossedIntoLowStock(
      await findLowStock(tx, [...sold.keys()]),
      sold,
    );

    // Update order status
    const updatedOrder = await tx.saleOrder.update({
      where: { id, version },
      data: { status: 'CONFIRMED', version: { increment: 1 } },
      include: { items: true },
    });

    // No ledger entry is raised here, deliberately.
    //
    // Confirming a sale is not the arrival of money — the shop takes the
    // goods and pays later, often over weeks. Booking revenue here as well
    // as on each payment counted the same sale twice: 31,200 of orders
    // produced 72,710 of ledger revenue.
    //
    // DECIDED 2026-08-22: the ledger records money as it is received. The
    // sale itself is not lost — the order records it, and what has been sold
    // but not yet collected is reported as receivables, which is the gap
    // between the two.

    return {
      audit: {
        actorUserId: actorId,
        action: 'CONFIRM',
        entityType: 'SaleOrder',
        entityId: id,
        beforeJson: { status: 'DRAFT' },
        afterJson: { status: 'CONFIRMED', cogs: Number(totalCogs) },
      },
      lowStock,
      data: {
        ...updatedOrder,
        allocations,
        totalCogs: Number(totalCogs),
      },
    };
  }

  async cancelOrder(id: string, actorId: string) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const order = await tx.saleOrder.findUnique({
        where: { id },
        include: { items: { include: { allocations: true } } },
      });
      if (!order) throw notFound('order');
      if (order.status === 'CANCELLED' || order.status === 'RETURNED') {
        throw badRequest(
          'ORDER_ALREADY_CLOSED',
          'Order is already cancelled/returned',
        );
      }

      // DECIDED 2026-08-23: an order that has been paid against cannot be
      // cancelled.
      //
      // Cancelling put the stock back and marked the order dead, and did
      // nothing at all about the money. The allocation stayed pointing at the
      // cancelled order: it cleared nothing, could not be applied anywhere
      // else, and still read as collected — the order vanished from what the
      // shop owed while their payment stayed spent on it.
      //
      // Money coming back is a refund, and a refund is a return: goods, cost
      // and cash all move together there. Cancelling is for an order that
      // never happened.
      const paid = await tx.paymentAllocation.aggregate({
        where: { saleOrderId: id },
        _sum: { amount: true },
      });
      const paidAmount = Number(paid._sum.amount ?? 0);
      if (paidAmount > 0) {
        throw badRequest(
          'ORDER_PAID_CANNOT_CANCEL',
          `${paidAmount.toFixed(2)} has already been paid against ${order.orderNo}, ` +
            'so it cannot be cancelled. Record a return instead, which refunds the ' +
            'money and puts the stock back.',
          { paid: paidAmount.toFixed(2), order: order.orderNo },
        );
      }

      // Release any reservations/allocations
      for (const item of order.items) {
        for (const alloc of item.allocations) {
          // Restore batch quantities
          await tx.inventoryBatch.update({
            where: { id: alloc.inventoryBatchId },
            data: {
              saleableQty: { increment: Number(alloc.qty) },
              remainingQty: { increment: Number(alloc.qty) },
            },
          });

          // Create release movement
          await tx.inventoryMovement.create({
            data: {
              batchId: alloc.inventoryBatchId,
              movementType: 'RELEASE',
              qtyDelta: Number(alloc.qty),
              referenceType: 'SALE_ORDER_CANCEL',
              referenceId: id,
              createdBy: actorId,
            },
          });
        }
      }

      const updated = await tx.saleOrder.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });

      return {
        audit: {
          actorUserId: actorId,
          action: 'CANCEL',
          entityType: 'SaleOrder',
          entityId: id,
          beforeJson: { status: order.status },
          afterJson: { status: 'CANCELLED' },
        },
        data: updated,
      };
    });

    // The audit row is written after the commit. `this.audit` uses the outer
    // client, and `connection_limit: 1` means a transaction holds the only
    // connection there is — an audit write from inside waits for one that
    // cannot arrive until the transaction ends, and the transaction cannot
    // end until it returns. P2028 at exactly the ceiling, every time.
    await this.audit.log(outcome.audit);
    return { data: outcome.data };
  }
}
