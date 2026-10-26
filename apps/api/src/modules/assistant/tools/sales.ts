import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { badRequest, conflict } from '../../../common/api-error';
import { SELLABLE } from '../../../common/product-status';
import { availableByProduct } from '../../../common/available-stock';
import { chosenDay, businessToday } from '../../../common/dates';
import { formatMoney, formatQty } from '../../../common/money';
import { PAYMENT_METHODS } from '../../../common/walk-in';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PaymentsService } from '../../payments/payments.service';
import { type PriceChannel } from '../../portal/portal-pricing';
import {
  DEFAULT_MARKUP_PCT,
  listPricesFor,
  type ListPrices,
} from '../../../common/default-price';
import {
  type CreateSaleOrderInput,
  receivedCutoff,
  SalesService,
} from '../../sales/sales.service';
import { previewByRollback, rollingBack } from '../dry-run';
import { matchByName, type NameMatch } from '../receipt/name-matching';
import { writeTool, type AssistantContext } from '../tool-kit';

/**
 * record_sale (BUSINESS_LOGIC §16, DECIDED 2026-10-11 "the assistant can
 * record a sale"; spec 2026-10-11-walk-in-and-assistant-sales).
 *
 * "I sold 25 of X at Y to Z." The product and the customer are found with the
 * one matcher (`receipt/name-matching.ts`): only an id, an exact SKU or an
 * exact name is taken. Anything close comes back as a question with its
 * candidates and no confirmation token, so nothing can be written on a guess.
 * An unknown customer is a question too — the assistant never makes one.
 *
 * Every rule of a sale stays in `SalesService`. The preview is that service's
 * own create-and-confirm (or walk-in) run against a database that rolls back
 * (`dry-run.ts`), so a refusal the office app would get — not enough stock, a
 * discount larger than its line, an unverified customer — is the preview's
 * refusal too. The commit is the same call, for real.
 *
 * What the preview showed binds: each line's product, quantity, price,
 * discount and total, the stock it was shown against, the order total and the
 * customer. A price changed or stock sold elsewhere in between is
 * PREVIEW_CHANGED (or NOT_ENOUGH_STOCK, when there is no longer enough).
 */

const CURRENCY = 'EGP';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LIST_PRICE_NOTE = 'list price — confirm or give the price';
/** No price was set, so it is landed cost + the markup (§3, 2026-10-18). */
const DEFAULT_PRICE_NOTE = `default price (landed cost + ${DEFAULT_MARKUP_PCT}%), no price is set — confirm or give the price`;

const saleShape = {
  customer: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'The customer (a shop) by name or id. Leave out for a walk-in sale. Never a new customer — they are added in the office app.',
    ),
  branch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "The customer's branch by name — ONLY when the partner names one. Left out, the sale goes on the customer's default branch (or on the customer when no default is set). Not for a walk-in sale.",
    ),
  walkIn: z
    .boolean()
    .optional()
    .describe(
      'true for a buyer who is not a shop ("to anyone", "a walk-in"): sold at retail (B2C) prices and paid in full on the spot.',
    ),
  lines: z
    .array(
      z.object({
        product: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('The product by name, SKU or id.'),
        qty: z.number().describe('How many were sold. More than zero.'),
        unitPrice: z
          .number()
          .optional()
          .describe(
            `Price per unit in EGP, as the partner said it. Leave out ONLY when they gave no price: the preview then offers the list price (the one set, else the default: landed cost + ${DEFAULT_MARKUP_PCT}%) and the partner must confirm it.`,
          ),
        discount: z
          .number()
          .optional()
          .describe(
            'Money off this line in EGP (an amount, not a percent). At most what the line is worth.',
          ),
      }),
    )
    .min(1),
  paymentMethod: z
    .enum(PAYMENT_METHODS)
    .optional()
    .describe(
      'How a walk-in sale was paid; cash when unsaid. Not for a named customer — their sale is owed and paid later in the office app.',
    ),
  orderedOn: z
    .string()
    .trim()
    .regex(DAY, 'YYYY-MM-DD')
    .optional()
    .describe(
      'The day the sale was made, YYYY-MM-DD — ONLY when the partner says it was on an earlier day ("I sold … last Tuesday"). Leave out otherwise: it is then today (Cairo). Never a day that has not come yet. A sale on an earlier day can only use stock that had been received by that day.',
    ),
};

type SaleInput = {
  customer?: string;
  branch?: string;
  walkIn?: boolean;
  lines: {
    product: string;
    qty: number;
    unitPrice?: number;
    discount?: number;
  }[];
  paymentMethod?: (typeof PAYMENT_METHODS)[number];
  orderedOn?: string;
};

export interface CatalogueProduct {
  id: string;
  name: string;
  /** Matched as well as the English name (§3, 2026-10-14). */
  nameAr: string | null;
  sku: string;
  /** Each channel's price, set or default — common/default-price.ts. */
  listPrices: ListPrices;
}

export interface CatalogueCustomer {
  id: string;
  name: string;
  type: string;
  /** Its open branches (§7, 2026-10-25); archived ones take no sale. */
  branches?: { id: string; name: string }[];
}

export interface SaleQuestion {
  id: string;
  kind:
    | 'CUSTOMER_WHICH'
    | 'CUSTOMER_UNKNOWN'
    | 'BRANCH_WHICH'
    | 'LINE_WHICH'
    | 'LINE_UNKNOWN'
    | 'PRICE_NEEDED';
  /** 1-based line, for a per-line question. */
  line?: number;
  text: string;
  options: { value: string; label: string; score?: number }[];
}

interface PlannedLine {
  line: number;
  productId: string;
  product: string;
  /** The Arabic name, null when there is none. */
  productAr: string | null;
  sku: string;
  qty: number;
  unitPrice: number;
  priceSource: 'given' | 'list' | 'default';
  discount: number;
}

type Plan =
  | { status: 'questions'; questions: SaleQuestion[] }
  | {
      status: 'ready';
      walkIn: boolean;
      customer: { id: string; name: string } | null;
      /** The branch named; null leaves it to the default (§7). */
      branch: { id: string; name: string } | null;
      channel: PriceChannel;
      lines: PlannedLine[];
      body: CreateSaleOrderInput;
    };

/**
 * Reads the input against what is on file and settles what can be settled.
 * Pure: the catalogue is handed in.
 */
export function resolveSale(
  input: SaleInput,
  catalogue: { products: CatalogueProduct[]; customers: CatalogueCustomer[] },
): Plan {
  const walkIn = input.walkIn === true;
  if (walkIn && input.customer) {
    throw badRequest(
      'VALIDATION_FAILED',
      'A walk-in sale has no customer; send walkIn or customer, not both.',
      { fields: 'customer' },
    );
  }
  if (walkIn && input.branch) {
    throw badRequest(
      'VALIDATION_FAILED',
      'A walk-in sale has no customer, so it has no branch.',
      { fields: 'branch' },
    );
  }
  if (!walkIn && !input.customer) {
    throw badRequest(
      'VALIDATION_FAILED',
      'Name the customer, or set walkIn for a buyer who is not a shop.',
      { fields: 'customer' },
    );
  }

  const questions: SaleQuestion[] = [];

  let customer: CatalogueCustomer | null = null;
  if (!walkIn) {
    const named = input.customer!;
    const found = matchByName(
      { id: named, name: named },
      catalogue.customers,
      'customer',
    );
    if (found.status === 'matched') {
      customer = found.match.item;
    } else if (found.status === 'unknown') {
      questions.push({
        id: 'CUSTOMER_UNKNOWN',
        kind: 'CUSTOMER_UNKNOWN',
        text: `"${named}" is not a customer on file. Is it a customer under another name, or a walk-in sale? New customers are added in the office app, not here.`,
        options: [{ value: 'walk_in', label: 'A walk-in sale' }],
      });
    } else {
      questions.push({
        id: 'CUSTOMER_WHICH',
        kind: 'CUSTOMER_WHICH',
        text: `"${named}" is not an exact match for a customer on file. Which customer is it?`,
        options: options(found, (c) => c.name),
      });
    }
  }

  // The branch, only when one was named (§7, 2026-10-25). Matched exactly,
  // ignoring case, among the customer's open branches; anything else is a
  // question. Not named, the service puts the sale on the default branch —
  // the same rule the office form and every other path get.
  let branch: { id: string; name: string } | null = null;
  if (customer && input.branch) {
    const named = input.branch.trim().toLowerCase();
    const open = customer.branches ?? [];
    branch =
      open.find(
        (b) => b.id === input.branch || b.name.toLowerCase() === named,
      ) ?? null;
    if (!branch) {
      questions.push({
        id: 'BRANCH_WHICH',
        kind: 'BRANCH_WHICH',
        text: open.length
          ? `"${input.branch}" is not one of ${customer.name}'s branches. Which branch is it?`
          : `${customer.name} has no branches on file; leave the branch out.`,
        options: open.map((b) => ({ value: b.id, label: b.name })),
      });
    }
  }

  const channel: PriceChannel = walkIn
    ? 'B2C'
    : customer?.type === 'B2B'
      ? 'B2B'
      : 'B2C';

  const lines: PlannedLine[] = [];
  input.lines.forEach((l, i) => {
    const line = i + 1;
    const found = matchByName(
      { id: l.product, name: l.product, sku: l.product },
      catalogue.products,
      'product',
    );
    if (found.status !== 'matched') {
      questions.push(
        found.status === 'unknown'
          ? {
              id: `LINE_UNKNOWN:${line}`,
              kind: 'LINE_UNKNOWN',
              line,
              text: `Line ${line} ("${l.product}") matches no product on file. Which product was sold?`,
              options: [],
            }
          : {
              id: `LINE_WHICH:${line}`,
              kind: 'LINE_WHICH',
              line,
              text: `Line ${line} ("${l.product}") is not an exact match for a product on file. Which one was sold?`,
              options: options(
                found,
                (p) =>
                  `${p.name}${p.nameAr ? ` / ${p.nameAr}` : ''} (${p.sku})`,
              ),
            },
      );
      return;
    }
    const product = found.match.item;
    let unitPrice = l.unitPrice;
    let priceSource: PlannedLine['priceSource'] = 'given';
    if (unitPrice === undefined) {
      // Only once the customer is known: the list price depends on who buys.
      if (!walkIn && !customer) return;
      const list = product.listPrices[channel];
      if (!list) {
        questions.push({
          id: `PRICE_NEEDED:${line}`,
          kind: 'PRICE_NEEDED',
          line,
          text: `Line ${line} (${product.name}) has no price, there is no ${channel} list price on file, and it was never received so there is no default. What was it sold for?`,
          options: [],
        });
        return;
      }
      unitPrice = Number(list.amount);
      priceSource = list.source === 'DEFAULT' ? 'default' : 'list';
    }
    lines.push({
      line,
      productId: product.id,
      product: product.name,
      productAr: product.nameAr ?? null,
      sku: product.sku,
      qty: l.qty,
      unitPrice,
      priceSource,
      discount: l.discount ?? 0,
    });
  });

  if (questions.length) return { status: 'questions', questions };

  return {
    status: 'ready',
    walkIn,
    customer: customer ? { id: customer.id, name: customer.name } : null,
    branch,
    channel,
    lines,
    body: {
      ...(walkIn ? { walkIn: true } : { customerId: customer!.id }),
      ...(branch ? { branchId: branch.id } : {}),
      channel,
      currency: CURRENCY,
      confirm: true,
      items: lines.map((l) => ({
        productId: l.productId,
        quantity: l.qty,
        unitPrice: l.unitPrice,
        ...(l.discount ? { discount: l.discount } : {}),
      })),
      // Passed through as given: the service refuses a method on a sale that
      // is not a walk-in, so the assistant is refused what the form would be.
      ...(input.paymentMethod
        ? { payment: { method: input.paymentMethod } }
        : {}),
      // Only when the partner said a day; the service checks it (§4).
      ...(input.orderedOn ? { orderedOn: input.orderedOn } : {}),
    },
  };
}

/** A shop's open samples orders, as `SalesService.samplesAtShop` reads them. */
export type ShopSamples = Awaited<
  ReturnType<SalesService['samplesAtShop']>
>['data'];

/**
 * How the samples note starts. The office chat shows the note as its own
 * translated hint with a link, so it cuts the summary here (chat.service.ts).
 */
export const SAMPLES_AT_SHOP_NOTE = 'Samples at this shop:';

/**
 * The record_sale preview's samples note (§4, owner 2026-10-25): what the
 * shop holds, per samples order, and what to do if those are what it is
 * buying. Never a refusal — a separate purchase is valid.
 */
export function samplesAtShopNote(shop: string, orders: ShopSamples): string {
  return [
    `${SAMPLES_AT_SHOP_NOTE} ${shop} already holds samples —`,
    ...orders.map(
      (o) =>
        `- ${o.orderNo}${o.leftOn ? ` (left ${o.leftOn})` : ''}: ` +
        o.lines
          .map((l) => `${formatQty(l.units)} × ${l.name} (${l.sku})`)
          .join(', '),
    ),
    'If the shop is buying those samples, complete that samples order instead (complete_samples_sale): this sale draws its units from the shelf while the samples still count as out. ' +
      'Tell the partner before they confirm; a separate purchase is fine and this does not stop the sale.',
  ].join('\n');
}

/** A NUMERIC(18,2) as two decimals — a Decimal prints "300", not "300.00". */
export function money2(value: unknown): string {
  return Number(value).toFixed(2);
}

export function options<T extends { id: string }>(
  found: NameMatch<T>,
  label: (item: T) => string,
): SaleQuestion['options'] {
  if (found.status === 'matched' || found.status === 'unknown') return [];
  return found.candidates.map((c) => ({
    value: c.item.id,
    label: label(c.item),
    score: c.score,
  }));
}

/**
 * What a sale is matched against: the products that can be sold and the
 * customers that can be named. Shared with the samples tools (`samples.ts`),
 * so leaving samples matches exactly what a sale would.
 *
 * `alsoProducts` adds products by id whatever their status — the products
 * already out on a samples order, which can be bought back from it even once
 * switched off with an empty shelf.
 */
export async function loadSaleCatalogue(
  prisma: PrismaService,
  alsoProducts: readonly string[] = [],
): Promise<{ products: CatalogueProduct[]; customers: CatalogueCustomer[] }> {
  const [products, customers] = await Promise.all([
    // What can be sold (§3, owner 2026-10-14): a switched-off product is
    // still sold from the shelf, and is not matched once the shelf is empty.
    prisma.product.findMany({
      where: alsoProducts.length
        ? { OR: [SELLABLE, { id: { in: [...alsoProducts] } }] }
        : SELLABLE,
      select: {
        id: true,
        name: true,
        nameAr: true,
        sku: true,
        prices: {
          where: { effectiveTo: null },
          select: { channel: true, amount: true, effectiveTo: true },
        },
      },
      orderBy: { name: 'asc' },
    }),
    // The walk-in record is never a customer you name (§4): a walk-in
    // sale says walkIn.
    prisma.customer.findMany({
      where: { isWalkIn: false },
      select: {
        id: true,
        displayName: true,
        type: true,
        branches: {
          where: { archivedAt: null },
          select: { id: true, name: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { displayName: 'asc' },
    }),
  ]);
  const listPrices = await listPricesFor(prisma, products);
  return {
    products: products.map(({ prices: _prices, ...p }): CatalogueProduct => ({
      ...p,
      listPrices: listPrices.get(p.id)!,
    })),
    customers: customers.map((c) => ({
      id: c.id,
      name: c.displayName,
      type: c.type,
      branches: c.branches,
    })),
  };
}

/** What a dry-run order looked like before it was rolled back. */
interface SeenOrder {
  orderNo: string;
  status: string;
  total: string;
  outstanding: string;
  /** The branch the service put it on — named, or the default (§7). */
  branch: string | null;
  items: { productId: string; lineTotal: string }[];
}

export function registerSalesTools(
  server: McpServer,
  ctx: AssistantContext,
): void {
  const actor = ctx.user.id;
  const prisma = () => ctx.resolve(PrismaService);
  const audit = () => ctx.resolve(AuditService);

  const catalogue = () => loadSaleCatalogue(prisma());

  /** The sale as the sales service would make it, rolled back. */
  async function dryRun(body: CreateSaleOrderInput): Promise<SeenOrder> {
    // A key of its own, so the rolled-back order can be found inside its
    // transaction; it never survives the rollback.
    const key = `assistant-preview:${randomUUID()}`;
    const dry = rollingBack(prisma(), async (tx) => {
      const order = await tx.saleOrder.findUniqueOrThrow({
        where: {
          createdBy_idempotencyKey: { createdBy: actor, idempotencyKey: key },
        },
        select: {
          orderNo: true,
          status: true,
          total: true,
          outstanding: true,
          branch: { select: { name: true } },
          items: { select: { productId: true, lineTotal: true } },
        },
      });
      return {
        orderNo: order.orderNo,
        status: order.status,
        total: money2(order.total),
        outstanding: money2(order.outstanding),
        branch: order.branch?.name ?? null,
        items: order.items.map((it) => ({
          productId: it.productId,
          lineTotal: money2(it.lineTotal),
        })),
      };
    });
    const service = new SalesService(
      dry,
      audit(),
      new PaymentsService(dry, audit()),
      // A preview sells nothing, so it never says stock is low.
      { createForMultipleUsers: () => Promise.resolve({ count: 0 }) },
    );
    return previewByRollback<SeenOrder>(() => service.create(body, actor, key));
  }

  async function preview(input: SaleInput) {
    const plan = resolveSale(input, await catalogue());
    if (plan.status === 'questions') {
      return {
        needsAnswers: true,
        summary: [
          'This sale cannot be previewed yet:',
          ...plan.questions.map(
            (q) =>
              `- ${q.text}${q.options.length ? ` Options: ${q.options.map((o) => o.label).join('; ')}.` : ''}`,
          ),
        ].join('\n'),
        data: { questions: plan.questions },
      };
    }

    // What the shelf held on the sale's day (§4, 2026-10-16): a sale on an
    // earlier day is shown against, and bound to, the stock received by then.
    const orderedOn = chosenDay(plan.body.orderedOn, 'SALE_MADE');
    const available = await availableByProduct(
      prisma(),
      plan.lines.map((l) => l.productId),
      undefined,
      receivedCutoff(orderedOn),
    );
    const seen = await dryRun(plan.body);
    // Below cost (§4, 2026-10-11): the sales service's own price check, the
    // one every office screen reads — each line against the FIFO cost of the
    // units it would draw, after its discount. A warning, never a refusal.
    const { data: cost } = await ctx.resolve(SalesService).priceCheck({
      currency: CURRENCY,
      items: plan.body.items,
      orderedOn,
    });
    const method = input.paymentMethod ?? 'CASH';
    const lines = plan.lines.map((l, i) => ({
      line: l.line,
      productId: l.productId,
      product: l.product,
      productAr: l.productAr,
      sku: l.sku,
      qty: String(l.qty),
      unitPrice: Number(l.unitPrice).toFixed(2),
      priceSource: l.priceSource,
      ...(l.priceSource === 'list' ? { note: LIST_PRICE_NOTE } : {}),
      ...(l.priceSource === 'default' ? { note: DEFAULT_PRICE_NOTE } : {}),
      discount: Number(l.discount).toFixed(2),
      lineTotal: seen.items[i].lineTotal,
      available: available.get(l.productId)?.toString() ?? '0',
      belowCost: cost.lines[i]?.belowCost
        ? {
            unitCostEgp: cost.lines[i].unitCostEgp!,
            unitPriceEgp: cost.lines[i].unitPriceEgp!,
            lossEgp: cost.lines[i].lossEgp!,
          }
        : null,
    }));
    const who = plan.walkIn
      ? 'a walk-in buyer (B2C)'
      : `${plan.customer!.name} (${plan.channel})` +
        (seen.branch ? `, branch ${seen.branch}` : '');
    // What the shop already holds as samples (§4, owner 2026-10-25): the
    // office form's hint, said here too. A hint only — the sale goes ahead.
    const samplesHeld: ShopSamples = plan.customer
      ? (await ctx.resolve(SalesService).samplesAtShop(plan.customer.id)).data
      : [];

    return {
      summary: [
        `Sale to ${who} on ${orderedOn}${orderedOn === businessToday() ? ' (today)' : ''}, created and confirmed in one step:`,
        ...lines.map(
          (l) =>
            `- ${l.product} (${l.sku}): ${formatQty(l.qty)} × ${formatMoney(l.unitPrice)}` +
            (l.priceSource === 'list' ? ` (${LIST_PRICE_NOTE})` : '') +
            (l.priceSource === 'default' ? ` (${DEFAULT_PRICE_NOTE})` : '') +
            (Number(l.discount) ? ` less ${formatMoney(l.discount)}` : '') +
            ` = ${formatMoney(l.lineTotal)} ${CURRENCY}; ${formatQty(l.available)} in stock` +
            (l.belowCost
              ? `\n  Below cost: each costs ${formatMoney(l.belowCost.unitCostEgp)}, selling at ${formatMoney(l.belowCost.unitPriceEgp)}, a loss of ${formatMoney(l.belowCost.lossEgp)} on this line.`
              : ''),
        ),
        `Total: ${formatMoney(seen.total)} ${CURRENCY}.`,
        ...(cost.belowCostLines > 0
          ? [
              `Selling below cost loses ${formatMoney(cost.totalLossEgp)} ${CURRENCY} on this sale. Say so before the partner confirms; it is still theirs to confirm.`,
            ]
          : []),
        plan.walkIn
          ? `Paid on the spot by ${method}; nothing is owed.`
          : `${plan.customer!.name} will owe ${formatMoney(seen.outstanding)} ${CURRENCY}; no payment is recorded.`,
        ...(samplesHeld.length
          ? ['', samplesAtShopNote(plan.customer!.name, samplesHeld)]
          : []),
      ].join('\n'),
      data: {
        walkIn: plan.walkIn,
        customer: plan.customer,
        branch: seen.branch,
        orderedOn,
        channel: plan.channel,
        currency: CURRENCY,
        lines,
        total: seen.total,
        /** What the lines below cost lose together; "0.00" when none is. */
        belowCostLossEgp: cost.totalLossEgp,
        statusAfter: seen.status,
        outstandingAfter: seen.outstanding,
        payment: plan.walkIn ? { method, amount: seen.total } : null,
        /** The shop's open samples orders; empty when it holds none. */
        samplesAtShop: samplesHeld,
      },
    };
  }

  writeTool(
    server,
    ctx,
    'record_sale',
    {
      title: 'Record a sale',
      description:
        'Records a sale the partner made: created and confirmed in one step. Name the customer (a shop on file) — the sale is then owed — or set walkIn for a buyer who is not a shop, which is paid in full on the spot at retail prices. ' +
        'Products and customers are matched by exact name, SKU or id only: a close name comes back as a question with candidates and nothing to confirm. ' +
        `Without a price the preview offers the list price — the one set, else the default (landed cost + ${DEFAULT_MARKUP_PCT}%), said which — which the partner must confirm. ` +
        'A sale made on an earlier day takes orderedOn — only when the partner says the day; it then draws only stock received by that day, and is refused (NOT_ENOUGH_STOCK_ON_DATE) when there was not enough then. ' +
        "A line sold below cost — under what its goods cost, the FIFO cost of the units it would draw, after its discount — carries a belowCost block (each unit's cost, the price after discount, the loss on the line), and belowCostLossEgp is the total: tell the partner the loss before the partner confirms. It is a warning, never a refusal. " +
        'Call without a confirmationToken to preview. Records no other payments, returns or settlements.',
      inputSchema: saleShape,
    },
    {
      preview,
      // What was agreed to: who, each line as priced and against the stock it
      // was shown, and the total. A price or stock change since is refused.
      binds: (shown) => {
        if (shown.needsAnswers) return { needsAnswers: shown.data };
        const d = shown.data as {
          customer: { id: string } | null;
          branch: string | null;
          walkIn: boolean;
          orderedOn: string;
          lines: {
            productId: string;
            qty: string;
            unitPrice: string;
            discount: string;
            lineTotal: string;
            available: string;
          }[];
          total: string;
        };
        return {
          walkIn: d.walkIn,
          customer: d.customer?.id ?? null,
          // The branch shown, so a default changed in between is refused.
          branch: d.branch,
          orderedOn: d.orderedOn,
          lines: d.lines.map((l) => [
            l.productId,
            l.qty,
            l.unitPrice,
            l.discount,
            l.lineTotal,
            l.available,
          ]),
          total: d.total,
        };
      },
      async commit(input) {
        const plan = resolveSale(input, await catalogue());
        // Unreachable after a bound preview, which already refused this.
        if (plan.status === 'questions') {
          throw conflict(
            'PREVIEW_CHANGED',
            'What this would save has changed since the preview. Nothing was saved — show the new preview and confirm that.',
          );
        }
        const { data } = (await ctx
          .resolve(SalesService)
          .create(plan.body, actor)) as {
          data: {
            id: string;
            orderNo: string;
            status: string;
            total: unknown;
            outstanding: unknown;
            payment?: { id: string; method: string | null } | null;
          };
        };
        return {
          summary: plan.walkIn
            ? `Recorded walk-in sale ${data.orderNo}: ${formatMoney(money2(data.total))} ${CURRENCY}, paid by ${data.payment?.method ?? input.paymentMethod ?? 'CASH'}.`
            : `Recorded sale ${data.orderNo} to ${plan.customer!.name}: ${formatMoney(money2(data.total))} ${CURRENCY}, owed.`,
          data: {
            orderId: data.id,
            orderNo: data.orderNo,
            status: data.status,
            total: money2(data.total),
            outstanding: money2(data.outstanding),
            paymentId: data.payment?.id ?? null,
          },
        };
      },
    },
  );
}
