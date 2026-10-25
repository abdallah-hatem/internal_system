import { Inject, Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma, RefundMethod } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { badRequest, conflict, notFound } from '../../common/api-error';
import { businessDay, chosenDay, instantOfDay } from '../../common/dates';
import { heldUnitPrice, heldUnits } from '../../common/held-price';
import { isSamplesStatus } from '../../common/samples';
import {
  returnFigures,
  traceBack,
  writeReturnWithin,
  type ReturnLine,
} from '../../common/sale-return-writer';
import { isUuid } from '../../common/uuid';
import {
  NotificationsService,
  notifyLowStock,
  type LowStockNotifier,
} from '../notifications/notifications.service';
import {
  ALLOCATION_CYCLE_SELECT,
  batchShares,
  settledCycleOf,
} from './price-adjustments.service';
import {
  fifoBatches,
  notEnoughStock,
  receivedCutoff,
  SalesService,
} from './sales.service';

const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** A sale that happened and still stands: the only kind that can be edited. */
const EDITABLE_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'];

/** Above this a price is a typing slip, and past the column's size a 500. */
const MAX_UNIT_PRICE = D('9999999999.99');
const MAX_LINES = 200;
const MAX_REASON = 500;

export interface OrderEditLineInput {
  productId?: unknown;
  /** The units the shop will hold of the product after the edit; 0 gives every one back. */
  quantity?: unknown;
  /** The price per unit after the edit; left out, the price stays. Required for a new product. */
  unitPrice?: unknown;
}

export interface OrderEditInput {
  /** The order's version as it was read — required to save, not to preview. */
  version?: unknown;
  editedOn?: unknown;
  reason?: unknown;
  /** Only the products that change; every other line stays as it is. */
  lines?: unknown;
}

type Db = Prisma.TransactionClient | PrismaService;

const ORDER_INCLUDE = {
  customer: { select: { isWalkIn: true } },
  paymentPlan: { select: { reference: true, status: true } },
  items: {
    orderBy: { createdAt: 'asc' },
    include: {
      product: {
        select: { id: true, name: true, nameAr: true, status: true },
      },
      returnItems: { select: { qty: true, inventoryBatchId: true } },
      priceAdjustments: { select: { newUnitPrice: true, createdAt: true } },
      allocations: {
        select: {
          inventoryBatchId: true,
          qty: true,
          unitCostEgp: true,
          createdAt: true,
          inventoryBatch: { select: ALLOCATION_CYCLE_SELECT },
        },
      },
    },
  },
} satisfies Prisma.SaleOrderInclude;

type LoadedOrder = Prisma.SaleOrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;
type LoadedItem = LoadedOrder['items'][number];

interface PriceChange {
  item: LoadedItem;
  previousUnitPrice: Prisma.Decimal;
  newUnitPrice: Prisma.Decimal;
  qty: Prisma.Decimal;
  amount: Prisma.Decimal;
  shares: ReturnType<typeof batchShares>;
}

interface Addition {
  productId: string;
  product: string;
  qty: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  /** The landed cost FIFO would draw now: the preview's figure; saving records the real one. */
  costPreview: Prisma.Decimal;
}

export interface LineSummary {
  productId: string;
  product: string;
  productAr: string | null;
  qtyBefore: string;
  qtyAfter: string;
  priceBefore: string | null;
  priceAfter: string;
  added: string;
  givenBack: string;
}

/**
 * Editing a confirmed order (BUSINESS_LOGIC §4 "Editing a confirmed order",
 * owner 2026-10-25): add a product, change a quantity, change a price up or
 * down. It reads as editing; underneath, each edit is one dated record whose
 * parts are the records that already mean each thing, so no reader has to
 * learn a second meaning of a sale:
 *
 * - **units given back** are a return on credit note (`writeReturnWithin`,
 *   the one definition), back to the batches they came from at their cost;
 * - **a price changed** is a price adjustment on the held units, per batch —
 *   negative when it is raised;
 * - **units added** are a new sale line dated by the edit, drawn FIFO that
 *   day (`SalesService.drawFifo`, the one definition of drawing stock).
 *
 * Revenue and cost of each part count on the edit's day. `plan` is the whole
 * decision and writes nothing; the preview shows it and `create` re-plans
 * under the order's row lock — stock re-read, never the preview's — and
 * writes exactly that.
 */
@Injectable()
export class OrderEditsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private sales: SalesService,
    @Inject(NotificationsService) private notifications: LowStockNotifier,
  ) {}

  async preview(saleOrderId: string, input: OrderEditInput) {
    const plan = await this.plan(this.prisma, saleOrderId, input ?? {});
    return { data: summary(plan) };
  }

  async create(saleOrderId: string, input: OrderEditInput, actorId?: string) {
    input = input ?? {};
    if (input.version === undefined || input.version === null) {
      throw badRequest(
        'VERSION_REQUIRED',
        'Editing an order requires the version it was read at.',
      );
    }
    const { plan, edit, lowStock, cogsAdded } = await this.prisma.$transaction(
      async (tx) => {
        if (isUuid(saleOrderId)) {
          await tx.$queryRaw`SELECT id FROM sale_orders WHERE id = ${saleOrderId}::uuid FOR UPDATE`;
          // Checked first: a second save of the same edit, or another
          // partner's edit landing between preview and save, is told the
          // order moved on — not judged against a state it never saw.
          const locked = await tx.saleOrder.findUnique({
            where: { id: saleOrderId },
            select: { version: true },
          });
          if (locked && Number(input.version) !== locked.version) {
            throw conflict(
              'ORDER_VERSION_CONFLICT',
              'Version conflict — order was modified',
            );
          }
        }
        const plan = await this.plan(tx, saleOrderId, input);
        const { order } = plan;
        const day = new Date(`${plan.editedOn}T00:00:00Z`);

        const edit = await tx.saleOrderEdit.create({
          data: {
            saleOrderId: order.id,
            editedOn: day,
            reason: plan.reason,
            owedBefore: plan.owedBefore,
            owedAfter: plan.owedAfter,
            amountEgp: plan.change,
            createdBy: actorId,
          },
        });

        if (plan.givenBack.length > 0) {
          await writeReturnWithin(tx, order, plan.givenBack, {
            returnedOn: day,
            reason: plan.reason ?? `Edit of ${order.orderNo}`,
            refundMethod: RefundMethod.CREDIT_NOTE,
            actorId,
            editId: edit.id,
          });
        }

        for (const p of plan.priceChanges) {
          await tx.salePriceAdjustment.create({
            data: {
              saleOrderId: order.id,
              saleItemId: p.item.id,
              adjustedOn: day,
              previousUnitPrice: p.previousUnitPrice,
              newUnitPrice: p.newUnitPrice,
              qty: p.qty,
              amountEgp: p.amount,
              reason: plan.reason,
              createdBy: actorId,
              editId: edit.id,
              items: {
                create: p.shares.map((s) => ({
                  inventoryBatchId: s.inventoryBatchId,
                  qty: s.qty,
                  amountEgp: s.amount,
                })),
              },
            },
          });
        }

        let lowStock: Awaited<
          ReturnType<SalesService['drawFifo']>
        >['lowStock'] = [];
        let cogsAdded = D(0);
        if (plan.additions.length > 0) {
          const added = [];
          for (const a of plan.additions) {
            const item = await tx.saleItem.create({
              data: {
                saleOrderId: order.id,
                productId: a.productId,
                quantity: a.qty,
                unitPrice: a.unitPrice,
                discount: 0,
                lineTotal: a.lineTotal,
                editId: edit.id,
              },
            });
            added.push({
              id: item.id,
              productId: a.productId,
              quantity: a.qty,
              product: { name: a.product },
            });
          }
          // Drawn as a sale made on the edit's day: a back-dated edit takes
          // only what had arrived by then (§4, 2026-10-16).
          const drawn = await this.sales.drawFifo(
            tx,
            {
              id: order.id,
              orderedAt: instantOfDay(plan.editedOn),
              createdAt: new Date(),
              items: added,
            },
            actorId!,
            { movementType: 'SALE', referenceType: 'SALE_ORDER' },
          );
          lowStock = drawn.lowStock;
          cogsAdded = drawn.totalCogs;
        }

        await tx.saleOrder.update({
          where: { id: order.id },
          data: {
            outstanding: plan.owedAfter,
            status: plan.statusAfter,
            version: { increment: 1 },
          },
        });
        return { plan, edit, lowStock, cogsAdded };
      },
    );

    // After the commit (LEARNINGS: never inside `$transaction`).
    await this.audit.log({
      actorUserId: actorId,
      action: 'ORDER_EDITED',
      entityType: 'SaleOrder',
      entityId: plan.order.id,
      afterJson: {
        edit: edit.id,
        order: plan.order.orderNo,
        editedOn: plan.editedOn,
        changeEgp: plan.change.toFixed(2),
        owedBefore: plan.owedBefore.toFixed(2),
        owedAfter: plan.owedAfter.toFixed(2),
        cogsAddedEgp: money(cogsAdded).toFixed(2),
        lines: plan.lines.map((l) => ({
          product: l.product,
          qty: `${l.qtyBefore} -> ${l.qtyAfter}`,
          price: `${l.priceBefore ?? '-'} -> ${l.priceAfter}`,
        })),
        reason: plan.reason,
      },
    });
    await notifyLowStock(this.prisma, this.notifications, lowStock);
    return { data: { ...summary(plan), id: edit.id } };
  }

  /** Everything `create` decides, checked, and nothing written. */
  async plan(db: Db, saleOrderId: string, input: OrderEditInput) {
    if (!isUuid(saleOrderId)) throw notFound('saleOrder');
    const order = await db.saleOrder.findUnique({
      where: { id: saleOrderId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw notFound('saleOrder');

    if (isSamplesStatus(order.status)) {
      throw badRequest(
        'EDIT_ORDER_SAMPLES',
        `${order.orderNo} is samples left at a shop; it changes through its own steps, not an edit.`,
        { order: order.orderNo },
      );
    }
    if (!EDITABLE_STATUSES.includes(order.status)) {
      throw badRequest(
        'EDIT_ORDER_NOT_EDITABLE',
        `Only a confirmed sale can be edited. ${order.orderNo} is ${order.status}.`,
        { order: order.orderNo, status: order.status },
      );
    }
    // The walk-in record never owes (§4): an edit that raised it would
    // leave a debt nobody can be asked for.
    if (order.customer.isWalkIn) {
      throw badRequest(
        'EDIT_ORDER_WALK_IN',
        `${order.orderNo} was a walk-in sale, paid on the spot; it cannot be edited. Record a return instead.`,
        { order: order.orderNo },
      );
    }
    if (order.paymentPlan?.status === 'ACTIVE') {
      throw badRequest(
        'EDIT_ORDER_UNDER_CONTRACT',
        `${order.orderNo} is sold on instalments (${order.paymentPlan.reference}). Cancel the contract, edit the order, then draw a new one.`,
        { order: order.orderNo, plan: order.paymentPlan.reference },
      );
    }
    const settled = settledCycleOf(order.items.flatMap((i) => i.allocations));
    if (settled) {
      throw badRequest(
        'EDIT_ORDER_CYCLE_SETTLED',
        `${order.orderNo} sold units from cycle ${settled}, which is being settled or is settled; the order can no longer change.`,
        { order: order.orderNo, cycle: settled },
      );
    }

    const editedOn = chosenDay(input.editedOn, 'ORDER_EDITED');
    const orderedOn = businessDay(order.orderedAt);
    if (editedOn < orderedOn) {
      throw badRequest(
        'EDIT_ORDER_BEFORE_SALE',
        `${order.orderNo} was sold on ${orderedOn}; it cannot be edited on ${editedOn}.`,
        { order: order.orderNo, sold: orderedOn, day: editedOn },
      );
    }

    let reason: string | null = null;
    if (input.reason !== undefined && input.reason !== null) {
      if (
        typeof input.reason !== 'string' ||
        input.reason.length > MAX_REASON
      ) {
        throw badRequest(
          'VALIDATION_FAILED',
          `The note must be text of at most ${MAX_REASON} characters.`,
          { fields: 'reason' },
        );
      }
      reason = input.reason.trim() || null;
    }

    const wanted = parseLines(input.lines);
    const newIds = wanted
      .map((w) => w.productId)
      .filter((id) => !order.items.some((i) => i.productId === id));
    const products = newIds.length
      ? await db.product.findMany({
          where: { id: { in: newIds } },
          select: { id: true, name: true, nameAr: true, status: true },
        })
      : [];

    const givenBack: ReturnLine[] = [];
    const priceChanges: PriceChange[] = [];
    const additions: Addition[] = [];
    const lines: LineSummary[] = [];
    const cutoff = receivedCutoff(editedOn);

    for (const w of wanted) {
      const rows = order.items.filter((i) => i.productId === w.productId);
      const product =
        rows[0]?.product ?? products.find((p) => p.id === w.productId);
      if (!product) throw notFound('product');

      const held = rows.reduce((s, r) => s.add(heldUnits(r)), D(0));
      // The price the shop's units are at now: the newest line still held.
      const newestHeld =
        [...rows].reverse().find((r) => heldUnits(r).gt(0)) ??
        rows[rows.length - 1];
      const priceBefore = newestHeld ? money(heldUnitPrice(newestHeld)) : null;

      if (rows.length === 0 && w.quantity.gt(0) && w.unitPrice === undefined) {
        throw badRequest(
          'EDIT_ORDER_PRICE_REQUIRED',
          `${product.name} is new on ${order.orderNo}; it needs a price.`,
          { product: product.name },
        );
      }

      // Units given back: the newest line first, and within it the last
      // batch to leave first — the rule a return follows (§5).
      const heldAfter = new Map<string, Prisma.Decimal>();
      const backByRow = new Map<string, ReturnLine[]>();
      let toGiveBack = w.quantity.lt(held) ? held.sub(w.quantity) : D(0);
      for (const row of [...rows].reverse()) {
        const rowHeld = heldUnits(row);
        const take = Prisma.Decimal.min(toGiveBack, rowHeld);
        heldAfter.set(row.id, rowHeld.sub(take));
        if (take.lte(0)) continue;
        const traced = traceBack(row, take, heldUnitPrice(row));
        if (traced.untraced.gt(0)) {
          throw badRequest(
            'RETURN_UNTRACEABLE',
            `Could not trace ${traced.untraced.toFixed(3)} of ${product.name} back to the batches it was sold from.`,
            { qty: traced.untraced.toFixed(3), product: product.name },
          );
        }
        givenBack.push(...traced.lines);
        backByRow.set(row.id, traced.lines);
        toGiveBack = toGiveBack.sub(take);
      }

      // A price changed: on every line's units still held after that.
      if (w.unitPrice !== undefined) {
        for (const row of rows) {
          const qty = heldAfter.get(row.id) ?? D(0);
          if (qty.lte(0)) continue;
          const previousUnitPrice = heldUnitPrice(row);
          if (money(previousUnitPrice).eq(w.unitPrice)) continue;
          const step = previousUnitPrice.sub(w.unitPrice);
          const amount = money(step.mul(qty));
          const afterBack = {
            ...row,
            returnItems: [
              ...row.returnItems,
              ...(backByRow.get(row.id) ?? []).map((b) => ({
                qty: b.qty,
                inventoryBatchId: b.batchId,
              })),
            ],
          };
          priceChanges.push({
            item: row,
            previousUnitPrice,
            newUnitPrice: w.unitPrice,
            qty,
            amount,
            shares: batchShares(afterBack, step, amount),
          });
        }
      }

      // Units added: drawn FIFO on the edit's day, at the price after the edit.
      let added = D(0);
      if (w.quantity.gt(held)) {
        added = w.quantity.sub(held);
        const unitPrice = w.unitPrice ?? priceBefore ?? D(0);
        const batches = await fifoBatches(db, w.productId, cutoff);
        const available = batches.reduce((s, b) => s.add(b.saleableQty), D(0));
        if (available.lt(added)) {
          throw notEnoughStock(
            product.name,
            available,
            added,
            editedOn,
            cutoff,
          );
        }
        let left = added;
        let cost = D(0);
        const used: string[] = [];
        for (const b of batches) {
          if (left.lte(0)) break;
          const take = Prisma.Decimal.min(left, D(b.saleableQty));
          cost = cost.add(money(take.mul(b.landedUnitCostEgp)));
          used.push(b.id);
          left = left.sub(take);
        }
        const cycles = await db.inventoryBatch.findMany({
          where: { id: { in: used } },
          select: ALLOCATION_CYCLE_SELECT,
        });
        const closed = settledCycleOf(
          cycles.map((c) => ({ inventoryBatch: c })),
        );
        if (closed) {
          throw badRequest(
            'EDIT_ORDER_CYCLE_SETTLED',
            `The units would come from cycle ${closed}, which is being settled or is settled; the order can no longer change.`,
            { order: order.orderNo, cycle: closed },
          );
        }
        const lineTotal = money(unitPrice.mul(added));
        if (lineTotal.gt(MAX_UNIT_PRICE)) {
          throw badRequest(
            'EDIT_ORDER_BAD_PRICE',
            `${product.name}: ${added.toString()} at ${unitPrice.toFixed(2)} is more than a line can hold.`,
            { product: product.name, value: unitPrice.toFixed(2) },
          );
        }
        additions.push({
          productId: w.productId,
          product: product.name,
          qty: added,
          unitPrice,
          lineTotal,
          costPreview: cost,
        });
      }

      const back = held.gt(w.quantity) ? held.sub(w.quantity) : D(0);
      const priceAfter = w.unitPrice ?? priceBefore ?? D(0);
      if (
        added.gt(0) ||
        back.gt(0) ||
        priceChanges.some((p) => p.item.productId === w.productId)
      ) {
        lines.push({
          productId: w.productId,
          product: product.name,
          productAr: product.nameAr,
          qtyBefore: held.toString(),
          qtyAfter: w.quantity.toString(),
          priceBefore: priceBefore?.toFixed(2) ?? null,
          priceAfter: priceAfter.toFixed(2),
          added: added.toString(),
          givenBack: back.toString(),
        });
      }
    }

    if (lines.length === 0) {
      throw badRequest(
        'EDIT_ORDER_NO_CHANGES',
        `Nothing on ${order.orderNo} would change.`,
      );
    }

    // An order is never edited down to nothing: that is the whole sale
    // undone — a return or a cancellation, which say so.
    const heldAfterAll = order.items
      .reduce((s, i) => {
        const w = wanted.find((x) => x.productId === i.productId);
        return w ? s : s.add(heldUnits(i));
      }, D(0))
      .add(wanted.reduce((s, w) => s.add(w.quantity), D(0)));
    if (heldAfterAll.lte(0)) {
      throw badRequest(
        'EDIT_ORDER_EMPTY',
        `That would leave nothing on ${order.orderNo}. To undo the whole sale, record a return or cancel it.`,
        { order: order.orderNo },
      );
    }

    const addedEgp = additions.reduce((s, a) => s.add(a.lineTotal), D(0));
    const { refundEgp: givenBackEgp, cogsReversedEgp } =
      returnFigures(givenBack);
    // Signed as owed: a raise owes more, a cut owes less.
    const priceChangeEgp = priceChanges
      .reduce((s, p) => s.add(p.amount), D(0))
      .neg();
    const change = addedEgp.sub(givenBackEgp).add(priceChangeEgp);
    const owedBefore = money(D(order.outstanding));
    const owedAfter = money(owedBefore.add(change));

    // GUESS (§4, 2026-10-25): never below what was paid. Owing less than
    // nothing would be money the business holds for the shop — a refund
    // or a credit nobody agreed to. Money back is a return with a refund.
    if (owedAfter.lt(0)) {
      throw badRequest(
        'EDIT_ORDER_BELOW_PAID',
        `This edit takes ${change.neg().toFixed(2)} off ${order.orderNo}, which owes only ${owedBefore.toFixed(2)} — it would go below what was paid. To pay money back, record a return with a refund.`,
        {
          order: order.orderNo,
          amount: change.neg().toFixed(2),
          owed: owedBefore.toFixed(2),
        },
      );
    }

    // Paid something before: paid up at zero, partly paid above it. Never
    // paid anything: still just confirmed (as a price cut leaves it).
    const statusAfter =
      order.status === 'CONFIRMED'
        ? ('CONFIRMED' as const)
        : owedAfter.lte(0)
          ? ('PAID' as const)
          : ('PARTIALLY_PAID' as const);

    const costAdded = additions.reduce((s, a) => s.add(a.costPreview), D(0));
    const cogsChange = costAdded.sub(cogsReversedEgp);

    return {
      order,
      editedOn,
      reason,
      lines,
      givenBack,
      priceChanges,
      additions,
      addedEgp,
      givenBackEgp,
      priceChangeEgp,
      change,
      owedBefore,
      owedAfter,
      statusAfter,
      cogsChange,
    };
  }
}

/** The lines asked for, each checked; refusals name the product's id. */
function parseLines(raw: unknown) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest(
      'EDIT_ORDER_NO_CHANGES',
      'An edit needs at least one line to change.',
    );
  }
  if (raw.length > MAX_LINES) {
    throw badRequest(
      'VALIDATION_FAILED',
      `At most ${MAX_LINES} lines can be edited at once.`,
      { fields: 'lines' },
    );
  }
  const seen = new Set<string>();
  return (raw as OrderEditLineInput[]).map((line) => {
    const productId = line?.productId;
    if (productId === undefined || productId === null || productId === '') {
      throw badRequest('ITEM_NEEDS_PRODUCT', 'Each item must have a productId');
    }
    if (!isUuid(productId)) throw notFound('product');
    // One line per product (GUESS §4, 2026-10-25): the same product twice in
    // one edit is two answers to "how many".
    if (seen.has(productId)) {
      throw badRequest(
        'EDIT_ORDER_DUPLICATE_PRODUCT',
        'The same product is listed twice in this edit; give it one line with the quantity it should have.',
        { productId },
      );
    }
    seen.add(productId);

    const quantity = decimalOf(line.quantity);
    if (!quantity || quantity.lt(0) || quantity.decimalPlaces() > 3) {
      throw badRequest(
        'EDIT_ORDER_BAD_QUANTITY',
        `The quantity must be a number, zero or more, to at most three decimals (given ${shown(line.quantity)}).`,
        { value: shown(line.quantity) },
      );
    }

    let unitPrice: Prisma.Decimal | undefined;
    if (
      line.unitPrice !== undefined &&
      line.unitPrice !== null &&
      line.unitPrice !== ''
    ) {
      const price = decimalOf(line.unitPrice);
      if (
        !price ||
        price.lt(0) ||
        price.gt(MAX_UNIT_PRICE) ||
        price.decimalPlaces() > 2
      ) {
        throw badRequest(
          'EDIT_ORDER_BAD_PRICE',
          `The price must be a number from 0 to ${MAX_UNIT_PRICE.toFixed(2)}, to at most two decimals (given ${shown(line.unitPrice)}).`,
          { value: shown(line.unitPrice) },
        );
      }
      unitPrice = price;
    }
    return { productId, quantity, unitPrice };
  });
}

/** What was sent, as text for a refusal to name. */
function shown(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v) ?? 'undefined';
}

/** A number sent as a number or a numeric string, or null. */
function decimalOf(v: unknown): Prisma.Decimal | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? D(v) : null;
  }
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) {
    return D(v.trim());
  }
  return null;
}

type Plan = Awaited<ReturnType<OrderEditsService['plan']>>;

function summary(plan: Plan) {
  const stock = (rows: { product: string; qty: Prisma.Decimal }[]) => {
    const merged = new Map<string, Prisma.Decimal>();
    for (const r of rows) {
      merged.set(r.product, (merged.get(r.product) ?? D(0)).add(r.qty));
    }
    return [...merged].map(([product, qty]) => ({
      product,
      qty: qty.toString(),
    }));
  };
  const nameOfItem = (id: string) =>
    plan.order.items.find((i) => i.id === id)?.product.name ?? '';
  return {
    saleOrderId: plan.order.id,
    orderNo: plan.order.orderNo,
    version: plan.order.version,
    editedOn: plan.editedOn,
    lines: plan.lines,
    stockTaken: stock(
      plan.additions.map((a) => ({ product: a.product, qty: a.qty })),
    ),
    stockBack: stock(
      plan.givenBack.map((g) => ({
        product: nameOfItem(g.saleItemId),
        qty: g.qty,
      })),
    ),
    addedEgp: plan.addedEgp.toFixed(2),
    givenBackEgp: plan.givenBackEgp.toFixed(2),
    priceChangeEgp: plan.priceChangeEgp.toFixed(2),
    changeEgp: plan.change.toFixed(2),
    owedBefore: plan.owedBefore.toFixed(2),
    owedAfter: plan.owedAfter.toFixed(2),
    statusAfter: plan.statusAfter,
    cogsChangeEgp: money(plan.cogsChange).toFixed(2),
    profitChangeEgp: money(plan.change.sub(plan.cogsChange)).toFixed(2),
  };
}
