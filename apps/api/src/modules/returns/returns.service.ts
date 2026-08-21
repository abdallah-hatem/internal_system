import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';
import { Prisma, RefundMethod } from '@prisma/client';
import { CreateReturnDto } from './dto/return.dto';

const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
const money = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** A sale must have happened before any of it can come back. */
const RETURNABLE_ORDER_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'];

const RETURN_INCLUDE = {
  saleOrder: {
    select: { id: true, orderNo: true, currency: true, customer: { select: { displayName: true } } },
  },
  items: {
    include: {
      saleItem: { select: { id: true, product: { select: { name: true, sku: true } } } },
      inventoryBatch: { select: { id: true, cycleId: true, landedUnitCostEgp: true } },
    },
  },
} satisfies Prisma.SaleReturnInclude;

@Injectable()
export class ReturnsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll(pagination: PaginationDto & { saleOrderId?: string }) {
    const { cursor, saleOrderId } = pagination;
    const limit = pageSize(pagination.limit);

    const items = await this.prisma.saleReturn.findMany({
      where: saleOrderId ? { saleOrderId } : {},
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      orderBy: { createdAt: 'desc' },
      include: RETURN_INCLUDE,
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    return {
      data,
      meta: { nextCursor: hasMore ? data[data.length - 1]?.id ?? null : null, limit },
    };
  }

  async findOne(id: string) {
    const found = await this.prisma.saleReturn.findUnique({
      where: { id },
      include: RETURN_INCLUDE,
    });
    if (!found) throw new NotFoundException('Return not found');
    return { data: found };
  }

  /**
   * Take goods back from a customer.
   *
   * Nothing about the original sale is edited — the BRD requires history to
   * survive (9, 10), so a return is its own record and the sale keeps saying
   * what it always said. What changes is derived: the customer owes less, the
   * stock is back, and the cost of goods sold is put back so cycle profit
   * corrects itself.
   *
   * Units go back to the batch they came from, at the cost they left at. That
   * matters because the same product sits in several batches at different
   * landed costs (BRD 6): restocking into "the product" would quietly re-price
   * inventory and misstate the profit of whichever cycle owns the batch.
   */
  async create(dto: CreateReturnDto, actorId?: string) {
    const order = await this.prisma.saleOrder.findUnique({
      where: { id: dto.saleOrderId },
      include: {
        items: {
          include: {
            allocations: { include: { inventoryBatch: true } },
            returnItems: true,
            product: { select: { name: true } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Sale order not found');

    if (!RETURNABLE_ORDER_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        `Only a confirmed sale can be returned. ${order.orderNo} is ${order.status}.`,
      );
    }

    // Work out, per line, which batches the returned units come out of. Units
    // are taken back from the most recently allocated batch first: the last
    // units to leave are the ones the customer is handing back.
    type Restock = {
      saleItemId: string;
      batchId: string;
      qty: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
      unitCost: Prisma.Decimal;
      restock: boolean;
    };
    const restocks: Restock[] = [];
    let refundTotal = D(0);
    let cogsTotal = D(0);

    for (const line of dto.items) {
      const saleItem = order.items.find((i) => i.id === line.saleItemId);
      if (!saleItem) {
        throw new BadRequestException(
          `Sale item ${line.saleItemId} is not part of order ${order.orderNo}`,
        );
      }

      const sold = D(saleItem.quantity);
      const alreadyReturned = saleItem.returnItems.reduce((s, r) => s.add(D(r.qty)), D(0));
      const wanted = D(line.qty);
      const returnable = sold.sub(alreadyReturned);

      if (wanted.gt(returnable)) {
        throw new BadRequestException(
          `Cannot return ${wanted.toFixed(3)} of ${saleItem.product.name}: ` +
            `${sold.toFixed(3)} sold, ${alreadyReturned.toFixed(3)} already returned, ` +
            `${returnable.toFixed(3)} still returnable.`,
        );
      }

      // Selling price per unit from this line, so a line discount is refunded
      // in the same proportion it was given.
      const unitPrice = sold.gt(0) ? D(saleItem.lineTotal).div(sold) : D(0);

      let outstanding = wanted;
      const allocations = [...saleItem.allocations].sort(
        (a, b) => (a.createdAt < b.createdAt ? 1 : -1),
      );

      for (const alloc of allocations) {
        if (outstanding.lte(0)) break;

        const takenBack = saleItem.returnItems
          .filter((r) => r.inventoryBatchId === alloc.inventoryBatchId)
          .reduce((s, r) => s.add(D(r.qty)), D(0));
        const availableFromBatch = D(alloc.qty).sub(takenBack);
        if (availableFromBatch.lte(0)) continue;

        const qty = Prisma.Decimal.min(outstanding, availableFromBatch);
        const unitCost = D(alloc.unitCostEgp);
        const restock = line.restock ?? true;

        restocks.push({
          saleItemId: saleItem.id,
          batchId: alloc.inventoryBatchId,
          qty,
          unitPrice,
          unitCost,
          restock,
        });

        refundTotal = refundTotal.add(unitPrice.mul(qty));
        // Damaged goods are refunded but not restocked, so their cost stays
        // spent — it becomes a write-off rather than returning to inventory.
        if (restock) cogsTotal = cogsTotal.add(unitCost.mul(qty));

        outstanding = outstanding.sub(qty);
      }

      if (outstanding.gt(0)) {
        throw new BadRequestException(
          `Could not trace ${outstanding.toFixed(3)} of ${saleItem.product.name} ` +
            'back to the batches it was sold from.',
        );
      }
    }

    const refundEgp = money(refundTotal);
    const cogsReversedEgp = money(cogsTotal);
    const refundMethod = dto.refundMethod ?? RefundMethod.CREDIT_NOTE;

    const created = await this.prisma.$transaction(async (tx) => {
      const seq = await tx.saleReturn.count();
      const saleReturn = await tx.saleReturn.create({
        data: {
          saleOrderId: order.id,
          reference: `RET-${new Date().getFullYear()}-${String(seq + 1).padStart(5, '0')}`,
          returnedOn: dto.returnedOn ? new Date(dto.returnedOn) : new Date(),
          reason: dto.reason,
          refundMethod,
          refundEgp,
          cogsReversedEgp,
          createdBy: actorId,
        },
      });

      for (const r of restocks) {
        await tx.saleReturnItem.create({
          data: {
            saleReturnId: saleReturn.id,
            saleItemId: r.saleItemId,
            inventoryBatchId: r.batchId,
            qty: r.qty,
            unitPrice: money(r.unitPrice),
            refundEgp: money(r.unitPrice.mul(r.qty)),
            unitCostEgp: r.unitCost,
            cogsReversedEgp: r.restock ? money(r.unitCost.mul(r.qty)) : D(0),
            restocked: r.restock,
          },
        });

        if (r.restock) {
          await tx.inventoryBatch.update({
            where: { id: r.batchId },
            data: {
              remainingQty: { increment: r.qty },
              saleableQty: { increment: r.qty },
            },
          });
        }

        await tx.inventoryMovement.create({
          data: {
            batchId: r.batchId,
            movementType: r.restock ? 'RETURN' : 'WRITE_OFF',
            qtyDelta: r.restock ? r.qty : D(0),
            // The movement carries no free-text reason column; the link to
            // the return, and the reason on it, is the reference pair.
            referenceType: 'SALE_RETURN',
            referenceId: saleReturn.id,
            createdBy: actorId,
          },
        });
      }

      // The customer owes less. A credit note reduces the outstanding balance;
      // cash actually leaves and is recorded as an outflow instead.
      const outstanding = D(order.outstanding);
      const newOutstanding =
        refundMethod === RefundMethod.CREDIT_NOTE
          ? Prisma.Decimal.max(outstanding.sub(refundEgp), D(0))
          : outstanding;

      const fullyReturned = await this.isFullyReturned(tx, order.id, restocks);

      await tx.saleOrder.update({
        where: { id: order.id },
        data: {
          outstanding: money(newOutstanding),
          status: fullyReturned
            ? 'RETURNED'
            : newOutstanding.lte(0) && order.status !== 'CONFIRMED'
              ? 'PAID'
              : order.status,
        },
      });

      // Revenue that is no longer earned, and the cost that comes back with it.
      await tx.financialTransaction.create({
        data: {
          type: 'SALE_RETURN',
          category: 'revenue',
          direction: 'OUTFLOW',
          amount: refundEgp,
          currency: order.currency,
          relatedType: 'SALE_RETURN',
          relatedId: saleReturn.id,
          reason: `Return ${saleReturn.reference} against ${order.orderNo}: ${dto.reason}`,
          createdBy: actorId,
        },
      });

      if (refundMethod === RefundMethod.CASH) {
        await tx.financialTransaction.create({
          data: {
            type: 'REFUND_PAID',
            category: 'refund',
            direction: 'OUTFLOW',
            amount: refundEgp,
            currency: order.currency,
            relatedType: 'SALE_RETURN',
            relatedId: saleReturn.id,
            reason: `Cash refunded for ${saleReturn.reference}`,
            createdBy: actorId,
          },
        });
      }

      return tx.saleReturn.findUnique({
        where: { id: saleReturn.id },
        include: RETURN_INCLUDE,
      });
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'SaleReturn',
      entityId: created!.id,
      afterJson: {
        reference: created!.reference,
        saleOrder: order.orderNo,
        refundEgp: refundEgp.toFixed(2),
        cogsReversedEgp: cogsReversedEgp.toFixed(2),
        refundMethod,
        reason: dto.reason,
      },
    });

    return { data: created };
  }

  /** True once every sold unit on the order has come back. */
  private async isFullyReturned(
    tx: Prisma.TransactionClient,
    saleOrderId: string,
    justAdded: { saleItemId: string; qty: Prisma.Decimal }[],
  ) {
    const items = await tx.saleItem.findMany({
      where: { saleOrderId },
      include: { returnItems: true },
    });

    return items.every((item) => {
      const previously = item.returnItems.reduce((s, r) => s.add(D(r.qty)), D(0));
      const now = justAdded
        .filter((r) => r.saleItemId === item.id)
        .reduce((s, r) => s.add(r.qty), D(0));
      return previously.add(now).gte(D(item.quantity));
    });
  }
}
