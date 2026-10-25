import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  PaginationDto,
  pageSize,
  cursorPage,
} from '../../common/dto/pagination.dto';
import { Prisma, RefundMethod } from '@prisma/client';
import { CreateReturnDto } from './dto/return.dto';
import { heldUnitPrice } from '../../common/held-price';
import {
  returnFigures,
  traceBack,
  writeReturnWithin,
  type ReturnLine,
} from '../../common/sale-return-writer';

import { badRequest, notFound } from '../../common/api-error';
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
      ...cursorPage(cursor, limit),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
    if (!found) throw notFound('return');
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
        customer: { select: { isWalkIn: true } },
        items: {
          include: {
            allocations: { include: { inventoryBatch: true } },
            returnItems: true,
            priceAdjustments: {
              select: { newUnitPrice: true, createdAt: true },
            },
            product: { select: { name: true } },
          },
        },
      },
    });
    if (!order) throw notFound('saleOrder');

    if (!RETURNABLE_ORDER_STATUSES.includes(order.status)) {
      throw badRequest(
        'ONLY_CONFIRMED_RETURNABLE',
        `Only a confirmed sale can be returned. ${order.orderNo} is ${order.status}.`,
        { order: order.orderNo, status: order.status },
      );
    }

    // Work out, per line, which batches the returned units come out of. Units
    // are taken back from the most recently allocated batch first: the last
    // units to leave are the ones the customer is handing back
    // (common/sale-return-writer.ts, which an order edit shares).
    const restocks: ReturnLine[] = [];

    for (const line of dto.items) {
      const saleItem = order.items.find((i) => i.id === line.saleItemId);
      if (!saleItem) {
        throw badRequest(
          'SALE_ITEM_NOT_IN_ORDER',
          `Sale item ${line.saleItemId} is not part of order ${order.orderNo}`,
          { order: order.orderNo },
        );
      }

      const sold = D(saleItem.quantity);
      const alreadyReturned = saleItem.returnItems.reduce((s, r) => s.add(D(r.qty)), D(0));
      const wanted = D(line.qty);
      const returnable = sold.sub(alreadyReturned);

      if (wanted.gt(returnable)) {
        throw badRequest(
          'RETURN_EXCEEDS_RETURNABLE',
          `Cannot return ${wanted.toFixed(3)} of ${saleItem.product.name}: ` +
            `${sold.toFixed(3)} sold, ${alreadyReturned.toFixed(3)} already returned, ` +
            `${returnable.toFixed(3)} still returnable.`,
          {
            wanted: wanted.toFixed(3),
            product: saleItem.product.name,
            sold: sold.toFixed(3),
            returned: alreadyReturned.toFixed(3),
            returnable: returnable.toFixed(3),
          },
        );
      }

      // What the shop holds the units at: the line's price, so a line discount
      // is refunded in the same proportion it was given — or, once the price
      // was lowered, the lower price (§4, 2026-10-22; common/held-price.ts).
      const unitPrice = heldUnitPrice(saleItem);

      // Damaged goods are refunded but not restocked, so their cost stays
      // spent — it becomes a write-off rather than returning to inventory.
      const { lines: traced, untraced: outstanding } = traceBack(
        saleItem,
        wanted,
        unitPrice,
        line.restock ?? true,
      );
      restocks.push(...traced);

      if (outstanding.gt(0)) {
        throw badRequest(
          'RETURN_UNTRACEABLE',
          `Could not trace ${outstanding.toFixed(3)} of ${saleItem.product.name} ` +
            'back to the batches it was sold from.',
          { qty: outstanding.toFixed(3), product: saleItem.product.name },
        );
      }
    }

    const { refundEgp, cogsReversedEgp } = returnFigures(restocks);
    // A walk-in buyer is refunded in money (BUSINESS_LOGIC §4, 2026-10-11).
    // There is no account to hold a credit note: the walk-in record is shared
    // by every walk-in sale and owes nothing, so a credit on it would be money
    // nobody can ever use. Asking for one is refused, not quietly changed.
    if (
      order.customer.isWalkIn &&
      dto.refundMethod === RefundMethod.CREDIT_NOTE
    ) {
      throw badRequest(
        'WALK_IN_REFUND_IN_MONEY',
        `${order.orderNo} was a walk-in sale, so it is refunded in money, not as credit.`,
        { order: order.orderNo },
      );
    }
    const refundMethod =
      dto.refundMethod ??
      (order.customer.isWalkIn ? RefundMethod.CASH : RefundMethod.CREDIT_NOTE);

    const created = await this.prisma.$transaction(async (tx) => {
      const { saleReturn } = await writeReturnWithin(tx, order, restocks, {
        returnedOn: dto.returnedOn ? new Date(dto.returnedOn) : new Date(),
        reason: dto.reason,
        refundMethod,
        actorId,
      });

      // The customer owes less. A credit note reduces the outstanding balance;
      // cash actually leaves and is recorded as an outflow instead.
      const outstanding = D(order.outstanding);
      const newOutstanding =
        refundMethod === RefundMethod.CREDIT_NOTE
          ? Prisma.Decimal.max(outstanding.sub(refundEgp), D(0))
          : outstanding;

      const fullyReturned = await this.isFullyReturned(tx, order.id);

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

  /**
   * True once every sold unit on the order has come back.
   *
   * Read inside the return's transaction, after its own lines were written,
   * so `returnItems` already holds this return. It used to add this return's
   * lines a second time: one of two units back read as two of two, the order
   * went RETURNED, and a RETURNED order owes nothing — so what the shop still
   * owed on the other unit dropped out of its balance (found 2026-10-11 by the
   * statement's invariant, 34 TC-INV-26 / TC-INV-29).
   */
  private async isFullyReturned(
    tx: Prisma.TransactionClient,
    saleOrderId: string,
  ) {
    const items = await tx.saleItem.findMany({
      where: { saleOrderId },
      include: { returnItems: true },
    });

    return items.every((item) => {
      const returned = item.returnItems.reduce(
        (s, r) => s.add(D(r.qty)),
        D(0),
      );
      return returned.gte(D(item.quantity));
    });
  }
}
