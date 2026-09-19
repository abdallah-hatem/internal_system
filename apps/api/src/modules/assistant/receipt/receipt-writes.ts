import type { Prisma } from '@prisma/client';

import { badRequest, notFound } from '../../../common/api-error';
import { formatMoney, formatQty } from '../../../common/money';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuditService } from '../../audit/audit.service';
import type { ProductsService } from '../../products/products.service';
import {
  type CheckedOrder,
  type PurchaseLine,
  type PurchasesService,
  purchaseLineTotal,
  purchaseOrderTotals,
} from '../../purchases/purchases.service';
import type { SuppliersService } from '../../suppliers/suppliers.service';
import type { ToolOutcome } from '../tool-kit';
import { nameKey, skuKey } from './name-matching';

/**
 * The receipt tools' writes: a purchase order with any new supplier and new
 * products, a supplier on its own, a product on its own.
 *
 * Nothing here decides a rule. Every refusal is the owning service's — the
 * same one the office app gets — and this only puts the services' steps into
 * one transaction, so a receipt either becomes everything it describes or
 * nothing at all.
 *
 * A preview runs the very same steps in a transaction and rolls it back. That
 * is how "validates exactly as the write would" is kept true without a second,
 * write-free copy of every check: there is only one copy, and the preview runs
 * it. Nothing a rolled-back transaction wrote survives it, audit entries
 * included; notifications are only ever sent after a real commit.
 */

type Db = Prisma.TransactionClient;

export interface ReceiptServices {
  prisma: PrismaService;
  purchases: PurchasesService;
  suppliers: SuppliersService;
  products: ProductsService;
  audit: AuditService;
}

export interface NewSupplierInput {
  name: string;
  country: string;
  notes?: string;
}

export interface NewProductInput {
  name: string;
  /** The code printed on the receipt, kept as the product's SKU. */
  sku?: string;
  categoryId?: string;
  description?: string;
}

export type SupplierChoice = { id: string } | { new: NewSupplierInput };
export type ProductChoice = { id: string } | { new: NewProductInput };

export interface OrderLineInput {
  product: ProductChoice;
  quantity: number;
  unitPrice: number;
  /** Percent off this line, 0–100. */
  discountPercent?: number;
}

export interface PurchaseOrderInput {
  /** The cycle a new order goes on. */
  cycleId?: string;
  /** A DRAFT order to add these lines to, instead of a new order. */
  addToOrderId?: string;
  supplier: SupplierChoice;
  currency: string;
  fxRateToEgp?: number;
  /** yyyy-mm-dd. A new order's date; a draft keeps its own. */
  orderedOn?: string;
  supplierInvoiceRef?: string;
  lines: OrderLineInput[];
}

/** Thrown to roll a preview's transaction back, carrying what it built. */
class PreviewRollback<T> {
  constructor(readonly outcome: T) {}
}

/**
 * Runs `work` in a transaction. A preview rolls it back and returns what it
 * would have made; a commit keeps it.
 */
async function inTransaction<T>(
  prisma: PrismaService,
  mode: 'preview' | 'commit',
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const outcome = await work(tx);
        if (mode === 'preview') {
          // Not an error: the only way to end an interactive transaction
          // without committing it is to throw out of it.
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- a rollback signal, caught just below
          throw new PreviewRollback(outcome);
        }
        return outcome;
      },
      { timeout: 20_000 },
    );
  } catch (err) {
    if (err instanceof PreviewRollback) return err.outcome as T;
    throw err;
  }
}

// ── Purchase order ────────────────────────────────────────────────────────

interface LineDone {
  line: number;
  productId: string;
  product: string;
  sku: string;
  newProduct: boolean;
  /** False when a new product's SKU is generated, so a preview's is not final. */
  skuPrinted: boolean;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  lineTotal: string;
}

interface OrderDone {
  mode: 'new' | 'add';
  orderId: string;
  reference: string;
  cycle: { id: string; code: string };
  supplier: { id: string; name: string; country: string; created: boolean };
  currency: string;
  fxRateToEgp: string;
  orderedOn: string;
  supplierInvoiceRef: string | null;
  lines: LineDone[];
  linesTotal: string;
  linesTotalEgp: string;
  orderTotal: string;
  orderTotalEgp: string;
  /** Present when a new order was made: who to tell once it has committed. */
  announce?: CheckedOrder;
}

/**
 * A receipt's lines may name the same new product twice — a misread, or one
 * part listed at two prices. Creating it twice would leave two products that
 * every later receipt matches equally, so it is refused before anything runs.
 */
function assertNewProductsDistinct(lines: OrderLineInput[]) {
  const seen = new Map<string, string>();
  for (const line of lines) {
    if (!('new' in line.product)) continue;
    const { name, sku } = line.product.new;
    const keys = [`name:${nameKey(name)}`];
    if (sku && skuKey(sku)) keys.push(`sku:${skuKey(sku)}`);
    for (const key of keys) {
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        throw badRequest(
          'NEW_PRODUCT_REPEATED',
          `${name} is listed as a new product more than once (also as ${earlier}). Create it once with create_product, then use its id on each line.`,
          { product: name },
        );
      }
      seen.set(key, name);
    }
  }
}

function assertOneTarget(input: PurchaseOrderInput) {
  if (Boolean(input.cycleId) === Boolean(input.addToOrderId)) {
    throw badRequest(
      'VALIDATION_FAILED',
      'Give cycleId for a new purchase order, or addToOrderId to add to a draft one — exactly one of the two.',
      { fields: 'cycleId, addToOrderId' },
    );
  }
  if (input.cycleId) {
    const missing = [
      input.fxRateToEgp === undefined ? 'fxRateToEgp' : null,
      input.orderedOn === undefined ? 'orderedOn' : null,
    ].filter(Boolean);
    if (missing.length) {
      throw badRequest(
        'VALIDATION_FAILED',
        `A new purchase order needs ${missing.join(' and ')}.`,
        { fields: missing.join(', ') },
      );
    }
  } else if (input.orderedOn !== undefined) {
    throw badRequest(
      'VALIDATION_FAILED',
      'A draft keeps the date it was ordered on; leave orderedOn out when adding to it.',
      { fields: 'orderedOn' },
    );
  }
}

async function resolveSupplier(
  s: ReceiptServices,
  tx: Db,
  choice: SupplierChoice,
  actorId: string,
): Promise<OrderDone['supplier']> {
  if ('new' in choice) {
    await s.suppliers.assertNameFree(choice.new.name, tx);
    const { data } = await s.suppliers.create(
      {
        name: choice.new.name,
        country: choice.new.country,
        notes: choice.new.notes,
      },
      actorId,
      tx,
    );
    return {
      id: data.id,
      name: data.name,
      country: data.country,
      created: true,
    };
  }
  const found = await tx.supplier.findUnique({
    where: { id: choice.id },
    select: { id: true, name: true, country: true },
  });
  if (!found) throw notFound('supplier');
  return { ...found, created: false };
}

async function resolveProduct(
  s: ReceiptServices,
  tx: Db,
  choice: ProductChoice,
  actorId: string,
): Promise<{ id: string; name: string; sku: string; created: boolean }> {
  if ('new' in choice) {
    const { data } = await s.products.create(
      {
        name: choice.new.name,
        categoryId: choice.new.categoryId,
        description: choice.new.description,
      },
      actorId,
      { sku: choice.new.sku, db: tx },
    );
    return { id: data.id, name: data.name, sku: data.sku, created: true };
  }
  const found = await tx.product.findUnique({
    where: { id: choice.id },
    select: { id: true, name: true, sku: true },
  });
  if (!found) throw notFound('product');
  return { ...found, created: false };
}

async function writePurchaseOrder(
  s: ReceiptServices,
  tx: Db,
  input: PurchaseOrderInput,
  actorId: string,
  seen: { supplier?: { id: string; name: string } },
): Promise<OrderDone> {
  assertOneTarget(input);
  assertNewProductsDistinct(input.lines);

  const supplier = await resolveSupplier(s, tx, input.supplier, actorId);
  seen.supplier = supplier;

  const products: Awaited<ReturnType<typeof resolveProduct>>[] = [];
  for (const line of input.lines) {
    products.push(await resolveProduct(s, tx, line.product, actorId));
  }
  const lines: PurchaseLine[] = input.lines.map((line, i) => ({
    productId: products[i].id,
    orderedQty: line.quantity,
    unitPrice: line.unitPrice,
    discount: line.discountPercent ?? 0,
  }));

  let order: {
    id: string;
    reference: string;
    currency: string;
    fxRateToEgp: Prisma.Decimal | number | string;
    orderedOn: Date;
    supplierInvoiceRef: string | null;
  };
  let cycle: { id: string; code: string };
  let announce: CheckedOrder | undefined;

  if (input.cycleId) {
    const dto = {
      supplierId: supplier.id,
      currency: input.currency,
      fxRateToEgp: input.fxRateToEgp!,
      orderedOn: input.orderedOn!,
      supplierInvoiceRef: input.supplierInvoiceRef,
      items: lines,
    };
    const checked = await s.purchases.validateOrder(tx, input.cycleId, dto);
    order = await s.purchases.writeOrder(tx, checked, dto, actorId);
    cycle = checked.cycle;
    announce = checked;
  } else {
    const target = await appendTarget(s, tx, input, supplier);
    for (const line of lines) {
      await s.purchases.addItem(target.draft.id, line, actorId, tx);
    }
    order = await takeInvoiceRef(s, tx, target, actorId);
    cycle = target.draft.cycle;
  }

  const all = await tx.purchaseOrderItem.findMany({
    where: { purchaseOrderId: order.id },
    select: { lineTotal: true },
  });
  const rate = Number(order.fxRateToEgp);
  const added = purchaseOrderTotals(
    lines.map((l) => purchaseLineTotal(l)),
    rate,
  );
  const whole = purchaseOrderTotals(
    all.map((i) => i.lineTotal),
    rate,
  );

  return {
    mode: input.cycleId ? 'new' : 'add',
    orderId: order.id,
    reference: order.reference,
    cycle: { id: cycle.id, code: cycle.code },
    supplier,
    currency: order.currency,
    fxRateToEgp: String(order.fxRateToEgp),
    orderedOn: order.orderedOn.toISOString().slice(0, 10),
    supplierInvoiceRef: order.supplierInvoiceRef,
    lines: lines.map((l, i) => ({
      line: i + 1,
      productId: products[i].id,
      product: products[i].name,
      sku: products[i].sku,
      newProduct: products[i].created,
      skuPrinted:
        !products[i].created ||
        Boolean(
          'new' in input.lines[i].product &&
          input.lines[i].product.new.sku?.trim(),
        ),
      quantity: l.orderedQty,
      unitPrice: l.unitPrice,
      discountPercent: l.discount ?? 0,
      lineTotal: purchaseLineTotal(l).toFixed(2),
    })),
    linesTotal: added.total,
    linesTotalEgp: added.totalEgp,
    orderTotal: whole.total,
    orderTotalEgp: whole.totalEgp,
    announce,
  };
}

/**
 * The draft a receipt's lines are being added to, once it is known to be
 * this supplier's, in this currency at this rate, and free to carry this
 * receipt's invoice number.
 *
 * An order has one supplier, one currency and one rate; lines from another
 * would be costed wrongly without anything looking wrong. And the invoice
 * number is what stops one receipt becoming stock twice (§15) — so a draft
 * without one takes it, and a draft already carrying another refuses rather
 * than quietly dropping this one's.
 */
async function appendTarget(
  s: ReceiptServices,
  tx: Db,
  input: PurchaseOrderInput,
  supplier: { id: string; name: string },
) {
  const draft = await tx.purchaseOrder.findUnique({
    where: { id: input.addToOrderId! },
    include: {
      cycle: { select: { id: true, code: true, status: true } },
      supplier: { select: { name: true } },
    },
  });
  if (!draft) throw notFound('purchaseOrder');

  if (draft.supplierId !== supplier.id) {
    throw badRequest(
      'PO_SUPPLIER_MISMATCH',
      `Purchase order ${draft.reference} is from ${draft.supplier.name}; these lines are from ${supplier.name}.`,
      {
        reference: draft.reference,
        supplier: draft.supplier.name,
        given: supplier.name,
      },
    );
  }

  const currency = input.currency.trim().toUpperCase();
  const sameRate =
    input.fxRateToEgp === undefined ||
    Number(draft.fxRateToEgp) === input.fxRateToEgp;
  if (draft.currency.trim().toUpperCase() !== currency || !sameRate) {
    throw badRequest(
      'PO_TERMS_MISMATCH',
      `Purchase order ${draft.reference} is in ${draft.currency} at ${String(draft.fxRateToEgp)} EGP. Lines can be added only in that currency at that rate — otherwise record a separate order.`,
      {
        reference: draft.reference,
        currency: draft.currency,
        rate: String(draft.fxRateToEgp),
      },
    );
  }

  const ref = await s.purchases.assertInvoiceNotRecorded(
    tx,
    supplier,
    input.supplierInvoiceRef,
  );
  if (ref && draft.supplierInvoiceRef) {
    throw badRequest(
      'PO_HAS_OTHER_INVOICE',
      `Purchase order ${draft.reference} already records invoice ${draft.supplierInvoiceRef}. Record invoice ${ref} as a separate order.`,
      {
        reference: draft.reference,
        invoice: draft.supplierInvoiceRef,
        ref,
      },
    );
  }
  return { draft, ref };
}

/** The draft takes the receipt's invoice number, once its lines are in. */
async function takeInvoiceRef(
  s: ReceiptServices,
  tx: Db,
  target: Awaited<ReturnType<typeof appendTarget>>,
  actorId: string,
) {
  const { draft, ref } = target;
  if (!ref) return draft;
  const { cycle: _cycle, supplier: _supplier, ...before } = draft;
  const after = await tx.purchaseOrder.update({
    where: { id: draft.id },
    data: { supplierInvoiceRef: ref },
  });
  await s.audit.log(
    {
      actorUserId: actorId,
      action: 'UPDATE',
      entityType: 'PurchaseOrder',
      entityId: draft.id,
      beforeJson: before,
      afterJson: after,
    },
    tx,
  );
  return after;
}

function describeOrder(done: OrderDone, committed: boolean): string {
  const head = committed
    ? done.mode === 'new'
      ? `Created purchase order ${done.reference}`
      : `Added ${done.lines.length} line(s) to purchase order ${done.reference}`
    : done.mode === 'new'
      ? 'A new purchase order'
      : `${done.lines.length} line(s) to add to draft purchase order ${done.reference}`;
  const supplier = done.supplier.created
    ? `${done.supplier.name} (${committed ? 'new supplier, created' : 'NEW supplier'}, ${done.supplier.country})`
    : done.supplier.name;
  const parts = [
    `${head} on cycle ${done.cycle.code}, from ${supplier}.`,
    `Invoice: ${done.supplierInvoiceRef ?? 'none'} · ordered ${done.orderedOn} · ${done.currency} at ${done.fxRateToEgp} EGP.`,
    'Lines:',
    ...done.lines.map(
      (l) =>
        `${l.line}. ${l.product}${l.newProduct ? ` (${committed ? 'new product' : 'NEW product'}, SKU ${l.skuPrinted || committed ? l.sku : 'generated when saved'})` : ''} — ` +
        `${formatQty(l.quantity)} × ${formatMoney(l.unitPrice)}` +
        (l.discountPercent ? ` less ${l.discountPercent}%` : '') +
        ` = ${formatMoney(l.lineTotal)} ${done.currency}`,
    ),
    done.mode === 'new'
      ? `Total: ${formatMoney(done.orderTotal)} ${done.currency} = ${formatMoney(done.orderTotalEgp)} EGP.`
      : `These lines: ${formatMoney(done.linesTotal)} ${done.currency} = ${formatMoney(done.linesTotalEgp)} EGP. ` +
        `Order total after: ${formatMoney(done.orderTotal)} ${done.currency} = ${formatMoney(done.orderTotalEgp)} EGP.`,
  ];
  return parts.join('\n');
}

/** What the partner is shown. A preview's ids belong to rows rolled back. */
function orderData(done: OrderDone, committed: boolean) {
  const { announce: _announce, ...rest } = done;
  if (committed) return rest;
  return {
    ...rest,
    orderId: done.mode === 'add' ? done.orderId : null,
    reference: done.mode === 'add' ? done.reference : null,
    supplier: {
      ...done.supplier,
      id: done.supplier.created ? null : done.supplier.id,
    },
    lines: done.lines.map((l) => ({
      ...l,
      productId: l.newProduct ? null : l.productId,
      // A generated SKU is only settled when the product really is created.
      sku: l.skuPrinted ? l.sku : null,
    })),
  };
}

export async function purchaseOrderWrite(
  s: ReceiptServices,
  input: PurchaseOrderInput,
  actorId: string,
  mode: 'preview' | 'commit',
): Promise<ToolOutcome> {
  const seen: { supplier?: { id: string; name: string } } = {};
  const done = await inTransaction(s.prisma, mode, (tx) =>
    writePurchaseOrder(s, tx, input, actorId, seen),
  ).catch((err: unknown) => {
    // Two sends of one receipt can both pass the invoice check; the index
    // stops the second, and the service names it as the same refusal.
    if (seen.supplier && mode === 'commit') {
      return s.purchases.explainDuplicateInvoice(err, seen.supplier, input);
    }
    throw err;
  });

  const committed = mode === 'commit';
  if (committed && done.announce) {
    await s.purchases.announceCreated(
      { id: done.orderId, reference: done.reference },
      done.announce,
    );
  }
  return {
    summary: describeOrder(done, committed),
    data: orderData(done, committed),
  };
}

// ── Supplier and product on their own ─────────────────────────────────────

export async function supplierWrite(
  s: ReceiptServices,
  input: NewSupplierInput,
  actorId: string,
  mode: 'preview' | 'commit',
): Promise<ToolOutcome> {
  const created = await inTransaction(s.prisma, mode, async (tx) => {
    await s.suppliers.assertNameFree(input.name, tx);
    return (await s.suppliers.create(input, actorId, tx)).data;
  });
  const what = `${created.name} (${created.country})`;
  return mode === 'commit'
    ? {
        summary: `Created supplier ${what}.`,
        data: { id: created.id, name: created.name, country: created.country },
      }
    : {
        summary: `A new supplier: ${what}.`,
        data: { id: null, name: created.name, country: created.country },
      };
}

export async function productWrite(
  s: ReceiptServices,
  input: NewProductInput,
  actorId: string,
  mode: 'preview' | 'commit',
): Promise<ToolOutcome> {
  const created = await inTransaction(s.prisma, mode, async (tx) => {
    const { data } = await s.products.create(
      {
        name: input.name,
        categoryId: input.categoryId,
        description: input.description,
      },
      actorId,
      { sku: input.sku, db: tx },
    );
    return data;
  });
  if (mode === 'commit') {
    return {
      summary: `Created product ${created.name}, SKU ${created.sku}.`,
      data: { id: created.id, name: created.name, sku: created.sku },
    };
  }
  const sku = input.sku?.trim() || null;
  return {
    summary: `A new product: ${created.name}, SKU ${sku ?? 'generated when saved'}.`,
    data: { id: null, name: created.name, sku },
  };
}
