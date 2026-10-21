import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { badRequest, notFound } from '../../common/api-error';
import { businessDay, chosenDay } from '../../common/dates';
import { fundingLockOf } from '../../common/funding-lock';
import { heldByBatch, heldUnitPrice, heldUnits } from '../../common/held-price';
import { isUuid } from '../../common/uuid';

const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** A sale the shop still owes on: the only kind whose price can be lowered. */
const ADJUSTABLE_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID'];

/** A cycle being settled or done: its sales' figures are agreed. */
const SETTLED_CYCLE_STATUSES = ['SETTLEMENT', 'CLOSED', 'CANCELLED'];

export interface PriceAdjustmentInput {
  saleItemId?: string;
  newUnitPrice?: unknown;
  adjustedOn?: unknown;
  reason?: string;
}

type Db = Prisma.TransactionClient | PrismaService;

/**
 * Lowering a price after the order is confirmed (BUSINESS_LOGIC §4, owner
 * 2026-10-22). Koshary was given 100 off every unit he held after two returns
 * and a payment; cancelling and re-entering the order would have broken both.
 *
 * Like a return, the adjustment is its own dated record and the line keeps the
 * price it was sold at: what the order owes drops, and revenue drops on the
 * adjustment's day — the reports already looked at do not change. It covers
 * only the units the shop still holds, split per batch so each cycle loses the
 * revenue on its own units. No ledger row: no money moved.
 *
 * `plan` is the whole decision and writes nothing; the preview shows it and
 * `create` writes exactly it, under the order's row lock, so two adjustments
 * sent at once cannot both lower from the same price.
 */
@Injectable()
export class PriceAdjustmentsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async preview(saleOrderId: string, input: PriceAdjustmentInput) {
    const plan = await this.plan(this.prisma, saleOrderId, input);
    return { data: summary(plan) };
  }

  async create(
    saleOrderId: string,
    input: PriceAdjustmentInput,
    actorId?: string,
  ) {
    const { plan, created } = await this.prisma.$transaction(async (tx) => {
      if (isUuid(saleOrderId)) {
        await tx.$queryRaw`SELECT id FROM sale_orders WHERE id = ${saleOrderId}::uuid FOR UPDATE`;
      }
      const plan = await this.plan(tx, saleOrderId, input);
      const created = await tx.salePriceAdjustment.create({
        data: {
          saleOrderId: plan.order.id,
          saleItemId: plan.line.id,
          adjustedOn: new Date(`${plan.adjustedOn}T00:00:00Z`),
          previousUnitPrice: plan.previousUnitPrice,
          newUnitPrice: plan.newUnitPrice,
          qty: plan.held,
          amountEgp: plan.amount,
          reason: plan.reason,
          createdBy: actorId,
          items: {
            create: plan.batches.map((b) => ({
              inventoryBatchId: b.inventoryBatchId,
              qty: b.qty,
              amountEgp: b.amount,
            })),
          },
        },
        include: { items: true },
      });
      const outstanding = D(plan.order.outstanding).sub(plan.amount);
      await tx.saleOrder.update({
        where: { id: plan.order.id },
        data: {
          outstanding: money(outstanding),
          // Owing nothing after a payment is paid up, as a credit note leaves it.
          status:
            outstanding.lte(0) && plan.order.status !== 'CONFIRMED'
              ? 'PAID'
              : plan.order.status,
          version: { increment: 1 },
        },
      });
      return { plan, created };
    });

    // After the commit, as the sales service logs (one connection in tests).
    await this.audit.log({
      actorUserId: actorId,
      action: 'PRICE_ADJUSTED',
      entityType: 'SaleOrder',
      entityId: plan.order.id,
      afterJson: {
        adjustment: created.id,
        order: plan.order.orderNo,
        product: plan.line.product.name,
        previousUnitPrice: plan.previousUnitPrice.toFixed(2),
        newUnitPrice: plan.newUnitPrice.toFixed(2),
        qty: plan.held.toString(),
        amountEgp: plan.amount.toFixed(2),
        adjustedOn: plan.adjustedOn,
        reason: plan.reason,
      },
    });
    return { data: { ...summary(plan), id: created.id } };
  }

  /** Everything `create` decides, checked, and nothing written. */
  async plan(db: Db, saleOrderId: string, input: PriceAdjustmentInput) {
    if (!isUuid(saleOrderId)) throw notFound('saleOrder');
    const order = await db.saleOrder.findUnique({
      where: { id: saleOrderId },
      include: {
        paymentPlan: { select: { reference: true, status: true } },
        items: {
          include: {
            product: { select: { name: true } },
            returnItems: { select: { qty: true, inventoryBatchId: true } },
            priceAdjustments: {
              select: { newUnitPrice: true, createdAt: true },
            },
            allocations: {
              select: {
                inventoryBatchId: true,
                qty: true,
                createdAt: true,
                inventoryBatch: {
                  select: {
                    cycle: {
                      select: {
                        code: true,
                        status: true,
                        settlements: {
                          where: { status: { in: ['APPROVED', 'PAID'] } },
                          select: { status: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!order) throw notFound('saleOrder');

    if (!ADJUSTABLE_STATUSES.includes(order.status)) {
      throw badRequest(
        'PRICE_ADJUSTMENT_ORDER_NOT_OPEN',
        `Only a confirmed sale that is still owed can have its price lowered. ${order.orderNo} is ${order.status}.`,
        { order: order.orderNo, status: order.status },
      );
    }
    // A contract covers exactly what the sale owed when it was signed (§7):
    // lowering the price under it would read as instalments paid.
    if (order.paymentPlan?.status === 'ACTIVE') {
      throw badRequest(
        'PRICE_ADJUSTMENT_UNDER_CONTRACT',
        `${order.orderNo} is sold on instalments (${order.paymentPlan.reference}). Cancel the contract, lower the price, then draw a new one.`,
        { order: order.orderNo, plan: order.paymentPlan.reference },
      );
    }

    const line = order.items.find((i) => i.id === input.saleItemId);
    if (!line) {
      throw badRequest(
        'SALE_ITEM_NOT_IN_ORDER',
        `Sale item ${String(input.saleItemId)} is not part of order ${order.orderNo}`,
        { order: order.orderNo },
      );
    }

    const price = Number(input.newUnitPrice);
    if (
      input.newUnitPrice === undefined ||
      input.newUnitPrice === null ||
      input.newUnitPrice === '' ||
      !Number.isFinite(price) ||
      price < 0
    ) {
      throw badRequest(
        'PRICE_ADJUSTMENT_BAD_PRICE',
        'The new price must be a number, zero or more.',
        { value: String(input.newUnitPrice) },
      );
    }
    const newUnitPrice = money(D(price));
    const previousUnitPrice = heldUnitPrice(line);
    if (newUnitPrice.gte(money(previousUnitPrice))) {
      throw badRequest(
        'PRICE_ADJUSTMENT_NOT_LOWER',
        `${line.product.name} is at ${previousUnitPrice.toFixed(2)} a unit; a price can only be lowered here.`,
        {
          product: line.product.name,
          current: previousUnitPrice.toFixed(2),
          price: newUnitPrice.toFixed(2),
        },
      );
    }

    const held = heldUnits(line);
    if (held.lte(0)) {
      throw badRequest(
        'PRICE_ADJUSTMENT_NOTHING_HELD',
        `Every unit of ${line.product.name} on ${order.orderNo} has been returned; there is nothing to lower the price of.`,
        { product: line.product.name, order: order.orderNo },
      );
    }

    const adjustedOn = chosenDay(input.adjustedOn, 'PRICE_ADJUSTED');
    const orderedOn = businessDay(order.orderedAt);
    if (adjustedOn < orderedOn) {
      throw badRequest(
        'PRICE_ADJUSTMENT_BEFORE_SALE',
        `${order.orderNo} was sold on ${orderedOn}; its price cannot be lowered on ${adjustedOn}.`,
        { order: order.orderNo, sold: orderedOn, day: adjustedOn },
      );
    }

    for (const a of line.allocations) {
      const cycle = a.inventoryBatch.cycle;
      if (
        SETTLED_CYCLE_STATUSES.includes(cycle.status) ||
        fundingLockOf(cycle.status, cycle.settlements)
      ) {
        throw badRequest(
          'PRICE_ADJUSTMENT_CYCLE_SETTLED',
          `These units came from cycle ${cycle.code}, which is being settled or is settled; its sales can no longer change.`,
          { cycle: cycle.code },
        );
      }
    }

    const step = previousUnitPrice.sub(newUnitPrice);
    const amount = money(step.mul(held));
    if (amount.gt(D(order.outstanding))) {
      throw badRequest(
        'PRICE_ADJUSTMENT_EXCEEDS_OWED',
        `Lowering ${line.product.name} to ${newUnitPrice.toFixed(2)} takes ${amount.toFixed(2)} off, but ${order.orderNo} owes only ${D(order.outstanding).toFixed(2)}. Anything beyond what is owed is a refund.`,
        {
          product: line.product.name,
          amount: amount.toFixed(2),
          owed: D(order.outstanding).toFixed(2),
          order: order.orderNo,
        },
      );
    }

    // Per batch, so each cycle loses its own units' revenue; the last batch
    // takes the rounding residual and the parts add up to the whole.
    const parts = heldByBatch(line);
    let left = amount;
    const batches = parts.map((b, i) => {
      const share = i === parts.length - 1 ? left : money(step.mul(b.qty));
      left = left.sub(share);
      return {
        inventoryBatchId: b.inventoryBatchId,
        qty: b.qty,
        amount: share,
      };
    });

    return {
      order,
      line,
      adjustedOn,
      previousUnitPrice,
      newUnitPrice,
      held,
      amount,
      batches,
      reason: input.reason?.trim() || null,
    };
  }
}

function summary(plan: Awaited<ReturnType<PriceAdjustmentsService['plan']>>) {
  const owedBefore = D(plan.order.outstanding);
  return {
    saleOrderId: plan.order.id,
    orderNo: plan.order.orderNo,
    saleItemId: plan.line.id,
    product: plan.line.product.name,
    adjustedOn: plan.adjustedOn,
    previousUnitPrice: money(plan.previousUnitPrice).toFixed(2),
    newUnitPrice: plan.newUnitPrice.toFixed(2),
    qty: plan.held.toString(),
    amountEgp: plan.amount.toFixed(2),
    owedBefore: owedBefore.toFixed(2),
    owedAfter: money(owedBefore.sub(plan.amount)).toFixed(2),
  };
}
