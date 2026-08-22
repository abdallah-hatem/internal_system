import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { nextReferenceNumber, pad } from '../../common/references';
import { assertNotFuture } from '../../common/dates';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';
import { formatMoney } from '../../common/money';

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
    const where: any = {};
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
    if (!po) throw new NotFoundException('Purchase order not found');
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

  async create(
    cycleId: string,
    data: {
      supplierId: string;
      currency: string;
      fxRateToEgp: number;
      orderedOn: string;
      items: Array<{
        productId: string;
        orderedQty: number;
        unitPrice: number;
        discount?: number;
      }>;
    },
    actorId: string,
  ) {
    assertNotFuture(data.orderedOn, 'The date an order was placed');

    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
    });
    if (!cycle) throw new NotFoundException('Cycle not found');

    // Validate cycle is in an appropriate status for purchasing
    if (!['PLANNING', 'FUNDING', 'PURCHASING'].includes(cycle.status)) {
      throw new BadRequestException(
        `Cycle must be in PLANNING, FUNDING or PURCHASING status to create purchase orders. Current: ${cycle.status}`,
      );
    }

    const supplier = await this.prisma.supplier.findUnique({
      where: { id: data.supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    // Validate items
    if (!data.items || data.items.length === 0) {
      throw new BadRequestException('Purchase order must contain at least one item');
    }
    for (const item of data.items) {
      if (!item.productId) {
        throw new BadRequestException('Each item must have a productId');
      }
      const product = await this.prisma.product.findUnique({ where: { id: item.productId } });
      if (!product) {
        throw new NotFoundException(`Product not found: ${item.productId}`);
      }
      if (!item.orderedQty || item.orderedQty <= 0) {
        throw new BadRequestException(`Invalid quantity for product ${item.productId}: must be greater than 0`);
      }
      if (item.unitPrice == null || item.unitPrice < 0) {
        throw new BadRequestException(`Invalid unitPrice for product ${item.productId}: must be 0 or greater`);
      }
    }

    // Generate reference: PO-YYYY-XXXX
    const year = new Date().getFullYear();
    const last = await this.prisma.purchaseOrder.findFirst({
      where: { reference: { startsWith: `PO-${year}` } },
      orderBy: { reference: 'desc' },
      select: { reference: true },
    });
    const reference = `PO-${year}-${pad(nextReferenceNumber(last?.reference, 4), 4)}`;

    // Create PO with items in a transaction
    const result = await this.prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.create({
        data: {
          cycleId,
          supplierId: data.supplierId,
          reference,
          currency: data.currency,
          fxRateToEgp: data.fxRateToEgp,
          orderedOn: new Date(data.orderedOn),
          status: 'DRAFT',
        },
      });

      // Create line items
      const items = [];
      for (const item of data.items) {
        const lineTotal =
          item.orderedQty * item.unitPrice * (item.discount ? 1 - item.discount / 100 : 1);

        const poItem = await tx.purchaseOrderItem.create({
          data: {
            purchaseOrderId: po.id,
            productId: item.productId,
            orderedQty: item.orderedQty,
            unitPrice: item.unitPrice,
            discount: item.discount || 0,
            lineTotal: lineTotal,
          },
        });
        items.push(poItem);
      }

      return { ...po, items };
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'PurchaseOrder',
      entityId: result.id,
      afterJson: result,
    });

    // Notify participants
    const participants = await this.prisma.cycleParticipant.findMany({
      where: { cycleId },
    });
    const userIds = participants
      .map((p) => [p.partnerUserId, p.investorUserId])
      .flat()
      .filter(Boolean) as string[];
    if (userIds.length > 0) {
      await this.notifications.createForMultipleUsers(userIds, {
        eventType: 'PURCHASE_ORDER_CREATED',
        title: `New purchase order ${result.reference} created for cycle ${cycle.code}`,
        payload: {
          purchaseOrderId: result.id,
          cycleId,
          cycleCode: cycle.code,
          supplierName: supplier.name,
        },
      });
    }

    return { data: result };
  }

  async addItem(
    purchaseOrderId: string,
    data: {
      productId: string;
      orderedQty: number;
      unitPrice: number;
      discount?: number;
    },
    actorId: string,
  ) {
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
    });
    if (!po) throw new NotFoundException('Purchase order not found');

    if (po.status !== 'DRAFT') {
      throw new BadRequestException(
        'Can only add items to a DRAFT purchase order',
      );
    }

    const lineTotal =
      data.orderedQty * data.unitPrice * (data.discount ? 1 - data.discount / 100 : 1);

    const item = await this.prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId,
        productId: data.productId,
        orderedQty: data.orderedQty,
        unitPrice: data.unitPrice,
        discount: data.discount || 0,
        lineTotal,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'ADD_ITEM',
      entityType: 'PurchaseOrderItem',
      entityId: item.id,
      afterJson: item,
    });

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
    if (!existing) throw new NotFoundException('Purchase order item not found');

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
    if (!po) throw new NotFoundException('Purchase order not found');

    const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);

    const amountEgp = D(data.amount).mul(D(data.fxRateToEgp)).toDecimalPlaces(2);
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
      throw new BadRequestException(
        `Refund of ${formatMoney(amountEgp)} EGP exceeds what is left on ${po.reference}: ` +
          `order ${formatMoney(orderValueEgp)} EGP, already refunded ${formatMoney(alreadyRefundedEgp)} EGP.`,
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
      afterJson: { ...refund, amountEgp: amountEgp.toFixed(2), cycle: po.cycle?.code },
    });

    return { data: refund };
  }
}
