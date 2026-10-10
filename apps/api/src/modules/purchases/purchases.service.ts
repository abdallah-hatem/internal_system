import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { isUniqueViolation } from '../../prisma/unique-violation';
import {
  lockReferenceSeries,
  nextReferenceNumber,
  pad,
} from '../../common/references';
import {
  assertNotFuture,
  businessDay,
  businessToday,
} from '../../common/dates';
import { lockCycle } from '../../common/shipment-load';
import { COUNTING_REFUND, refundEgp } from '../../common/loss-refunds';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PaginationDto,
  pageSize,
  cursorPage,
} from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';
import { formatMoney } from '../../common/money';
import { isUuid } from '../../common/uuid';
import {
  assertInScope,
  cycleIdWhere,
  cyclesVisibleTo,
  type ScopeViewer,
} from '../../common/investor-scope';

import { badRequest, notFound } from '../../common/api-error';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import {
  SUPPLIER_INVOICE_REF_MAX,
  isSupplierInvoiceRefTooLong,
  normaliseSupplierInvoiceRef,
} from './supplier-invoice-ref';
import { OPEN_FOR_PURCHASING, isOpenForPurchasing } from './purchase-rules';

type Db = Prisma.TransactionClient;

/** The lock every new purchase order's number is taken under. */
const PO_SERIES = 'PO';

/** One line of a purchase order. `discount` is percent off the line. */
export interface PurchaseLine {
  productId: string;
  orderedQty: number;
  unitPrice: number;
  discount?: number;
}

/** What `validateOrder` settled, and `writeOrder` writes from. */
export interface CheckedOrder {
  cycle: { id: string; code: string; status: string };
  supplier: { id: string; name: string };
  supplierInvoiceRef: string | null;
}

/**
 * Quantity × unit price less the percentage discount, to the cent, half up —
 * as an invoice prints it. Decimal throughout, never a float standing in for
 * money.
 */
export function purchaseLineTotal(
  line: Pick<PurchaseLine, 'orderedQty' | 'unitPrice' | 'discount'>,
): Prisma.Decimal {
  return new Prisma.Decimal(line.orderedQty)
    .mul(line.unitPrice)
    .mul(new Prisma.Decimal(100).sub(line.discount ?? 0))
    .div(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Sums lines already priced, and converts at the order's rate, to the cent. */
export function purchaseOrderTotals(
  lineTotals: Array<Prisma.Decimal | number | string>,
  fxRateToEgp: number,
): { total: string; totalEgp: string } {
  const total = lineTotals.reduce<Prisma.Decimal>(
    (sum, t) => sum.add(t),
    new Prisma.Decimal(0),
  );
  return {
    total: total.toFixed(2),
    totalEgp: total
      .mul(fxRateToEgp)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      .toFixed(2),
  };
}

function assertCycleOpen(status: string) {
  if (!isOpenForPurchasing(status)) {
    throw badRequest(
      'CYCLE_STATUS_BLOCKS_PO',
      `Cycle must be in ${OPEN_FOR_PURCHASING.join(', ')} status to create purchase orders. Current: ${status}`,
      { status },
    );
  }
}

/** A rate is what one unit costs in EGP. Zero or less is not a rate. */
function assertRate(rate: number) {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw badRequest(
      'RATE_NOT_POSITIVE',
      'An exchange rate must be greater than zero.',
    );
  }
}

function duplicateInvoice(
  ref: string,
  supplier: string,
  purchaseOrder: string,
) {
  return badRequest(
    'DUPLICATE_SUPPLIER_INVOICE',
    `Invoice ${ref} from ${supplier} is already recorded on ${purchaseOrder}.`,
    { ref, supplier, purchaseOrder },
  );
}

@Injectable()
export class PurchasesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  async findAll(
    pagination: PaginationDto & { cycleId?: string },
    viewer: ScopeViewer = 'internal',
  ) {
    const { cursor, limit: rawLimit = 20, cycleId } = pagination;
    const limit = pageSize(rawLimit);
    const where: Prisma.PurchaseOrderWhereInput = {};
    const scope = await cyclesVisibleTo(viewer, this.prisma);
    const cycleFilter = cycleIdWhere(scope, cycleId);
    if (cycleFilter) where.cycleId = cycleFilter;

    const items = await this.prisma.purchaseOrder.findMany({
      where,
      ...cursorPage(cursor, limit),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        supplier: true,
        cycle: true,
        items: true,
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

  async findById(id: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(id)) throw notFound('purchaseOrder');
    const scope = await cyclesVisibleTo(viewer, this.prisma);
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        supplier: true,
        cycle: true,
        items: { include: { product: true } },
        supplierRefunds: true,
      },
    });
    if (!po) throw notFound('purchaseOrder');
    // Another cycle's order reads as missing to an investor (R1).
    assertInScope(scope, po.cycleId, 'purchaseOrder');
    return { data: po };
  }

  async findByCycle(cycleId: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(cycleId)) throw notFound('cycle');
    assertInScope(await cyclesVisibleTo(viewer, this.prisma), cycleId);
    const items = await this.prisma.purchaseOrder.findMany({
      where: { cycleId },
      include: {
        supplier: true,
        items: { include: { product: true } },
        supplierRefunds: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return { data: items };
  }

  /**
   * Record a purchase order and its lines.
   *
   * Checked on the plain client first, then written in one transaction; the
   * participants are told once it has committed. The assistant runs the same
   * two steps, `validateOrder` and `writeOrder`, inside a transaction of its
   * own, so that a supplier and products it creates alongside the order stand
   * or fall with it.
   */
  async create(cycleId: string, data: CreatePurchaseOrderDto, actorId: string) {
    const checked = await this.validateOrder(this.prisma, cycleId, data);

    const order = await this.prisma
      .$transaction(async (tx) => {
        return this.writeOrder(tx, checked, data, actorId);
      })
      .catch((err: unknown) =>
        this.explainDuplicateInvoice(err, checked.supplier, data),
      );

    await this.announceCreated(order, checked);
    return { data: order };
  }

  /**
   * Every refusal `create` makes, asked of `db`, writing nothing. Returns what
   * the write needs: the cycle, the supplier, the invoice number as stored.
   */
  async validateOrder(
    db: Db,
    cycleId: string,
    data: CreatePurchaseOrderDto,
  ): Promise<CheckedOrder> {
    assertNotFuture(data.orderedOn, 'ORDER_PLACED');
    assertRate(data.fxRateToEgp);

    const cycle = await db.importCycle.findUnique({
      where: { id: cycleId },
    });
    if (!cycle) throw notFound('cycle');
    assertCycleOpen(cycle.status);

    const supplier = await db.supplier.findUnique({
      where: { id: data.supplierId },
    });
    if (!supplier) throw notFound('supplier');

    const supplierInvoiceRef = await this.assertInvoiceNotRecorded(
      db,
      supplier,
      data.supplierInvoiceRef,
    );

    // Validate items
    if (!data.items || data.items.length === 0) {
      throw badRequest(
        'PO_NEEDS_ITEM',
        'Purchase order must contain at least one item',
      );
    }
    for (const item of data.items) await this.assertLine(db, item);

    return { cycle, supplier, supplierInvoiceRef };
  }

  /** Writes a validated order, its lines and its audit entry, in `tx`. */
  async writeOrder(
    tx: Db,
    checked: CheckedOrder,
    data: CreatePurchaseOrderDto,
    actorId: string,
  ) {
    // One order numbered at a time, whoever is writing it — the office form or
    // the assistant's receipt path both come through here. The reference has
    // no unique index, so two orders at once were both handed the same PO
    // number, silently. The lock is held until the caller's transaction ends.
    await lockReferenceSeries(tx, PO_SERIES);
    // Generate reference: PO-YYYY-XXXX
    const year = new Date().getFullYear();
    const last = await tx.purchaseOrder.findFirst({
      where: { reference: { startsWith: `PO-${year}` } },
      orderBy: { reference: 'desc' },
      select: { reference: true },
    });
    const reference = `PO-${year}-${pad(nextReferenceNumber(last?.reference, 4), 4)}`;

    const po = await tx.purchaseOrder.create({
      data: {
        cycleId: checked.cycle.id,
        supplierId: checked.supplier.id,
        reference,
        currency: data.currency,
        fxRateToEgp: data.fxRateToEgp,
        orderedOn: new Date(data.orderedOn),
        status: 'DRAFT',
        supplierInvoiceRef: checked.supplierInvoiceRef,
      },
    });

    const items = [];
    for (const item of data.items) {
      items.push(
        await tx.purchaseOrderItem.create({
          data: {
            purchaseOrderId: po.id,
            productId: item.productId,
            orderedQty: item.orderedQty,
            unitPrice: item.unitPrice,
            discount: item.discount || 0,
            lineTotal: purchaseLineTotal(item),
          },
        }),
      );
    }
    const result = { ...po, items };

    await this.audit.log(
      {
        actorUserId: actorId,
        action: 'CREATE',
        entityType: 'PurchaseOrder',
        entityId: result.id,
        afterJson: result,
      },
      tx,
    );
    return result;
  }

  /**
   * Two requests carrying the same receipt can both pass the invoice check
   * before either commits. The unique index stops the second; this says so in
   * the same words, never as a 500. Both sends also compute the same PO
   * reference, so the failed index cannot be trusted to name the invoice — it
   * is looked up instead. Anything else is rethrown as it came.
   */
  async explainDuplicateInvoice(
    err: unknown,
    supplier: { id: string; name: string },
    data: { supplierInvoiceRef?: string | null },
  ): Promise<never> {
    const ref = normaliseSupplierInvoiceRef(data.supplierInvoiceRef);
    if (ref && isUniqueViolation(err)) {
      const existing = await this.prisma.purchaseOrder.findFirst({
        where: { supplierId: supplier.id, supplierInvoiceRef: ref },
        select: { reference: true },
      });
      if (existing) {
        throw duplicateInvoice(ref, supplier.name, existing.reference);
      }
    }
    throw err;
  }

  /** Tells the cycle's participants. Only ever after the order has committed. */
  async announceCreated(
    order: { id: string; reference: string },
    checked: Pick<CheckedOrder, 'cycle' | 'supplier'>,
  ) {
    const { cycle, supplier } = checked;
    const participants = await this.prisma.cycleParticipant.findMany({
      where: { cycleId: cycle.id },
    });
    const userIds = participants
      .map((p) => [p.partnerUserId, p.investorUserId])
      .flat()
      .filter(Boolean) as string[];
    if (userIds.length > 0) {
      await this.notifications.createForMultipleUsers(userIds, {
        eventType: 'PURCHASE_ORDER_CREATED',
        code: 'PURCHASE_ORDER_CREATED',
        params: { reference: order.reference, cycleCode: cycle.code },
        payload: {
          purchaseOrderId: order.id,
          cycleId: cycle.id,
          cycleCode: cycle.code,
          supplierName: supplier.name,
        },
      });
    }
  }

  /**
   * BUSINESS_LOGIC.md §15: a supplier's invoice is recorded once. Returns the
   * number as it will be stored, or null for a receipt with no number.
   */
  async assertInvoiceNotRecorded(
    db: Db,
    supplier: { id: string; name: string },
    raw: string | null | undefined,
  ): Promise<string | null> {
    const ref = normaliseSupplierInvoiceRef(raw);
    if (isSupplierInvoiceRefTooLong(ref)) {
      // The DTO refuses this first on the HTTP route; the service says it for
      // every other caller, in the same code the DTO uses.
      throw badRequest(
        'VALIDATION_FAILED',
        `supplierInvoiceRef must be shorter than or equal to ${SUPPLIER_INVOICE_REF_MAX} characters`,
        { fields: 'supplierInvoiceRef' },
      );
    }
    if (!ref) return null;

    const existing = await db.purchaseOrder.findFirst({
      where: { supplierId: supplier.id, supplierInvoiceRef: ref },
      select: { reference: true },
    });
    if (existing)
      throw duplicateInvoice(ref, supplier.name, existing.reference);
    return ref;
  }

  /**
   * One line's refusals, the same for a new order and a line added to a draft:
   * a product that exists, a quantity above zero, a price of zero or more
   * (free goods are real), and a discount that leaves the line worth between
   * nothing and all of it.
   */
  private async assertLine(db: Db, item: PurchaseLine) {
    if (!item.productId) {
      throw badRequest('ITEM_NEEDS_PRODUCT', 'Each item must have a productId');
    }
    const product = await db.product.findUnique({
      where: { id: item.productId },
    });
    if (!product) throw notFound('product');

    if (!Number.isFinite(item.orderedQty) || item.orderedQty <= 0) {
      throw badRequest(
        'QTY_NOT_POSITIVE',
        `Invalid quantity for product ${item.productId}: must be greater than 0`,
      );
    }
    if (
      item.unitPrice == null ||
      !Number.isFinite(item.unitPrice) ||
      item.unitPrice < 0
    ) {
      throw badRequest(
        'PRICE_NEGATIVE',
        `Invalid unitPrice for product ${item.productId}: must be 0 or greater`,
      );
    }
    const discount = item.discount ?? 0;
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      // Over 100% the line is worth less than nothing, and the order's total —
      // the cycle's cost — drops by goods that were in fact bought.
      throw badRequest(
        'DISCOUNT_PERCENT_INVALID',
        `A line discount must be between 0 and 100 percent (given ${discount}).`,
        { discount },
      );
    }
  }

  /**
   * Add a line to an order still being written. `db` is the transaction to do
   * it in, when the line is one part of a larger change.
   */
  async addItem(
    purchaseOrderId: string,
    data: PurchaseLine,
    actorId: string,
    db: Db = this.prisma,
  ) {
    const po = await db.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { cycle: { select: { status: true } } },
    });
    if (!po) throw notFound('purchaseOrder');

    if (po.status !== 'DRAFT') {
      throw badRequest(
        'PO_NOT_DRAFT',
        'Can only add items to a DRAFT purchase order',
      );
    }
    // A draft stranded on a cycle that left PURCHASING before §15 existed is
    // still an order that was placed; its goods are already moving.
    assertCycleOpen(po.cycle.status);
    await this.assertLine(db, data);

    const item = await db.purchaseOrderItem.create({
      data: {
        purchaseOrderId,
        productId: data.productId,
        orderedQty: data.orderedQty,
        unitPrice: data.unitPrice,
        discount: data.discount || 0,
        lineTotal: purchaseLineTotal(data),
      },
    });

    await this.audit.log(
      {
        actorUserId: actorId,
        action: 'ADD_ITEM',
        entityType: 'PurchaseOrderItem',
        entityId: item.id,
        afterJson: item,
      },
      db,
    );

    return { data: item };
  }

  /**
   * PUT /purchases/items/:id.
   *
   * It used to set `receivedQty` outright, which is how an order line came to
   * say 40 received while its batches held 25. Since 2026-10-10 the received
   * quantity is the sum of the line's batches, maintained by receiving stock
   * (§3), and is never typed: sending it is refused here, in the service, so
   * no caller can set it (rule 3). Nothing else on a line is editable here, so
   * a call without it changes nothing.
   */
  async updateItem(
    id: string,
    data: { receivedQty?: number },
    _actorId: string,
  ) {
    if (data && data.receivedQty !== undefined) {
      throw badRequest(
        'VALIDATION_FAILED',
        'receivedQty cannot be set: it is the sum of what was received into stock. Receive the delivery instead.',
        { fields: 'receivedQty' },
      );
    }
    if (!isUuid(id)) throw notFound('purchaseOrderItem');
    const existing = await this.prisma.purchaseOrderItem.findUnique({
      where: { id },
    });
    if (!existing) throw notFound('purchaseOrderItem');
    return { data: existing };
  }

  /**
   * Record money a supplier has given back, against the order it relates to.
   *
   * The refund recovers cost, so it lands on the cycle as an inflow and the
   * cycle's profit improves by that amount. It deliberately does not re-price
   * the batches: units already sold were costed at what they cost at the time,
   * and rewriting that would change the COGS of sales already made and the
   * profit of a settlement possibly already agreed (BRD 6, 10).
   */
  async recordRefund(
    purchaseOrderId: string,
    data: RefundInput,
    actorId: string,
  ) {
    if (!isUuid(purchaseOrderId)) throw notFound('purchaseOrder');
    checkRefund(data);

    const found = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      select: { cycleId: true },
    });
    if (!found) throw notFound('purchaseOrder');

    const { refund, amountEgp, cycleCode } = await this.prisma.$transaction(
      async (tx) => {
        // Under the cycle's lock, so two refunds sent at once cannot both fit
        // under a cap that only one of them fits under.
        await lockCycle(tx, found.cycleId);
        const po = await loadRefundOrder(tx, purchaseOrderId);
        return bookRefund(tx, po, data, actorId, {
          category: 'supplier_refund',
          reason:
            `Supplier refund against ${po.reference}` +
            (data.reason ? `: ${data.reason}` : ''),
        });
      },
    );

    await this.auditRefund(refund, amountEgp, cycleCode, actorId);
    return { data: refund };
  }

  /**
   * POST /shipping/losses/:id/refunds — money paid back for goods lost on the
   * way (§6, 2026-10-10), by the leg's shipping company or the order's
   * supplier.
   *
   * It is a supplier refund on the loss's order, written by the same
   * `bookRefund`, so the order-level cap counts it and the ledger row is the
   * same shape — only its category, `loss_refund`, differs. On top, refunds
   * on one loss never total more than the loss cost: compensation recovers a
   * loss, it does not make a profit on one.
   *
   * Allowed in any cycle status, settled or closed included: the money
   * arrives when it arrives, and §9 records money as it moves.
   */
  async recordLossRefund(
    lossId: string,
    data: LossRefundInput,
    actorId: string,
  ) {
    if (!isUuid(lossId)) throw notFound('shipmentLoss');
    checkRefund(data);
    const payer = data.payer as Partial<LossRefundInput['payer']> | undefined;
    if (!payer || !PAYER_TYPES.includes(payer.type as PayerType)) {
      throw badRequest(
        'VALIDATION_FAILED',
        'Say who paid: the shipping company or the supplier.',
        { fields: 'payer.type' },
      );
    }
    const payerEntity =
      payer.type === 'SHIPPING_PROVIDER' ? 'provider' : 'supplier';
    const payerId = payer.id;
    if (!isUuid(payerId)) throw notFound(payerEntity);

    const found = await this.prisma.shipmentLoss.findUnique({
      where: { id: lossId },
      select: { leg: { select: { cycleId: true } } },
    });
    if (!found) throw notFound('shipmentLoss');

    const { refund, amountEgp, cycleCode } = await this.prisma.$transaction(
      async (tx) => {
        await lockCycle(tx, found.leg.cycleId);
        const loss = await tx.shipmentLoss.findUnique({
          where: { id: lossId },
          select: {
            id: true,
            costEgp: true,
            leg: { select: { providerId: true } },
            purchaseOrderItem: {
              select: {
                purchaseOrderId: true,
                product: { select: { name: true } },
              },
            },
            // A reversed refund was handed back: it frees its share of the cap.
            refunds: {
              where: COUNTING_REFUND,
              select: { amount: true, fxRateToEgp: true },
            },
          },
        });
        // Taken back between the read above and the lock.
        if (!loss) throw notFound('shipmentLoss');
        const po = await loadRefundOrder(
          tx,
          loss.purchaseOrderItem.purchaseOrderId,
        );

        // The wrong owner: only whoever had the goods can pay for losing them.
        const owner =
          payer.type === 'SUPPLIER' ? po.supplierId : loss.leg.providerId;
        if (payerId !== owner) throw notFound(payerEntity);

        const cost = D(loss.costEgp);
        const refunded = loss.refunds.reduce(
          (s, r) => s.add(refundEgp(r)),
          D(0),
        );
        const asked = refundEgp(data);
        if (refunded.add(asked).gt(cost)) {
          const product = loss.purchaseOrderItem.product.name;
          throw badRequest(
            'REFUND_EXCEEDS_LOSS',
            `A refund of ${formatMoney(asked)} EGP is more than is left on the loss of ` +
              `${product}: it cost ${formatMoney(cost)} EGP and ` +
              `${formatMoney(refunded)} EGP has already been refunded.`,
            {
              cost: formatMoney(cost),
              refunded: formatMoney(refunded),
              asked: formatMoney(asked),
              product,
            },
          );
        }

        return bookRefund(tx, po, data, actorId, {
          category: 'loss_refund',
          shipmentLossId: loss.id,
          payerShippingProviderId:
            payer.type === 'SHIPPING_PROVIDER' ? payerId : null,
          reason:
            `Refund for ${loss.purchaseOrderItem.product.name} lost on the way (${po.reference})` +
            (data.reason ? `: ${data.reason}` : ''),
        });
      },
    );

    await this.auditRefund(refund, amountEgp, cycleCode, actorId);
    return { data: refund };
  }

  /**
   * POST /purchases/refunds/:id/reverse — undo a refund: the money was handed
   * back (§6, §9, B5b). Plain supplier refunds and loss refunds alike.
   *
   * Nothing is edited away. The refund row stays, marked reversed with who,
   * when and why, and a balancing ledger OUTFLOW points back at the refund's
   * original inflow (`reversalOfId`), the same shape the ledger's own
   * reversal writes. From then on the refund counts toward no cap and no
   * profit: `COUNTING_REFUND` everywhere refunds are summed, and the pair of
   * ledger rows nets to nothing in every recovery figure.
   *
   * Under the cycle's lock, as recording a refund is, so an undo and a new
   * refund — or two undos — cannot interleave. Allowed in any cycle status,
   * like recording one: money moves when it moves.
   */
  async reverseRefund(
    id: string,
    body: { reason?: unknown } | undefined,
    actorId: string,
  ) {
    if (!isUuid(id)) throw notFound('supplierRefund');
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    // §9: a reason is required. The service checks it; the DTO is one caller.
    if (!reason) {
      throw badRequest(
        'VALIDATION_FAILED',
        'Give a reason for undoing this refund.',
        { fields: 'reason' },
      );
    }
    if (reason.length > REVERSAL_REASON_MAX) {
      throw badRequest(
        'VALIDATION_FAILED',
        `A reason is at most ${REVERSAL_REASON_MAX} characters.`,
        { fields: 'reason' },
      );
    }

    const found = await this.prisma.supplierRefund.findUnique({
      where: { id },
      select: { purchaseOrder: { select: { cycleId: true } } },
    });
    if (!found) throw notFound('supplierRefund');

    const { refund, reversal, cycleCode } = await this.prisma.$transaction(
      async (tx) => {
        await lockCycle(tx, found.purchaseOrder.cycleId);
        const refund = await tx.supplierRefund.findUnique({ where: { id } });
        if (!refund) throw notFound('supplierRefund');
        if (refund.reversedAt) throw alreadyReversed(refund.reversedAt);

        // The refund's own inflow. A refund recorded before refunds reached
        // the ledger has none: there is then nothing to balance, and the
        // refund is only marked (it never touched cash or profit there).
        const original = await tx.financialTransaction.findFirst({
          where: {
            relatedType: 'SUPPLIER_REFUND',
            relatedId: id,
            reversalOfId: null,
          },
        });
        let reversal: { id: string } | null = null;
        if (original) {
          const earlier = await tx.financialTransaction.findFirst({
            where: { reversalOfId: original.id },
            select: { createdAt: true },
          });
          if (earlier) throw alreadyReversed(earlier.createdAt);
          reversal = await tx.financialTransaction.create({
            data: {
              type: original.type,
              category: original.category,
              // Mirror the original so the pair nets to zero.
              direction: original.direction === 'INFLOW' ? 'OUTFLOW' : 'INFLOW',
              amount: original.amount,
              currency: original.currency,
              fxRateToEgp: original.fxRateToEgp,
              accountId: original.accountId,
              cycleId: original.cycleId,
              relatedType: original.relatedType,
              relatedId: original.relatedId,
              reversalOfId: original.id,
              reason: `Refund undone: ${reason}`,
              createdBy: actorId,
            },
          });
        }

        // Conditional on still being un-reversed: the lock makes a second
        // undo wait, and this is the backstop if it ever did not.
        const marked = await tx.supplierRefund.updateMany({
          where: { id, reversedAt: null },
          data: {
            reversedAt: new Date(),
            reversedBy: actorId,
            reversalReason: reason,
            reversalTransactionId: reversal?.id ?? null,
          },
        });
        if (marked.count !== 1) throw alreadyReversed(new Date());

        const cycle = await tx.importCycle.findUnique({
          where: { id: found.purchaseOrder.cycleId },
          select: { code: true },
        });
        return { refund, reversal, cycleCode: cycle?.code };
      },
    );

    await this.audit.log({
      actorUserId: actorId,
      action: 'REVERSE',
      entityType: 'SupplierRefund',
      entityId: id,
      beforeJson: {
        amount: D(refund.amount).toFixed(2),
        currency: refund.currency,
        amountEgp: refundEgp(refund).toFixed(2),
        shipmentLossId: refund.shipmentLossId,
        cycle: cycleCode,
      },
      afterJson: { reversalId: reversal?.id ?? null, reason },
    });

    return {
      data: {
        id,
        reversed: true,
        reversalTransactionId: reversal?.id ?? null,
      },
    };
  }

  private async auditRefund(
    refund: { id: string },
    amountEgp: Prisma.Decimal,
    cycleCode: string | undefined,
    actorId: string,
  ) {
    await this.audit.log({
      actorUserId: actorId,
      action: 'RECORD_REFUND',
      entityType: 'SupplierRefund',
      entityId: refund.id,
      afterJson: {
        ...refund,
        amountEgp: amountEgp.toFixed(2),
        cycle: cycleCode,
      },
    });
  }
}

// ─── Refunds (§6) ─────────────────────────────────────────────────────────

export interface RefundInput {
  amount: number;
  currency: string;
  fxRateToEgp: number;
  reason?: string;
  recordedOn?: string;
}

const PAYER_TYPES = ['SHIPPING_PROVIDER', 'SUPPLIER'] as const;
type PayerType = (typeof PAYER_TYPES)[number];

export interface LossRefundInput extends RefundInput {
  payer: { type: PayerType; id: string };
}

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);

export const REVERSAL_REASON_MAX = 500;

/**
 * Reversing twice double-counts the correction (§9). The ledger's own code,
 * so the reader sees one refusal for one rule.
 */
function alreadyReversed(on: Date) {
  const date = on.toISOString().slice(0, 10);
  return badRequest(
    'ENTRY_ALREADY_REVERSED',
    `This refund was already undone on ${date}. Undoing it again would double-count the correction.`,
    { date },
  );
}

/**
 * The checks every refund passes before anything is read. In the service as
 * well as the DTO: the DTO is one caller (rule 3).
 */
function checkRefund(data: RefundInput) {
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw badRequest('VALIDATION_FAILED', 'A refund must be more than zero.', {
      fields: 'amount',
    });
  }
  if (Math.round(amount * 100) / 100 !== amount) {
    throw badRequest(
      'VALIDATION_FAILED',
      'A refund is in whole cents: at most two decimal places.',
      { fields: 'amount' },
    );
  }
  const fx = Number(data.fxRateToEgp);
  if (!Number.isFinite(fx) || fx <= 0) {
    throw badRequest(
      'VALIDATION_FAILED',
      'The exchange rate must be more than zero.',
      { fields: 'fxRateToEgp' },
    );
  }
  if (typeof data.currency !== 'string' || data.currency.trim() === '') {
    throw badRequest('VALIDATION_FAILED', 'Name the refund currency.', {
      fields: 'currency',
    });
  }
  // Money is received when it is received, never next week (rule 1, §6).
  assertNotFuture(data.recordedOn, 'REFUND_RECEIVED');
}

/** The order a refund is against, with what its cap reads. */
async function loadRefundOrder(tx: Db, purchaseOrderId: string) {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      items: { select: { lineTotal: true } },
      // Reversed refunds were handed back and no longer count (B5b).
      supplierRefunds: {
        where: COUNTING_REFUND,
        select: { amount: true, fxRateToEgp: true },
      },
      cycle: { select: { id: true, code: true } },
    },
  });
  if (!po) throw notFound('purchaseOrder');
  return po;
}

/**
 * The one writer of a refund: the order-level cap, the refund row and its
 * ledger inflow. A plain supplier refund and a loss refund both come through
 * here, inside a transaction holding the cycle's lock — so the order cap
 * counts loss refunds too, and there is one ledger write, not two (rule 11).
 */
async function bookRefund(
  tx: Db,
  po: Awaited<ReturnType<typeof loadRefundOrder>>,
  data: RefundInput,
  actorId: string,
  opts: {
    category: 'supplier_refund' | 'loss_refund';
    reason: string;
    shipmentLossId?: string;
    payerShippingProviderId?: string | null;
  },
) {
  const amountEgp = refundEgp(data);
  const orderValueEgp = po.items
    .reduce((s, i) => s.add(D(i.lineTotal)), D(0))
    .mul(D(po.fxRateToEgp));
  const alreadyRefundedEgp = po.supplierRefunds.reduce(
    (s, r) => s.add(refundEgp(r)),
    D(0),
  );

  // A supplier cannot give back more than was paid; a figure above that is a
  // data-entry slip that would show the cycle a profit it never made.
  if (alreadyRefundedEgp.add(amountEgp).gt(orderValueEgp)) {
    throw badRequest(
      'REFUND_EXCEEDS_ORDER',
      `Refund of ${formatMoney(amountEgp)} EGP exceeds what is left on ${po.reference}: ` +
        `order ${formatMoney(orderValueEgp)} EGP, already refunded ${formatMoney(alreadyRefundedEgp)} EGP.`,
      {
        refund: formatMoney(amountEgp),
        reference: po.reference,
        order: formatMoney(orderValueEgp),
        refunded: formatMoney(alreadyRefundedEgp),
      },
    );
  }

  const refund = await tx.supplierRefund.create({
    data: {
      purchaseOrderId: po.id,
      amount: data.amount,
      currency: data.currency,
      fxRateToEgp: data.fxRateToEgp,
      reason: data.reason,
      // The Cairo day it was received; today in Cairo when not given (§7a).
      recordedOn: new Date(
        `${data.recordedOn ? businessDay(data.recordedOn) : businessToday()}T00:00:00Z`,
      ),
      createdBy: actorId,
      shipmentLossId: opts.shipmentLossId ?? null,
      payerShippingProviderId: opts.payerShippingProviderId ?? null,
    },
  });

  // Without this the refund was recorded but had no financial effect: the
  // ledger never showed the money coming back and the cycle's cost never
  // dropped, so its profit stayed understated.
  await tx.financialTransaction.create({
    data: {
      type: 'SUPPLIER_REFUND',
      category: opts.category,
      direction: 'INFLOW',
      amount: amountEgp,
      currency: 'EGP',
      cycleId: po.cycleId,
      relatedType: 'SUPPLIER_REFUND',
      relatedId: refund.id,
      reason: opts.reason,
      createdBy: actorId,
    },
  });

  return { refund, amountEgp, cycleCode: po.cycle?.code };
}
