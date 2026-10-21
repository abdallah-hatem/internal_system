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
import {
  businessDay,
  businessToday,
  chosenDay,
  endOfBusinessDay,
  instantOfDay,
  instantRange,
} from '../../common/dates';
import { isUuid } from '../../common/uuid';
import { OWED_STATUSES } from '../../common/customer-balance';
import {
  buildStatement,
  loadStatementSource,
} from '../../common/customer-statement';
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
import {
  centsText,
  type CostLayer,
  priceAgainstCost,
  unitFigure,
} from '../../common/below-cost';
import {
  daysAtShop,
  isSamplesStatus,
  planSamplesConversion,
  samplesReminderDay,
  samplesRemindersDue,
  SAMPLES_OPEN_STATUS,
  SAMPLES_REMINDER_DAYS,
} from '../../common/samples';

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
  /**
   * The Cairo day the sale was made, YYYY-MM-DD (BUSINESS_LOGIC §4,
   * 2026-10-16). Today when left out; never a day that has not arrived. A
   * sale dated in the past draws only stock received on or before that day.
   */
  orderedOn?: string;
  /**
   * Leave the lines at the shop as samples, with no charge yet (BUSINESS_LOGIC
   * §4, "Samples at shops", owner 2026-10-18). The units leave the shelf; no
   * sale, nothing owed, until the shop decides. Prices are optional — a price
   * given is only noted, for the decision to start from.
   */
  samples?: boolean;
}

/**
 * "They're buying" (§4, samples at shops; owner 2026-10-18 round 2): the New
 * Order popup's lines, as a new sale sends them. The customer is the shop the
 * samples were left with (sent or not); the channel and currency default to
 * the samples order's; the day defaults to today.
 */
export interface SamplesConversionInput {
  customerId?: string | null;
  channel?: string;
  currency?: string;
  orderedOn?: string;
  items: CreateSaleOrderInput['items'];
}

/** What the price check is asked: the lines as they stand on a form. */
export interface PriceCheckInput {
  /** The sale's currency. Only EGP is compared — the cost is in pounds. */
  currency?: string;
  /** The sale's day: a past day is costed from the stock there was then. */
  orderedOn?: string;
  items: {
    productId: string;
    quantity: number | string;
    unitPrice: number | string;
    discount?: number | string | null;
  }[];
}

/** One line of the answer. Figures are EGP decimal strings, null when not costed. */
export interface PriceCheckLine {
  /** 1-based, in the order sent. */
  line: number;
  productId: string;
  costed: boolean;
  reason?: 'NO_STOCK' | 'INCOMPLETE' | 'CURRENCY';
  belowCost: boolean;
  /** The warning's code, for the client to say in the reader's language. */
  code: 'BELOW_COST' | null;
  /** What each unit costs: the line's FIFO cost over its quantity. */
  unitCostEgp: string | null;
  /** What each unit is sold at after the line discount. */
  unitPriceEgp: string | null;
  costEgp: string | null;
  netEgp: string | null;
  lossEgp: string | null;
}

/** A form can hold a few dozen lines; this is a ceiling on the work, not a rule. */
const PRICE_CHECK_MAX_LINES = 200;

/**
 * The batches a sale of this product draws from, in the order it draws them:
 * verified, something left to sell, oldest received first, batch id breaking a
 * tie (BUSINESS_LOGIC §3). Confirming allocates from exactly this list and the
 * price check costs from it, so the warning can never name a cost the sale
 * would not record.
 */
export function fifoBatches(
  db: Pick<Prisma.TransactionClient, 'inventoryBatch'>,
  productId: string,
  /** Only batches received before this instant (a sale dated in the past). */
  receivedBefore?: Date,
) {
  return db.inventoryBatch.findMany({
    where: {
      productId,
      verificationStatus: 'VERIFIED',
      saleableQty: { gt: 0 },
      ...(receivedBefore ? { createdAt: { lt: receivedBefore } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/**
 * The stock a sale on `day` may draw (BUSINESS_LOGIC §4, 2026-10-16): only
 * batches received on or before that day — a batch's `createdAt` is the
 * instant it was received (§3).
 *
 * Only a sale dated **before the day it was entered** (`enteredOn`, today for
 * a new one) is cut off. A sale entered for its own day draws the whole shelf,
 * exactly as before the day could be chosen — and so does a draft saved on
 * Monday for Monday and confirmed on Wednesday: it was never back-dated, and
 * confirming is when the goods leave (§3).
 */
export function receivedCutoff(
  day: string,
  enteredOn: string = businessToday(),
): Date | undefined {
  return day < enteredOn ? endOfBusinessDay(day) : undefined;
}

/** The stock a sale on `day` had was short: names the day and what there was. */
function notEnoughOnDay(
  product: string,
  day: string,
  available: Prisma.Decimal,
  wanted: Prisma.Decimal,
) {
  return badRequest(
    'NOT_ENOUGH_STOCK_ON_DATE',
    `Only ${available.toFixed(3)} of ${product} had been received by ${day}, ` +
      `so ${wanted.toFixed(3)} cannot have been sold that day.`,
    {
      product,
      day,
      available: available.toFixed(3),
      wanted: wanted.toFixed(3),
    },
  );
}

/** Not enough on the shelf for a sale: on its own day when back-dated, else now. */
function notEnoughStock(
  product: string,
  available: Prisma.Decimal,
  wanted: Prisma.Decimal,
  day: string,
  cutoff: Date | undefined,
) {
  if (cutoff) return notEnoughOnDay(product, day, available, wanted);
  return badRequest(
    'NOT_ENOUGH_STOCK',
    `Only ${available.toFixed(3)} of ${product} ` +
      `is in stock, so ${wanted.toFixed(3)} cannot be sold.`,
    {
      available: available.toFixed(3),
      product,
      wanted: wanted.toFixed(3),
    },
  );
}

/**
 * An order's lines as rows, and its subtotal. The figures come from
 * `saleOrderTotals`, the one formula the order form also shows while it is
 * being typed (`common/sale-totals.ts`). A new order and a sale completed
 * from samples (§4) both build their lines here.
 */
function saleLines(items: CreateSaleOrderInput['items']) {
  const totals = saleOrderTotals(items);
  const itemsData = items.map((item, i) => {
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
  return { itemsData, subtotal: centsToDecimalString(totals.subtotalCents) };
}

const refuseShape = (field: string, message: string) =>
  badRequest('VALIDATION_FAILED', message, { fields: field });

/**
 * A samples order as a screen reads it (§4, samples at shops): how many units
 * are out, the day they were left, how long ago, and the day the reminder is
 * due. Null for an order that never was samples. Worked out here, once, so the
 * list, the order and the assistant cannot disagree about the reminder day.
 */
export function samplesSummary(
  order: {
    status: string;
    samplesLeftAt?: Date | null;
    samplesDecidedAt?: Date | null;
    samplesRemindedAt?: Date | null;
    items?: { quantity: Prisma.Decimal.Value }[];
  },
  now = new Date(),
) {
  if (!order.samplesLeftAt) return null;
  const open = order.status === SAMPLES_OPEN_STATUS;
  return {
    open,
    unitsOut: open
      ? (order.items ?? [])
          .reduce((s, i) => s.add(i.quantity), new Prisma.Decimal(0))
          .toString()
      : '0',
    leftOn: businessDay(order.samplesLeftAt),
    daysAtShop: daysAtShop(order.samplesLeftAt, now),
    reminderOn: samplesReminderDay(order.samplesLeftAt),
    remindedAt: order.samplesRemindedAt ?? null,
    decidedAt: order.samplesDecidedAt ?? null,
  };
}

/** The order is not samples at a shop, or no longer is. */
function notOpenSamples(order: {
  orderNo: string;
  status: string;
  samplesLeftAt: Date | null;
}) {
  // Began as samples and has since been decided: bought, returned or
  // written off. Saying "already decided" is the second visit's answer.
  if (isSamplesStatus(order.status) || order.samplesLeftAt) {
    return badRequest(
      'SAMPLES_ALREADY_DECIDED',
      `${order.orderNo} is no longer samples at the shop (${order.status}); what the shop decided is already recorded.`,
      { order: order.orderNo, status: order.status },
    );
  }
  return badRequest(
    'NOT_SAMPLES',
    `${order.orderNo} is not samples left at a shop.`,
    { order: order.orderNo },
  );
}

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
    const now = new Date();
    const data = (hasMore ? items.slice(0, limit) : items).map((o) => ({
      ...o,
      samples: samplesSummary(o, now),
    }));
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
        paymentPlan: { select: { id: true, reference: true, status: true } },
      },
    });
    if (!order) throw notFound('saleOrder');
    // Whether the sale has its instalment plan (§7, 2026-10-16), so the
    // popup's Contract button opens the contract instead of a new plan. A
    // cancelled plan has let go of the sale.
    const { paymentPlan, ...rest } = order;
    const contractPlan =
      paymentPlan && paymentPlan.status !== 'CANCELLED' ? paymentPlan : null;
    return {
      data: { ...rest, contractPlan, samples: samplesSummary(order) },
    };
  }

  /**
   * A confirmed sale as an invoice / delivery note (BUSINESS_LOGIC §4,
   * 2026-10-11): the shop, the order, its lines and totals, what has been
   * paid on it and what it still owes, and — for a shop with an account — the
   * balance before this sale and after it, from the shop's own statement so
   * the two documents cannot disagree.
   *
   * A draft is not a sale yet and a cancelled order never happened (§4):
   * neither has an invoice.
   */
  async invoice(id: string) {
    if (!isUuid(id)) throw notFound('saleOrder');
    const order = await this.prisma.saleOrder.findUnique({
      where: { id },
      include: {
        customer: {
          select: { id: true, displayName: true, phone: true, isWalkIn: true },
        },
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            product: { select: { name: true, nameAr: true, sku: true } },
          },
        },
        paymentAllocations: {
          select: { amount: true, payment: { select: { status: true } } },
        },
        priceAdjustments: { select: { amountEgp: true } },
      },
    });
    if (!order) throw notFound('saleOrder');
    if (order.status === 'DRAFT') {
      throw badRequest(
        'INVOICE_DRAFT',
        `Order ${order.orderNo} is a draft, so it has no invoice yet.`,
        { order: order.orderNo },
      );
    }
    if (order.status === 'CANCELLED') {
      throw badRequest(
        'INVOICE_CANCELLED',
        `Order ${order.orderNo} was cancelled, so it has no invoice.`,
        { order: order.orderNo },
      );
    }
    // Samples are not a sale: nothing was charged, so there is nothing to
    // invoice until the shop buys (§4, samples at shops).
    if (isSamplesStatus(order.status)) {
      throw badRequest(
        'INVOICE_SAMPLES',
        `Order ${order.orderNo} is samples left at a shop, not a sale, so it has no invoice.`,
        { order: order.orderNo },
      );
    }

    // Money still standing on the order; a reversed payment no longer pays it.
    const paid = order.paymentAllocations
      .filter((a) => a.payment.status !== 'REVERSED')
      .reduce((s, a) => s.add(a.amount), new Prisma.Decimal(0));
    const priceLowered = order.priceAdjustments.reduce(
      (s, a) => s.add(a.amountEgp),
      new Prisma.Decimal(0),
    );
    // What it owes counts only while the order is owed at all (§7a): a
    // returned order owes nothing, whatever its stored figure.
    const owes = (OWED_STATUSES as readonly string[]).includes(order.status)
      ? new Prisma.Decimal(order.outstanding)
      : new Prisma.Decimal(0);

    let account: {
      balanceBefore: string;
      balanceAfter: string;
      balanceNow: string;
    } | null = null;
    if (!order.customer.isWalkIn) {
      const statement = buildStatement(
        {
          id: order.customer.id,
          displayName: order.customer.displayName,
          phone: order.customer.phone,
        },
        await loadStatementSource(this.prisma, order.customerId),
      );
      const row = statement.rows.find(
        (r) => r.kind === 'SALE' && r.orderId === order.id,
      );
      if (row) {
        account = {
          balanceBefore: new Prisma.Decimal(row.balance)
            .sub(row.effect)
            .toFixed(2),
          balanceAfter: row.balance,
          balanceNow: statement.closingBalance,
        };
      }
    }

    const subtotal = order.items.reduce(
      (s, it) => s.add(new Prisma.Decimal(it.unitPrice).mul(it.quantity)),
      new Prisma.Decimal(0),
    );
    const discount = order.items.reduce(
      (s, it) => s.add(it.discount),
      new Prisma.Decimal(0),
    );

    return {
      data: {
        id: order.id,
        orderNo: order.orderNo,
        status: order.status,
        channel: order.channel,
        currency: order.currency,
        date: businessDay(order.orderedAt),
        customer: {
          id: order.customer.id,
          displayName: order.customer.displayName,
          phone: order.customer.phone,
          isWalkIn: order.customer.isWalkIn,
        },
        lines: order.items.map((it) => ({
          id: it.id,
          productId: it.productId,
          product: it.product.name,
          // The Arabic, when there is one; the page picks (§3, 2026-10-14).
          productAr: it.product.nameAr,
          sku: it.product.sku,
          quantity: new Prisma.Decimal(it.quantity).toString(),
          unitPrice: new Prisma.Decimal(it.unitPrice).toFixed(2),
          discount: new Prisma.Decimal(it.discount).toFixed(2),
          lineTotal: new Prisma.Decimal(it.lineTotal).toFixed(2),
        })),
        subtotal: subtotal.toFixed(2),
        discount: discount.toFixed(2),
        total: new Prisma.Decimal(order.total).toFixed(2),
        paid: paid.toFixed(2),
        // Prices lowered after the sale (§4, 2026-10-22), its own line.
        priceLowered: priceLowered.toFixed(2),
        // What returns took off what this order owes — a credit note lowers
        // it (§5) — so total, paid, lowered, credited and owed add up on
        // paper. A returned order owes nothing and says so instead.
        credited:
          order.status === 'RETURNED'
            ? '0.00'
            : Prisma.Decimal.max(
                new Prisma.Decimal(order.total)
                  .sub(paid)
                  .sub(priceLowered)
                  .sub(owes),
                0,
              ).toFixed(2),
        returned: order.status === 'RETURNED',
        owes: owes.toFixed(2),
        account,
      },
    };
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
    if (data?.samples !== undefined && typeof data.samples !== 'boolean') {
      throw refuseShape('samples', 'samples must be true or false.');
    }
    if (data?.samples === true) {
      // Samples go to a shop that can decide later; a walk-in buyer has no
      // account to come back to, and a samples order is never a draft.
      if (data.walkIn === true) {
        throw badRequest(
          'SAMPLES_NEED_SHOP',
          'Samples are left with a shop, so they need a customer — not a walk-in.',
        );
      }
      if (data.payment !== undefined) {
        throw refuseShape(
          'payment',
          'Samples are not charged, so no payment is taken.',
        );
      }
      if (data.confirm === false) {
        throw refuseShape(
          'confirm',
          'Samples leave the shelf when saved; they are never a draft.',
        );
      }
      return this.leaveSamples(data, actorId, idempotencyKey);
    }
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
   * Dated the sale's day in Cairo (§7a), not in UTC: a sale at 00:30 is that
   * day's, and a walk-in sale entered later for an earlier day (§4,
   * 2026-10-16) was paid that earlier day.
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
              // Paid on the spot: the day of the sale (§4).
              receivedOn: new Date(businessDay(order.orderedAt)),
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
    {
      walkIn = false,
      samples = false,
    }: { walkIn?: boolean; samples?: boolean } = {},
  ) {
    // The day it was sold (§4, 2026-10-16): checked before anything is read.
    // Samples are left on a day the same way, and draw the stock of that day.
    const day = chosenDay(data?.orderedOn, 'SALE_MADE');
    const cutoff = receivedCutoff(day);
    // A samples line's price is optional (DECIDED, owner 2026-10-18): it is
    // set when the shop decides. One that is given is kept as a note; one left
    // out is 0, and nothing is charged either way. No discount: there is no
    // charge to discount.
    if (samples && Array.isArray(data?.items)) {
      data = {
        ...data,
        items: data.items.map((item) => ({
          ...item,
          unitPrice:
            item?.unitPrice === undefined || item?.unitPrice === null
              ? 0
              : item.unitPrice,
          discount: 0,
        })),
      };
    }

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
    if (samples && customer.isWalkIn) {
      throw badRequest(
        'SAMPLES_NEED_SHOP',
        'Samples are left with a shop, so they need a customer — not a walk-in.',
      );
    }
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
    //
    // A sale dated in the past counts only the stock received by the end of
    // that day: goods that arrived afterwards cannot have been sold then.
    const availableFor = (productId: string) =>
      availableQty(db, productId, undefined, cutoff);

    // Summed per product, not checked line by line: two lines of 40 against 60
    // in stock is 80, and checking each alone would wave it through.
    const wantedPerProduct = new Map<string, Prisma.Decimal>();
    for (const item of data.items) {
      if (!item.productId || !item.quantity) continue;
      const soFar =
        wantedPerProduct.get(item.productId) ?? new Prisma.Decimal(0);
      wantedPerProduct.set(item.productId, soFar.add(item.quantity));
    }

    await this.checkLines(db, data.items);

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
        throw notEnoughStock(
          product?.name ?? 'that product',
          available,
          wanted,
          day,
          cutoff,
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

    const { itemsData, subtotal: charged } = saleLines(data.items);
    // Samples owe nothing and are worth nothing as a sale until the shop
    // decides: the order and its lines total zero, whatever price was noted.
    const subtotal = samples ? '0.00' : charged;
    if (samples) {
      for (const line of itemsData) line.lineTotal = '0.00';
    }

    return {
      orderNo,
      customerId: customer.id,
      channel: data.channel,
      currency: data.currency,
      status: 'DRAFT' as const,
      orderedAt: instantOfDay(day),
      subtotal,
      discount: 0,
      total: subtotal,
      outstanding: subtotal,
      createdBy: actorId,
      idempotencyKey: idempotencyKey ?? null,
      items: { create: itemsData },
    };
  }

  /**
   * Each line of an order, checked: a product that exists, a quantity above
   * zero, a price of 0 or more, and no negative discount. The one place every
   * path that builds lines passes through — draft, create & confirm, the
   * storefront's approval, and a sale completed from samples (§4).
   */
  private async checkLines(db: Db, items: CreateSaleOrderInput['items']) {
    for (const item of items) {
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
      // "discount". (Orders have no edit path; a confirmed order is changed
      // by a return.)
      if (item.discount != null && Number(item.discount) < 0) {
        throw badRequest(
          'DISCOUNT_NEGATIVE',
          `A discount cannot be negative (${item.discount}).`,
          { discount: String(item.discount) },
        );
      }
    }
  }

  /**
   * Would these lines sell below cost? (BUSINESS_LOGIC §4, DECIDED 2026-10-11.)
   *
   * A warning, never a refusal: nothing here stops a sale, and nothing is
   * written. Each line is costed at the units confirming would draw now —
   * `fifoBatches`, the list `confirmWithin` allocates from — through
   * `priceAgainstCost`, the one definition. Every surface asks this: the sale
   * form, a draft's confirm, a storefront request's approval, a product's
   * price, and the assistant's `record_sale` preview.
   *
   * Costs are the partners' figures. The endpoint carries the sales roles,
   * which already read landed costs on the inventory page and a sale's
   * allocations; an investor or a shop cannot reach it.
   */
  async priceCheck(input: PriceCheckInput, db: Db = this.prisma) {
    const items: unknown = input?.items;
    if (!Array.isArray(items)) {
      throw refuseShape('items', 'items must be a list of sale lines.');
    }
    if (items.length > PRICE_CHECK_MAX_LINES) {
      throw refuseShape(
        'items',
        `At most ${PRICE_CHECK_MAX_LINES} lines can be checked at once.`,
      );
    }
    const lines = (items as PriceCheckInput['items']).map((item) => ({
      // A product id that cannot be one is a line still being filled in, not
      // a query for Postgres to fail on.
      productId: isUuid(item?.productId) ? item.productId : '',
      quantity: item?.quantity,
      unitPrice: item?.unitPrice,
      discount: item?.discount,
    }));

    const currency = input.currency ?? 'EGP';
    const compared = currency === 'EGP';
    // Costed from the stock there was on the sale's day, as confirming draws.
    const cutoff = receivedCutoff(chosenDay(input.orderedOn, 'SALE_MADE'));

    const layers = new Map<string, CostLayer[]>();
    if (compared) {
      for (const productId of new Set(lines.map((l) => l.productId))) {
        if (!productId) continue;
        const batches = await fifoBatches(db, productId, cutoff);
        layers.set(
          productId,
          batches.map((b) => ({
            qty: b.saleableQty,
            unitCostEgp: b.landedUnitCostEgp,
          })),
        );
      }
    }

    const result = priceAgainstCost(
      lines.map((l) => ({
        ...l,
        quantity: l.quantity ?? 0,
        unitPrice: l.unitPrice ?? 0,
      })),
      layers,
    );

    const checked: PriceCheckLine[] = result.lines.map((r, i) => {
      if (!compared) {
        return {
          line: i + 1,
          productId: r.productId,
          costed: false,
          reason: 'CURRENCY',
          belowCost: false,
          code: null,
          unitCostEgp: null,
          unitPriceEgp: null,
          costEgp: null,
          netEgp: null,
          lossEgp: null,
        };
      }
      if (!r.costed) {
        return {
          line: i + 1,
          productId: r.productId,
          costed: false,
          reason: r.reason,
          belowCost: false,
          code: null,
          unitCostEgp: null,
          unitPriceEgp: null,
          costEgp: null,
          netEgp: null,
          lossEgp: null,
        };
      }
      const quantity = lines[i].quantity ?? 0;
      return {
        line: i + 1,
        productId: r.productId,
        costed: true,
        belowCost: r.belowCost,
        code: r.belowCost ? 'BELOW_COST' : null,
        unitCostEgp: unitFigure(r.costCents, quantity),
        unitPriceEgp: unitFigure(r.netCents, quantity),
        costEgp: centsText(r.costCents),
        netEgp: centsText(r.netCents),
        lossEgp: centsText(r.lossCents),
      };
    });

    return {
      data: {
        currency,
        compared,
        lines: checked,
        belowCostLines: checked.filter((l) => l.belowCost).length,
        totalLossEgp: centsText(compared ? result.totalLossCents : 0),
      },
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

    // A sale dated before the day it was entered draws only what had been
    // received by the end of its own day (§4, 2026-10-16); any other sale
    // draws the whole shelf, as before.
    const { allocations, totalCogs, lowStock } = await this.drawFifo(
      tx,
      order,
      actorId,
      { movementType: 'SALE', referenceType: 'SALE_ORDER' },
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

  /**
   * Take an order's lines off the shelf, FIFO, writing one allocation per
   * batch drawn at that batch's landed cost — the one definition of drawing
   * stock for an order. Confirming a sale calls it, and so does leaving
   * samples at a shop (§4, samples at shops): the units leave the shelf the
   * same way and their cost is known the same way, so when the shop buys,
   * the sale's COGS is the cost of the very units that went out.
   */
  private async drawFifo(
    tx: Db,
    order: {
      id: string;
      orderedAt: Date;
      createdAt: Date;
      items: {
        id: string;
        productId: string;
        quantity: Prisma.Decimal.Value;
        product: { name: string };
      }[];
    },
    actorId: string,
    how: {
      movementType: 'SALE' | 'SAMPLE_OUT';
      referenceType: string;
    },
  ) {
    const id = order.id;
    // A sale dated before the day it was entered draws only what had been
    // received by the end of its own day (§4, 2026-10-16); any other sale
    // draws the whole shelf, as before.
    const saleDay = businessDay(order.orderedAt);
    const cutoff = receivedCutoff(saleDay, businessDay(order.createdAt));

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

      // FIFO: oldest verified receipt first, batch id breaking any tie —
      // the same query the price check reads (`fifoBatches`).
      const batches = await fifoBatches(tx, item.productId, cutoff);

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
        // The cost is read from the row this update returns, not from the
        // FIFO list read before it: a leg's cost corrected at the same moment
        // re-costs the batch (§2, 2026-10-17), and the update waits for that
        // to commit, so the allocation is written at the cost that stands.
        const taken = await tx.inventoryBatch.update({
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
            movementType: how.movementType,
            qtyDelta: allocQty.neg(),
            referenceType: how.referenceType,
            referenceId: id,
            createdBy: actorId,
          },
        });

        const unitCost = new Prisma.Decimal(taken.landedUnitCostEgp);
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

      if (remainingQty.gt(0) && cutoff) {
        const wanted = new Prisma.Decimal(item.quantity);
        throw notEnoughOnDay(
          item.product.name,
          saleDay,
          wanted.sub(remainingQty),
          wanted,
        );
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

    return { allocations, totalCogs, lowStock };
  }

  // ─── Samples at shops (BUSINESS_LOGIC §4, owner 2026-10-18) ──────────

  /**
   * Leave samples at a shop: an order numbered like any (ORD-), in status
   * SAMPLES, whose units leave the shelf FIFO from real batches with their
   * landed cost recorded (`drawFifo`, the path confirming a sale takes). It
   * totals zero and owes nothing; it is not a sale. Built and drawn in one
   * transaction, or neither — a refusal (not enough stock) leaves nothing.
   */
  private async leaveSamples(
    data: CreateSaleOrderInput,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<{ data: unknown }> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const draft = await this.prepareDraft(tx, data, actorId, idempotencyKey, {
        samples: true,
      });
      const order = await tx.saleOrder.create({
        data: {
          ...draft,
          status: SAMPLES_OPEN_STATUS,
          samplesLeftAt: draft.orderedAt,
        },
        include: { items: { include: { product: true } }, customer: true },
      });
      const drawn = await this.drawFifo(tx, order, actorId, {
        movementType: 'SAMPLE_OUT',
        referenceType: 'SAMPLES_ORDER',
      });
      return { order, drawn };
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'LEAVE_SAMPLES',
      entityType: 'SaleOrder',
      entityId: outcome.order.id,
      afterJson: {
        status: SAMPLES_OPEN_STATUS,
        costAtShopEgp: Number(outcome.drawn.totalCogs),
        lines: outcome.order.items.map((i) => ({
          productId: i.productId,
          quantity: Number(i.quantity),
        })),
      },
    });
    // Off the shelf is off the shelf: a product the samples took below its
    // minimum is low stock, as after a sale (§3).
    await notifyLowStock(
      this.prisma,
      this.notifications,
      outcome.drawn.lowStock,
    );
    const { items, ...order } = outcome.order;
    return {
      data: {
        ...order,
        items: items.map(({ product: _product, ...i }) => i),
        allocations: outcome.drawn.allocations,
        samples: samplesSummary(outcome.order),
      },
    };
  }

  /**
   * Claim an open samples order inside the transaction, so a decision is
   * recorded once: two clicks, two partners, or a decision after a return
   * all meet the status check of an update that only one of them wins.
   */
  private async claimOpenSamples(tx: Db, id: string) {
    if (!isUuid(id)) throw notFound('saleOrder');
    const order = await tx.saleOrder.findUnique({
      where: { id },
      include: {
        customer: { select: { displayName: true } },
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            product: { select: { name: true } },
            allocations: {
              include: { inventoryBatch: { select: { createdAt: true } } },
            },
          },
        },
      },
    });
    if (!order) throw notFound('saleOrder');
    if (order.status !== SAMPLES_OPEN_STATUS) throw notOpenSamples(order);
    const claimed = await tx.saleOrder.updateMany({
      where: { id, status: SAMPLES_OPEN_STATUS },
      data: { version: { increment: 1 } },
    });
    if (claimed.count === 0) throw notOpenSamples(order);
    // A line's draws, oldest batch first — the order FIFO drew them in.
    for (const item of order.items) {
      item.allocations.sort(
        (a, b) =>
          a.inventoryBatch.createdAt.getTime() -
            b.inventoryBatch.createdAt.getTime() ||
          a.inventoryBatchId.localeCompare(b.inventoryBatchId),
      );
    }
    return order;
  }

  /** Put units back on the shelf of the batch they left, and say so. */
  private async sampleBack(
    tx: Db,
    orderId: string,
    batchId: string,
    qty: Prisma.Decimal,
    actorId: string,
  ) {
    await tx.inventoryBatch.update({
      where: { id: batchId },
      data: {
        saleableQty: { increment: qty },
        remainingQty: { increment: qty },
      },
    });
    await tx.inventoryMovement.create({
      data: {
        batchId,
        movementType: 'SAMPLE_BACK',
        qtyDelta: qty,
        referenceType: 'SAMPLES_ORDER',
        referenceId: orderId,
        createdBy: actorId,
      },
    });
  }

  /**
   * "They're buying" (§4, samples at shops; owner 2026-10-18, round 2): the
   * normal New Order popup, pre-filled from the samples and saved with
   * whatever lines the partner left in it — a lowered quantity, a removed
   * line, a raised quantity, a product that never went out, any price and
   * discount a sale may have.
   *
   * Converted **in place**: the same order, the same ORD number, becomes a
   * CONFIRMED sale dated the day chosen (today unless an earlier day is
   * entered; never before the samples were left, never in the future), with
   * exactly those lines. Per product (`planSamplesConversion`):
   * - the units kept are taken from the ones that went out, oldest batch
   *   first, at the cost they left at — no second movement, they already left;
   * - the units not kept go back to the batch each came from (SAMPLE_BACK);
   * - anything beyond what went out is drawn FIFO from the shelf
   *   (`drawFifo`, as confirming a sale draws), after checking the shelf of
   *   that day has it — `SAMPLES_EXTRA_NOT_IN_STOCK` for a sample product,
   *   `NOT_ENOUGH_STOCK` for one that never went out.
   *
   * Nothing on the sale at all is refused with `SAMPLES_NOTHING_KEPT`, which
   * points at "Returned": saving a sale should never quietly record a return.
   * All in one transaction, or none of it.
   */
  async convertSamples(
    id: string,
    body: SamplesConversionInput,
    actorId: string,
  ) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const order = await this.claimOpenSamples(tx, id);
      const shop = order.customer.displayName;

      if (
        body?.customerId !== undefined &&
        body.customerId !== null &&
        body.customerId !== order.customerId
      ) {
        throw badRequest(
          'SAMPLES_OTHER_SHOP',
          `The samples on ${order.orderNo} were left with ${shop}; the sale from them is to ${shop}.`,
          { order: order.orderNo, shop },
        );
      }
      if (!Array.isArray(body?.items) || body.items.length === 0) {
        throw badRequest(
          'SAMPLES_NOTHING_KEPT',
          `Nothing is on the sale from ${order.orderNo}. If every sample came back, record "Returned".`,
          { order: order.orderNo },
        );
      }
      const channel = body.channel ?? order.channel;
      if (channel !== 'B2B' && channel !== 'B2C') {
        throw refuseShape('channel', 'channel must be B2B or B2C.');
      }
      const currency = body.currency ?? order.currency;

      // The day the shop bought: today unless an earlier day is entered,
      // never one that has not come, and never before the samples were left.
      const day = chosenDay(body.orderedOn, 'SALE_MADE');
      const leftOn = businessDay(order.samplesLeftAt ?? order.orderedAt);
      if (day < leftOn) {
        throw badRequest(
          'SAMPLES_SALE_BEFORE_LEFT',
          `The samples on ${order.orderNo} were left on ${leftOn}, so the sale cannot be dated ${day}.`,
          { order: order.orderNo, left: leftOn, day },
        );
      }
      const cutoff = receivedCutoff(day);

      await this.checkLines(tx, body.items);
      const { itemsData, subtotal } = saleLines(body.items);

      const draws = order.items.flatMap((i) =>
        i.allocations.map((a) => ({
          productId: i.productId,
          batchId: a.inventoryBatchId,
          qty: a.qty,
          unitCostEgp: a.unitCostEgp,
          receivedAt: a.inventoryBatch.createdAt.getTime(),
        })),
      );
      // Oldest batch first within each product, across every line of it.
      draws.sort(
        (a, b) =>
          a.receivedAt - b.receivedAt || a.batchId.localeCompare(b.batchId),
      );
      const plan = planSamplesConversion(draws, body.items);

      // More than went out comes from the shelf of the sale's day — and the
      // shelf must have it, said before anything moves.
      for (const p of plan.products) {
        if (!p.extra.gt(0)) continue;
        const available = await availableQty(
          tx,
          p.productId,
          undefined,
          cutoff,
        );
        if (p.extra.lte(available)) continue;
        const product = await tx.product.findUnique({
          where: { id: p.productId },
          select: { name: true },
        });
        const name = product?.name ?? 'that product';
        if (p.out.gt(0)) {
          const wanted = p.out.add(p.extra);
          throw badRequest(
            'SAMPLES_EXTRA_NOT_IN_STOCK',
            `${p.out.toString()} of ${name} went out as samples; selling ` +
              `${wanted.toString()} needs ${p.extra.toString()} more from the ` +
              `shelf, and only ${available.toString()} is there.`,
            {
              product: name,
              out: p.out.toString(),
              wanted: wanted.toString(),
              extra: p.extra.toString(),
              available: available.toString(),
            },
          );
        }
        throw notEnoughStock(name, available, p.extra, day, cutoff);
      }

      // The samples' lines give way to the sale's: their draws are replaced
      // by the plan's, and whatever is not kept goes back to its batch.
      const itemIds = order.items.map((i) => i.id);
      await tx.saleItemAllocation.deleteMany({
        where: { saleItemId: { in: itemIds } },
      });
      await tx.saleItem.deleteMany({ where: { id: { in: itemIds } } });
      for (const p of plan.products) {
        for (const b of p.back) {
          await this.sampleBack(tx, order.id, b.batchId, b.qty, actorId);
        }
      }

      let keptCogs = new Prisma.Decimal(0);
      const fromShelf: {
        id: string;
        productId: string;
        quantity: Prisma.Decimal;
        product: { name: string };
      }[] = [];
      for (const [i, row] of itemsData.entries()) {
        const item = await tx.saleItem.create({
          data: { ...row, saleOrderId: order.id },
          include: { product: { select: { name: true } } },
        });
        for (const k of plan.lines[i].fromSamples) {
          keptCogs = keptCogs.add(k.cogsEgp);
          await tx.saleItemAllocation.create({
            data: {
              saleItemId: item.id,
              inventoryBatchId: k.batchId,
              qty: k.qty,
              unitCostEgp: k.unitCostEgp,
              cogsEgp: k.cogsEgp,
            },
          });
        }
        if (plan.lines[i].fromShelf.gt(0)) {
          fromShelf.push({
            id: item.id,
            productId: item.productId,
            quantity: plan.lines[i].fromShelf,
            product: item.product,
          });
        }
      }

      const orderedAt = instantOfDay(day);
      const now = new Date();
      const drawn =
        fromShelf.length > 0
          ? await this.drawFifo(
              tx,
              { id: order.id, orderedAt, createdAt: now, items: fromShelf },
              actorId,
              { movementType: 'SALE', referenceType: 'SALE_ORDER' },
            )
          : null;

      const updated = await tx.saleOrder.update({
        where: { id: order.id },
        data: {
          status: 'CONFIRMED',
          channel,
          currency,
          // Dated the day the shop bought: revenue, COGS and the debt start
          // then, not the day the samples were left.
          orderedAt,
          samplesDecidedAt: now,
          subtotal,
          discount: 0,
          total: subtotal,
          outstanding: subtotal,
        },
        include: { items: true, customer: true },
      });
      const totalCogs = keptCogs.add(drawn?.totalCogs ?? 0);
      return {
        data: updated,
        lowStock: drawn?.lowStock ?? [],
        audit: {
          actorUserId: actorId,
          action: 'SAMPLES_BOUGHT',
          entityType: 'SaleOrder',
          entityId: order.id,
          beforeJson: {
            status: SAMPLES_OPEN_STATUS,
            lines: order.items.map((i) => ({
              productId: i.productId,
              quantity: Number(i.quantity),
            })),
          },
          afterJson: {
            status: 'CONFIRMED',
            total: Number(subtotal),
            cogs: Number(totalCogs),
            products: plan.products.map((p) => ({
              productId: p.productId,
              out: Number(p.out),
              kept: Number(p.kept),
              back: Number(p.out.sub(p.kept)),
              fromShelf: Number(p.extra),
            })),
          },
        },
      };
    });

    await this.audit.log(outcome.audit);
    await notifyLowStock(this.prisma, this.notifications, outcome.lowStock);
    return { data: { ...outcome.data, samples: samplesSummary(outcome.data) } };
  }

  /** "Returned": every sample back on the shelf (§4, samples at shops). */
  async returnSamples(id: string, actorId: string) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const order = await this.claimOpenSamples(tx, id);
      return this.returnAllWithin(tx, order, actorId, new Date());
    });
    await this.audit.log(outcome.audit);
    return { data: { ...outcome.data, samples: samplesSummary(outcome.data) } };
  }

  /**
   * Everything back on the shelf, each unit to the batch it left. The order
   * ends SAMPLES_RETURNED — not a cancelled sale and not a sale return. Its
   * lines and allocations stay as the record of what went out; that status
   * counts in nothing.
   */
  private async returnAllWithin(
    tx: Db,
    order: Awaited<ReturnType<SalesService['claimOpenSamples']>>,
    actorId: string,
    now: Date,
  ) {
    for (const item of order.items) {
      for (const a of item.allocations) {
        await this.sampleBack(
          tx,
          order.id,
          a.inventoryBatchId,
          new Prisma.Decimal(a.qty),
          actorId,
        );
      }
    }
    const data = await tx.saleOrder.update({
      where: { id: order.id },
      data: { status: 'SAMPLES_RETURNED', samplesDecidedAt: now },
      include: { items: true, customer: true },
    });
    return {
      data,
      audit: {
        actorUserId: actorId,
        action: 'SAMPLES_RETURNED',
        entityType: 'SaleOrder',
        entityId: order.id,
        beforeJson: { status: SAMPLES_OPEN_STATUS },
        afterJson: {
          status: 'SAMPLES_RETURNED',
          lines: order.items.map((i) => ({
            productId: i.productId,
            returned: Number(i.quantity),
          })),
        },
      },
    };
  }

  /**
   * "Write off": the shop kept them or they were lost. The units never come
   * back to the shelf; their landed cost — on the allocations, at the cost
   * they left at — becomes a cost of the cycle each batch came from, read
   * through `samplesWrittenOffEgp` by settlement, the dashboard and the P&L
   * alike. No money moves, so no ledger row is written (§9: a loss is not
   * money moving).
   */
  async writeOffSamples(
    id: string,
    body: { reason?: unknown } | undefined,
    actorId: string,
  ) {
    const reason =
      typeof body?.reason === 'string'
        ? body.reason.trim().slice(0, 500)
        : null;
    const outcome = await this.prisma.$transaction(async (tx) => {
      const order = await this.claimOpenSamples(tx, id);
      const cost = order.items
        .flatMap((i) => i.allocations)
        .reduce((s, a) => s.add(a.cogsEgp), new Prisma.Decimal(0));
      const data = await tx.saleOrder.update({
        where: { id: order.id },
        data: { status: 'SAMPLES_WRITTEN_OFF', samplesDecidedAt: new Date() },
        include: { items: true, customer: true },
      });
      return {
        data,
        audit: {
          actorUserId: actorId,
          action: 'SAMPLES_WRITTEN_OFF',
          entityType: 'SaleOrder',
          entityId: order.id,
          beforeJson: { status: SAMPLES_OPEN_STATUS },
          afterJson: {
            status: 'SAMPLES_WRITTEN_OFF',
            costEgp: Number(cost),
            ...(reason ? { reason } : {}),
          },
        },
      };
    });
    await this.audit.log(outcome.audit);
    return { data: { ...outcome.data, samples: samplesSummary(outcome.data) } };
  }

  /**
   * The samples reminder (DECIDED, owner 2026-10-18): 14 days after samples
   * were left and while they are still at the shop, every active core
   * partner is told "Samples at <shop> for 14 days", linking to the order.
   * Once per order, ever: the order records when it was sent
   * (`samplesRemindedAt`), claimed by an update that only one run can win, so
   * the morning job and a `@Cron` on a long-lived host never both send it.
   * A decided order is never reminded.
   *
   * Run by the daily job (`GET /jobs/overdue-payments`, the `@Cron` in
   * `OverdueScheduler`). The notification goes after the claim, outside any
   * transaction, through NotificationsService — which also pushes it.
   */
  async notifySamplesReminders(now = new Date()) {
    const open = await this.prisma.saleOrder.findMany({
      where: {
        status: SAMPLES_OPEN_STATUS,
        samplesRemindedAt: null,
        samplesLeftAt: { not: null },
      },
      select: {
        id: true,
        orderNo: true,
        status: true,
        samplesLeftAt: true,
        samplesRemindedAt: true,
        customerId: true,
        customer: { select: { displayName: true } },
        items: { select: { quantity: true } },
      },
    });
    const due = samplesRemindersDue(open, now);
    if (due.length === 0) return { samplesDue: 0, notifications: 0 };

    const partners = await this.prisma.user.findMany({
      where: { role: 'CORE_PARTNER', status: 'ACTIVE' },
      select: { id: true },
    });
    const userIds = partners.map((u) => u.id);
    if (userIds.length === 0)
      return { samplesDue: due.length, notifications: 0 };

    let notifications = 0;
    for (const order of due) {
      const claimed = await this.prisma.saleOrder.updateMany({
        where: {
          id: order.id,
          status: SAMPLES_OPEN_STATUS,
          samplesRemindedAt: null,
        },
        data: { samplesRemindedAt: now },
      });
      if (claimed.count === 0) continue;
      const units = order.items
        .reduce((s, i) => s.add(i.quantity), new Prisma.Decimal(0))
        .toString();
      await this.notifications.createForMultipleUsers(userIds, {
        eventType: 'SAMPLES_REMINDER',
        code: 'SAMPLES_AT_SHOP_REMINDER',
        params: {
          shop: order.customer.displayName,
          days: SAMPLES_REMINDER_DAYS,
          order: order.orderNo,
          units,
        },
        payload: {
          orderId: order.id,
          customerId: order.customerId,
        },
      });
      notifications += userIds.length;
    }
    return { samplesDue: due.length, notifications };
  }

  async cancelOrder(id: string, actorId: string) {
    // Cancel on samples still at the shop is "Returned" (§4, samples at
    // shops): the units come back to the shelf, and the order ends as
    // returned samples — never as a cancelled sale it never was.
    const peek = isUuid(id)
      ? await this.prisma.saleOrder.findUnique({
          where: { id },
          select: { status: true },
        })
      : null;
    if (peek?.status === SAMPLES_OPEN_STATUS) {
      return this.returnSamples(id, actorId);
    }
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
      // Samples the shop already decided on: returned or written off. Cancel
      // would put back stock that is already back, or never coming back.
      if (isSamplesStatus(order.status)) throw notOpenSamples(order);

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

      // A cancelled order owes nothing (check-data 12.2). Only an order with
      // nothing paid against it reaches here, so the whole balance goes; the
      // total stays as the record of what the order was.
      const updated = await tx.saleOrder.update({
        where: { id },
        data: { status: 'CANCELLED', outstanding: 0 },
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
