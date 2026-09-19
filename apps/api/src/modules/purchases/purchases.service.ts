import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { isUniqueViolation } from '../../prisma/unique-violation';
import { nextReferenceNumber, pad } from '../../common/references';
import { assertNotFuture } from '../../common/dates';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';
import { formatMoney } from '../../common/money';

import { badRequest, notFound } from '../../common/api-error';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import {
  SUPPLIER_INVOICE_REF_MAX,
  isSupplierInvoiceRefTooLong,
  normaliseSupplierInvoiceRef,
} from './supplier-invoice-ref';
import { OPEN_FOR_PURCHASING, isOpenForPurchasing } from './purchase-rules';

type Db = Prisma.TransactionClient;

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

  async findAll(pagination: PaginationDto & { cycleId?: string }) {
    const { cursor, limit: rawLimit = 20, cycleId } = pagination;
    const limit = pageSize(rawLimit);
    const where: Prisma.PurchaseOrderWhereInput = {};
    if (cycleId) where.cycleId = cycleId;

    const items = await this.prisma.purchaseOrder.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
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

  async findById(id: string) {
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
    return { data: po };
  }

  async findByCycle(cycleId: string) {
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
      .$transaction((tx) => this.writeOrder(tx, checked, data, actorId))
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
    assertNotFuture(data.orderedOn, 'The date an order was placed');
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
        title: `New purchase order ${order.reference} created for cycle ${cycle.code}`,
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

  async updateItem(
    id: string,
    data: { receivedQty?: number },
    actorId: string,
  ) {
    const existing = await this.prisma.purchaseOrderItem.findUnique({
      where: { id },
    });
    if (!existing) throw notFound('purchaseOrderItem');

    const updated = await this.prisma.purchaseOrderItem.update({
      where: { id },
      data: {
        receivedQty: data.receivedQty,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE_ITEM',
      entityType: 'PurchaseOrderItem',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
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
    data: {
      amount: number;
      currency: string;
      fxRateToEgp: number;
      reason?: string;
      recordedOn?: string;
    },
    actorId: string,
  ) {
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: {
        items: true,
        supplierRefunds: true,
        cycle: { select: { id: true, code: true } },
      },
    });
    if (!po) throw notFound('purchaseOrder');

    const D = (v: unknown) =>
      new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);

    const amountEgp = D(data.amount)
      .mul(D(data.fxRateToEgp))
      .toDecimalPlaces(2);
    const orderValueEgp = po.items
      .reduce((s, i) => s.add(D(i.lineTotal)), D(0))
      .mul(D(po.fxRateToEgp));
    const alreadyRefundedEgp = po.supplierRefunds.reduce(
      (s, r) => s.add(D(r.amount).mul(D(r.fxRateToEgp))),
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

    const refund = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supplierRefund.create({
        data: {
          purchaseOrderId,
          amount: data.amount,
          currency: data.currency,
          fxRateToEgp: data.fxRateToEgp,
          reason: data.reason,
          recordedOn: data.recordedOn ? new Date(data.recordedOn) : new Date(),
          createdBy: actorId,
        },
      });

      // Without this the refund was recorded but had no financial effect: the
      // ledger never showed the money coming back and the cycle's cost never
      // dropped, so its profit stayed understated.
      await tx.financialTransaction.create({
        data: {
          type: 'SUPPLIER_REFUND',
          category: 'supplier_refund',
          direction: 'INFLOW',
          amount: amountEgp,
          currency: 'EGP',
          cycleId: po.cycleId,
          relatedType: 'SUPPLIER_REFUND',
          relatedId: created.id,
          reason:
            `Supplier refund against ${po.reference}` +
            (data.reason ? `: ${data.reason}` : ''),
          createdBy: actorId,
        },
      });

      return created;
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'RECORD_REFUND',
      entityType: 'SupplierRefund',
      entityId: refund.id,
      afterJson: {
        ...refund,
        amountEgp: amountEgp.toFixed(2),
        cycle: po.cycle?.code,
      },
    });

    return { data: refund };
  }
}
