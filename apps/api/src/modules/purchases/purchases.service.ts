import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class PurchasesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  async findAll(pagination: PaginationDto & { cycleId?: string }) {
    const { cursor, limit = 20, cycleId } = pagination;
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

    // Generate reference: PO-YYYY-XXXX
    const year = new Date().getFullYear();
    const count = await this.prisma.purchaseOrder.count({
      where: { reference: { startsWith: `PO-${year}` } },
    });
    const reference = `PO-${year}-${String(count + 1).padStart(4, '0')}`;

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

  async recordRefund(
    purchaseOrderId: string,
    data: {
      amount: number;
      currency: string;
      fxRateToEgp: number;
      reason?: string;
      recordedOn: string;
    },
    actorId: string,
  ) {
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
    });
    if (!po) throw new NotFoundException('Purchase order not found');

    const refund = await this.prisma.supplierRefund.create({
      data: {
        purchaseOrderId,
        amount: data.amount,
        currency: data.currency,
        fxRateToEgp: data.fxRateToEgp,
        reason: data.reason,
        recordedOn: new Date(data.recordedOn),
        createdBy: actorId,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'RECORD_REFUND',
      entityType: 'SupplierRefund',
      entityId: refund.id,
      afterJson: refund,
    });

    return { data: refund };
  }
}
