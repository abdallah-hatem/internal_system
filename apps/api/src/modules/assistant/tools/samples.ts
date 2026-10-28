import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; quantities and costs must not become floats
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { z } from 'zod';

import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../../../common/api-error';
import { availableByProduct } from '../../../common/available-stock';
import { businessDay, businessToday, chosenDay } from '../../../common/dates';
import { formatMoney, formatQty } from '../../../common/money';
import { pageSize } from '../../../common/dto/pagination.dto';
import { DEFAULT_MARKUP_PCT } from '../../../common/default-price';
import {
  planSamplesConversion,
  SAMPLES_OPEN_STATUS,
} from '../../../common/samples';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PaymentsService } from '../../payments/payments.service';
import type { PriceChannel } from '../../portal/portal-pricing';
import {
  type CreateSaleOrderInput,
  receivedCutoff,
  SalesService,
  type SamplesConversionInput,
} from '../../sales/sales.service';
import { SALES_PARTNER_ROLES, SALES_ROLES } from '../../sales/sales-roles';
import { previewByRollback, rollingBack } from '../dry-run';
import { matchByName } from '../receipt/name-matching';
import {
  readTool,
  writeTool,
  type AssistantContext,
  type ToolOutcome,
} from '../tool-kit';
import {
  type CatalogueProduct,
  loadSaleCatalogue,
  money2,
  options,
  type SaleQuestion,
} from './sales';

/**
 * Samples at shops through the assistant (BUSINESS_LOGIC §4 "Samples at
 * shops", §16): leave_samples, list_samples, complete_samples_sale,
 * return_samples, write_off_samples.
 *
 * Every rule stays in `SalesService` and `common/samples.ts`. Each write's
 * preview is the office endpoint's own service call run against a database
 * that rolls back (`dry-run.ts`), so whatever the office would refuse — not
 * enough stock, a walk-in, a decision made twice, an order that is not
 * samples — is the preview's refusal too; the commit is the same call, for
 * real. The roles are the office endpoints' (`sales-roles.ts`).
 *
 * - leave_samples       = POST /sales/orders with samples: true
 * - list_samples        = GET /sales/orders?status=SAMPLES, grouped per shop
 *                         and per product as the Sales list and the product
 *                         page's Samples card show it
 * - complete_samples_sale = POST /sales/orders/:id/samples/convert
 * - return_samples      = POST /sales/orders/:id/samples/return
 * - write_off_samples   = POST /sales/orders/:id/samples/write-off
 */

const CURRENCY = 'EGP';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** How many pages of open samples orders list_samples reads at most. */
const MAX_PAGES = 20;

type Decimalish = Prisma.Decimal.Value;
const D = (v: Decimalish) => new Prisma.Decimal(v);

const orderField = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe(
    'The samples order: its ORD- number (e.g. ORD-2026-00042) or its id. list_samples shows both.',
  );

const dayField = (what: string) =>
  z.string().trim().regex(DAY, 'YYYY-MM-DD').optional().describe(what);

// ─── Input shapes ─────────────────────────────────────────────────────

const leaveShape = {
  customer: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'The shop the samples are left with, by name or id. Required: samples are only ever left with a shop on file, never a walk-in, and never a new customer.',
    ),
  walkIn: z
    .boolean()
    .optional()
    .describe(
      'Never true for samples — a walk-in buyer cannot take samples (refused SAMPLES_NEED_SHOP). Leave out.',
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
        qty: z.number().describe('How many units are left. More than zero.'),
        unitPrice: z
          .number()
          .optional()
          .describe(
            'A price per unit in EGP ONLY if the partner said one. It is only noted for when the shop decides; nothing is charged now.',
          ),
      }),
    )
    .min(1),
  orderedOn: dayField(
    'The day the samples were left, YYYY-MM-DD — ONLY when the partner says it was an earlier day. Leave out for today (Cairo). Never a future day.',
  ),
};

const completeShape = {
  order: orderField,
  lines: z
    .array(
      z.object({
        product: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('The product by name, SKU or id.'),
        qty: z
          .number()
          .describe('How many the shop is buying. More than zero.'),
        unitPrice: z
          .number()
          .optional()
          .describe(
            `Price per unit in EGP, as the partner said it. Leave out ONLY when they gave none: the preview then uses the price noted when the samples were left, else the list price (the one set, else landed cost + ${DEFAULT_MARKUP_PCT}%), and the partner must confirm it.`,
          ),
        discount: z
          .number()
          .optional()
          .describe(
            'Money off this line in EGP (an amount, not a percent). At most what the line is worth.',
          ),
      }),
    )
    .min(1)
    .optional()
    .describe(
      'The sale as the shop is making it: every product and quantity it buys. Leave out ONLY when the shop is buying exactly what was left. Anything that went out and is not here goes back to the shelf; anything beyond what went out comes from the shelf.',
    ),
  orderedOn: dayField(
    'The day the shop bought, YYYY-MM-DD — ONLY when the partner says it was an earlier day. Leave out for today. Never before the samples were left, never a future day.',
  ),
};

const returnShape = {
  order: orderField,
  returned: z
    .array(
      z.object({
        product: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe('The product by name, SKU or id.'),
        qty: z.number().describe('How many of it came back.'),
      }),
    )
    .min(1)
    .optional()
    .describe(
      'What came back, ONLY when the partner names products or quantities: those units go back to the shelf and the rest stay at the shop as samples on the same order. More than went out is refused (SAMPLES_RETURN_MORE_THAN_OUT), so is a product not on the order (SAMPLES_RETURN_PRODUCT_NOT_OUT). Leave out when everything came back.',
    ),
};

const writeOffShape = {
  order: orderField,
  reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe(
      'Why, in the partner\'s words ("the shop kept them", "lost"). Goes to the audit log.',
    ),
};

type LeaveInput = z.output<z.ZodObject<typeof leaveShape>>;
type CompleteInput = z.output<z.ZodObject<typeof completeShape>>;
type ReturnInput = z.output<z.ZodObject<typeof returnShape>>;
type WriteOffInput = z.output<z.ZodObject<typeof writeOffShape>>;

// ─── Shared reading ───────────────────────────────────────────────────

function questionsOutcome(
  what: string,
  questions: SaleQuestion[],
): ToolOutcome {
  return {
    needsAnswers: true,
    summary: [
      `${what} cannot be previewed yet:`,
      ...questions.map(
        (q) =>
          `- ${q.text}${q.options.length ? ` Options: ${q.options.map((o) => o.label).join('; ')}.` : ''}`,
      ),
    ].join('\n'),
    data: { questions },
  };
}

function productLabel(p: { name: string; nameAr: string | null; sku: string }) {
  return `${p.name}${p.nameAr ? ` / ${p.nameAr}` : ''} (${p.sku})`;
}

/** Per product, the units a samples order has out, in line order. */
function unitsOut(
  items: readonly {
    productId: string;
    quantity: Decimalish;
    product: { name: string; nameAr: string | null; sku: string };
  }[],
) {
  const out = new Map<
    string,
    {
      productId: string;
      product: string;
      productAr: string | null;
      sku: string;
      qty: Prisma.Decimal;
    }
  >();
  for (const i of items) {
    const row = out.get(i.productId) ?? {
      productId: i.productId,
      product: i.product.name,
      productAr: i.product.nameAr,
      sku: i.product.sku,
      qty: D(0),
    };
    row.qty = row.qty.add(i.quantity);
    out.set(i.productId, row);
  }
  return [...out.values()];
}

export function registerSamplesTools(
  server: McpServer,
  ctx: AssistantContext,
): void {
  const actor = ctx.user.id;
  const prisma = () => ctx.resolve(PrismaService);
  const audit = () => ctx.resolve(AuditService);
  const sales = () => ctx.resolve(SalesService);

  /** The office endpoint's roles (CLAUDE.md §12), not a list of its own. */
  function assertRole(roles: readonly string[]) {
    if (!roles.includes(ctx.user.role)) {
      throw forbidden(
        'ROLE_NOT_ALLOWED',
        'Your role does not allow this action.',
        { role: ctx.user.role },
      );
    }
  }

  /**
   * The SalesService the office calls, over a database whose transaction is
   * rolled back after `inspect` looks inside it. A preview tells nobody that
   * stock is low.
   */
  function dryService<T>(
    inspect: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    const dry = rollingBack(prisma(), inspect);
    return new SalesService(dry, audit(), new PaymentsService(dry, audit()), {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
  }

  /** An order named by id or by its ORD- number; 404 when neither is one. */
  async function orderId(ref: string): Promise<string> {
    const key = ref.trim();
    if (isUUID(key)) return key;
    const found = await prisma().saleOrder.findUnique({
      where: { orderNo: key.toUpperCase() },
      select: { id: true },
    });
    if (!found) throw notFound('saleOrder');
    return found.id;
  }

  /** The order as the office's order popup reads it. */
  async function readOrder(id: string) {
    return (await sales().findById(id)).data;
  }
  type OrderRead = Awaited<ReturnType<typeof readOrder>>;

  /** What a decided samples order looked like before it was rolled back. */
  const seenOrder = (id: string) => async (tx: Prisma.TransactionClient) => {
    const o = await tx.saleOrder.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        total: true,
        outstanding: true,
        items: {
          select: {
            productId: true,
            quantity: true,
            unitPrice: true,
            discount: true,
            lineTotal: true,
          },
        },
      },
    });
    return {
      status: o.status,
      total: money2(o.total),
      outstanding: money2(o.outstanding),
      items: o.items.map((i) => ({
        productId: i.productId,
        quantity: D(i.quantity).toString(),
        unitPrice: money2(i.unitPrice),
        discount: money2(i.discount),
        lineTotal: money2(i.lineTotal),
      })),
    };
  };
  type SeenOrder = Awaited<ReturnType<ReturnType<typeof seenOrder>>>;

  /** The open samples order's lines, as data every preview shows. */
  function outLines(order: OrderRead) {
    return unitsOut(order.items).map((r) => ({
      productId: r.productId,
      product: r.product,
      productAr: r.productAr,
      sku: r.sku,
      qty: r.qty.toString(),
    }));
  }

  /** The landed cost of the units out on an order, from its allocations. */
  function costOut(order: OrderRead): string {
    return order.items
      .flatMap((i) => i.allocations)
      .reduce((s, a) => s.add(a.cogsEgp), D(0))
      .toFixed(2);
  }

  // ─── leave_samples ──────────────────────────────────────────────────

  async function planLeave(input: LeaveInput) {
    // A walk-in, or no shop at all, is the service's refusal — asked of it
    // before anything is matched, so the assistant hears exactly what the
    // office form would (SAMPLES_NEED_SHOP, CUSTOMER_REQUIRED).
    if (input.walkIn === true || !input.customer) {
      await previewByRollback(() =>
        dryService(() => Promise.resolve(null)).create(
          {
            samples: true,
            ...(input.walkIn !== undefined ? { walkIn: input.walkIn } : {}),
            channel: 'B2C',
            currency: CURRENCY,
            items: [],
          },
          actor,
        ),
      );
    }

    const catalogue = await loadSaleCatalogue(prisma());
    const questions: SaleQuestion[] = [];
    const named = input.customer!;
    const found = matchByName(
      { id: named, name: named },
      catalogue.customers,
      'customer',
    );
    let customer: (typeof catalogue.customers)[number] | null = null;
    if (found.status === 'matched') customer = found.match.item;
    else if (found.status === 'unknown') {
      questions.push({
        id: 'CUSTOMER_UNKNOWN',
        kind: 'CUSTOMER_UNKNOWN',
        text: `"${named}" is not a customer on file. Which shop are the samples left with? Samples are only left with a shop on file; new customers are added in the office app.`,
        options: [],
      });
    } else {
      questions.push({
        id: 'CUSTOMER_WHICH',
        kind: 'CUSTOMER_WHICH',
        text: `"${named}" is not an exact match for a customer on file. Which shop is it?`,
        options: options(found, (c) => c.name),
      });
    }

    const lines: {
      line: number;
      product: CatalogueProduct;
      qty: number;
      unitPrice?: number;
    }[] = [];
    input.lines.forEach((l, i) => {
      const line = i + 1;
      const match = matchByName(
        { id: l.product, name: l.product, sku: l.product },
        catalogue.products,
        'product',
      );
      if (match.status === 'matched') {
        lines.push({
          line,
          product: match.match.item,
          qty: l.qty,
          unitPrice: l.unitPrice,
        });
        return;
      }
      questions.push(
        match.status === 'unknown'
          ? {
              id: `LINE_UNKNOWN:${line}`,
              kind: 'LINE_UNKNOWN',
              line,
              text: `Line ${line} ("${l.product}") matches no product on file. Which product is left?`,
              options: [],
            }
          : {
              id: `LINE_WHICH:${line}`,
              kind: 'LINE_WHICH',
              line,
              text: `Line ${line} ("${l.product}") is not an exact match for a product on file. Which one is left?`,
              options: options(match, (p) => productLabel(p)),
            },
      );
    });
    if (questions.length) return { status: 'questions' as const, questions };

    const channel: PriceChannel = customer!.type === 'B2B' ? 'B2B' : 'B2C';
    const body: CreateSaleOrderInput = {
      samples: true,
      customerId: customer!.id,
      channel,
      currency: CURRENCY,
      items: lines.map((l) => ({
        productId: l.product.id,
        quantity: l.qty,
        // Only noted; the service keeps 0 for a price left out.
        unitPrice: l.unitPrice as number,
      })),
      ...(input.orderedOn ? { orderedOn: input.orderedOn } : {}),
    };
    return {
      status: 'ready' as const,
      customer: { id: customer!.id, name: customer!.name },
      channel,
      lines,
      body,
    };
  }

  async function previewLeave(input: LeaveInput): Promise<ToolOutcome> {
    assertRole(SALES_ROLES);
    const plan = await planLeave(input);
    if (plan.status === 'questions') {
      return questionsOutcome('These samples', plan.questions);
    }
    const leftOn = chosenDay(plan.body.orderedOn, 'SALE_MADE');
    const available = await availableByProduct(
      prisma(),
      plan.lines.map((l) => l.product.id),
      undefined,
      receivedCutoff(leftOn),
    );
    const key = `assistant-preview:${randomUUID()}`;
    const seen = await previewByRollback<{ orderNo: string; cost: string }>(
      () =>
        dryService(async (tx) => {
          const o = await tx.saleOrder.findUniqueOrThrow({
            where: {
              createdBy_idempotencyKey: {
                createdBy: actor,
                idempotencyKey: key,
              },
            },
            select: {
              orderNo: true,
              items: { select: { allocations: { select: { cogsEgp: true } } } },
            },
          });
          return {
            orderNo: o.orderNo,
            cost: o.items
              .flatMap((i) => i.allocations)
              .reduce((s, a) => s.add(a.cogsEgp), D(0))
              .toFixed(2),
          };
        }).create(plan.body, actor, key),
    );

    const lines = plan.lines.map((l) => ({
      line: l.line,
      productId: l.product.id,
      product: l.product.name,
      productAr: l.product.nameAr ?? null,
      sku: l.product.sku,
      qty: String(l.qty),
      notedPrice:
        l.unitPrice === undefined ? null : Number(l.unitPrice).toFixed(2),
      available: available.get(l.product.id)?.toString() ?? '0',
    }));
    return {
      summary: [
        `Leave samples with ${plan.customer.name} on ${leftOn}${leftOn === businessToday() ? ' (today)' : ''} — no charge, nothing owed until the shop decides:`,
        ...lines.map(
          (l) =>
            `- ${l.product} (${l.sku}): ${formatQty(l.qty)} of ${formatQty(l.available)} in stock` +
            (l.notedPrice !== null
              ? `; price noted ${formatMoney(l.notedPrice)} ${CURRENCY}`
              : ''),
        ),
        `The units leave the shelf now; their landed cost is ${formatMoney(seen.cost)} ${CURRENCY}. A reminder goes to every partner after 14 days if the shop has not decided.`,
      ].join('\n'),
      data: {
        customer: plan.customer,
        channel: plan.channel,
        leftOn,
        lines,
        costAtShopEgp: seen.cost,
        statusAfter: SAMPLES_OPEN_STATUS,
        total: '0.00',
        outstandingAfter: '0.00',
      },
    };
  }

  writeTool(
    server,
    ctx,
    'leave_samples',
    {
      title: 'Leave samples at a shop',
      description:
        'Records samples left with a shop on file, with no charge: the units leave the shelf now (oldest stock first, as a sale draws), nothing is sold and nothing is owed until the shop decides — buying (complete_samples_sale), sending them back (return_samples) or keeping/losing them (write_off_samples). ' +
        'The shop is required and must be a customer on file — never a walk-in (SAMPLES_NEED_SHOP), never a new customer. Products and the shop are matched by exact name, SKU or id only; a close name comes back as a question. ' +
        'A price is optional and only noted. Refused when there is not that much on the shelf (NOT_ENOUGH_STOCK) or a quantity is not above zero (QTY_NOT_POSITIVE). Call without a confirmationToken to preview.',
      inputSchema: leaveShape,
    },
    {
      preview: previewLeave,
      binds: (shown) => {
        if (shown.needsAnswers) return { needsAnswers: shown.data };
        const d = shown.data as {
          customer: { id: string };
          leftOn: string;
          lines: {
            productId: string;
            qty: string;
            notedPrice: string | null;
            available: string;
          }[];
          costAtShopEgp: string;
        };
        return {
          customer: d.customer.id,
          leftOn: d.leftOn,
          lines: d.lines.map((l) => [
            l.productId,
            l.qty,
            l.notedPrice,
            l.available,
          ]),
          cost: d.costAtShopEgp,
        };
      },
      async commit(input) {
        assertRole(SALES_ROLES);
        const plan = await planLeave(input);
        if (plan.status === 'questions') throw previewChanged();
        const { data } = (await sales().create(plan.body, actor)) as {
          data: { id: string; orderNo: string; status: string };
        };
        return {
          summary: `Left samples with ${plan.customer.name}: ${data.orderNo}. Nothing is owed until the shop decides.`,
          data: {
            orderId: data.id,
            orderNo: data.orderNo,
            status: data.status,
          },
        };
      },
    },
  );

  // ─── list_samples ───────────────────────────────────────────────────

  readTool(
    server,
    'list_samples',
    {
      title: 'List samples at shops',
      description:
        'Samples still at shops (open samples orders), as the office shows them: per order (its ORD- number and id, the shop, the day left, days at the shop, the reminder day, each product and how many), per shop, and per product. Samples are NOT sales: nothing is owed on them and they are not counted as sold. Optionally for one shop (customerId) or one product (productId).',
      inputSchema: {
        customerId: z
          .string()
          .optional()
          .describe(
            'Only this shop (its id — use get_customer to find it by name).',
          ),
        productId: z
          .string()
          .optional()
          .describe(
            'Only this product (its id — use find_products to find it).',
          ),
      },
    },
    async ({ customerId, productId }) => {
      assertRole(SALES_ROLES);
      const shopId = customerId?.trim();
      if (shopId !== undefined && !isUUID(shopId)) throw notFound('customer');
      const product = productId?.trim();
      if (product !== undefined && !isUUID(product)) throw notFound('product');

      // Every open samples order, as the product page's Samples card reads
      // them (all pages of status=SAMPLES).
      type Listed = Awaited<ReturnType<SalesService['findAll']>>['data'];
      const all: Listed = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await sales().findAll({
          status: SAMPLES_OPEN_STATUS,
          customerId: shopId,
          cursor,
          limit: pageSize(100),
        });
        all.push(...res.data);
        cursor = res.meta.nextCursor ?? undefined;
        if (!cursor) break;
      }

      const orders = all
        .map((o) => {
          const lines = unitsOut(
            o.items.filter((i) => !product || i.productId === product),
          ).map((r) => ({
            productId: r.productId,
            product: r.product,
            productAr: r.productAr,
            sku: r.sku,
            qty: r.qty.toString(),
          }));
          return {
            orderId: o.id,
            orderNo: o.orderNo,
            customerId: o.customerId,
            shop: o.customer.displayName,
            channel: o.channel,
            leftOn: o.samples?.leftOn ?? null,
            daysAtShop: o.samples?.daysAtShop ?? 0,
            reminderOn: o.samples?.reminderOn ?? null,
            reminded: Boolean(o.samples?.remindedAt),
            units: lines.reduce((s, l) => s.add(l.qty), D(0)).toString(),
            lines,
          };
        })
        .filter((o) => o.lines.length > 0)
        // Longest at the shop first, as the product page lists them.
        .sort(
          (a, b) =>
            b.daysAtShop - a.daysAtShop || a.orderNo.localeCompare(b.orderNo),
        );

      const byShop = new Map<
        string,
        {
          customerId: string;
          shop: string;
          orders: number;
          units: Prisma.Decimal;
        }
      >();
      const byProduct = new Map<
        string,
        {
          productId: string;
          product: string;
          productAr: string | null;
          sku: string;
          units: Prisma.Decimal;
          shops: { shop: string; orderNo: string; units: string }[];
        }
      >();
      for (const o of orders) {
        const s = byShop.get(o.customerId) ?? {
          customerId: o.customerId,
          shop: o.shop,
          orders: 0,
          units: D(0),
        };
        s.orders += 1;
        s.units = s.units.add(o.units);
        byShop.set(o.customerId, s);
        for (const l of o.lines) {
          const p = byProduct.get(l.productId) ?? {
            productId: l.productId,
            product: l.product,
            productAr: l.productAr,
            sku: l.sku,
            units: D(0),
            shops: [],
          };
          p.units = p.units.add(l.qty);
          p.shops.push({ shop: o.shop, orderNo: o.orderNo, units: l.qty });
          byProduct.set(l.productId, p);
        }
      }
      const totalUnits = orders.reduce((s, o) => s.add(o.units), D(0));
      const data = {
        totalUnits: totalUnits.toString(),
        orders,
        byShop: [...byShop.values()]
          .map((s) => ({ ...s, units: s.units.toString() }))
          .sort((a, b) => a.shop.localeCompare(b.shop)),
        byProduct: [...byProduct.values()]
          .map((p) => ({ ...p, units: p.units.toString() }))
          .sort((a, b) => a.product.localeCompare(b.product)),
      };
      return {
        summary:
          orders.length === 0
            ? 'No samples are out at shops.'
            : `${formatQty(data.totalUnits)} unit(s) out as samples on ${orders.length} order(s) at ${data.byShop.length} shop(s) — not sales, nothing owed.\n${JSON.stringify(data)}`,
        data,
      };
    },
  );

  // ─── complete_samples_sale ──────────────────────────────────────────

  async function planComplete(input: CompleteInput) {
    const id = await orderId(input.order);
    const order = await readOrder(id);
    if (order.status !== SAMPLES_OPEN_STATUS) {
      // Decided already, or never samples: the service's own refusal
      // (SAMPLES_ALREADY_DECIDED, NOT_SAMPLES), before any price is asked.
      // Its status check runs before it looks at the lines.
      await previewByRollback(() =>
        dryService(() => Promise.resolve(null)).convertSamples(
          id,
          { items: [] },
          actor,
        ),
      );
    }
    const productIds = [...new Set(order.items.map((i) => i.productId))];
    const catalogue = await loadSaleCatalogue(prisma(), productIds);
    const channel: PriceChannel = order.channel === 'B2B' ? 'B2B' : 'B2C';
    /** The price noted on the samples line when it was left, when one was. */
    const noted = new Map<string, string>();
    for (const i of order.items) {
      if (D(i.unitPrice).gt(0) && !noted.has(i.productId)) {
        noted.set(i.productId, money2(i.unitPrice));
      }
    }

    // What the shop is buying: the partner's lines, else everything that
    // went out at its noted price.
    const wanted =
      input.lines ??
      unitsOut(order.items).map((r) => ({
        product: r.productId,
        qty: r.qty.toNumber(),
        unitPrice: undefined as number | undefined,
        discount: undefined as number | undefined,
      }));

    const questions: SaleQuestion[] = [];
    const lines: {
      line: number;
      product: CatalogueProduct;
      qty: number;
      unitPrice: number;
      priceSource: 'given' | 'noted' | 'list' | 'default';
      discount: number;
    }[] = [];
    wanted.forEach((l, i) => {
      const line = i + 1;
      const match = matchByName(
        { id: l.product, name: l.product, sku: l.product },
        catalogue.products,
        'product',
      );
      if (match.status !== 'matched') {
        questions.push(
          match.status === 'unknown'
            ? {
                id: `LINE_UNKNOWN:${line}`,
                kind: 'LINE_UNKNOWN',
                line,
                text: `Line ${line} ("${l.product}") matches no product on file. Which product is the shop buying?`,
                options: [],
              }
            : {
                id: `LINE_WHICH:${line}`,
                kind: 'LINE_WHICH',
                line,
                text: `Line ${line} ("${l.product}") is not an exact match for a product on file. Which one is the shop buying?`,
                options: options(match, (p) => productLabel(p)),
              },
        );
        return;
      }
      const product = match.match.item;
      let unitPrice = l.unitPrice;
      let priceSource: (typeof lines)[number]['priceSource'] = 'given';
      if (unitPrice === undefined) {
        const fromNote = noted.get(product.id);
        const list = product.listPrices[channel];
        if (fromNote !== undefined) {
          unitPrice = Number(fromNote);
          priceSource = 'noted';
        } else if (list) {
          unitPrice = Number(list.amount);
          priceSource = list.source === 'DEFAULT' ? 'default' : 'list';
        } else {
          questions.push({
            id: `PRICE_NEEDED:${line}`,
            kind: 'PRICE_NEEDED',
            line,
            text: `Line ${line} (${product.name}) has no price: none was noted when the samples were left, there is no ${channel} list price, and it was never received so there is no default. What is the shop paying?`,
            options: [],
          });
          return;
        }
      }
      lines.push({
        line,
        product,
        qty: l.qty,
        unitPrice,
        priceSource,
        discount: l.discount ?? 0,
      });
    });
    if (questions.length) return { status: 'questions' as const, questions };

    const body: SamplesConversionInput = {
      items: lines.map((l) => ({
        productId: l.product.id,
        quantity: l.qty,
        unitPrice: l.unitPrice,
        ...(l.discount ? { discount: l.discount } : {}),
      })),
      ...(input.orderedOn ? { orderedOn: input.orderedOn } : {}),
    };
    return { status: 'ready' as const, id, order, channel, lines, body };
  }

  async function previewComplete(input: CompleteInput): Promise<ToolOutcome> {
    assertRole(SALES_ROLES);
    const plan = await planComplete(input);
    if (plan.status === 'questions') {
      return questionsOutcome('This sale from samples', plan.questions);
    }
    // The office's own conversion, rolled back: every refusal it has
    // (decided already, not samples, more than the shelf has, a day before
    // the samples were left) is this preview's.
    const seen = await previewByRollback<SeenOrder>(() =>
      dryService(seenOrder(plan.id)).convertSamples(plan.id, plan.body, actor),
    );
    const { order } = plan;
    const soldOn = chosenDay(plan.body.orderedOn, 'SALE_MADE');

    // Per product, what went out, what is kept, back and from the shelf —
    // the service's own plan (common/samples.ts), shown, not re-decided.
    const draws = order.items
      .flatMap((i) =>
        i.allocations.map((a) => ({
          productId: i.productId,
          batchId: a.inventoryBatchId,
          qty: a.qty,
          unitCostEgp: a.unitCostEgp,
          receivedAt: a.inventoryBatch.createdAt.getTime(),
        })),
      )
      .sort(
        (a, b) =>
          a.receivedAt - b.receivedAt || a.batchId.localeCompare(b.batchId),
      );
    const split = planSamplesConversion(draws, plan.body.items);
    const names = new Map<string, string>();
    for (const i of order.items) names.set(i.productId, i.product.name);
    for (const l of plan.lines) names.set(l.product.id, l.product.name);
    const products = split.products.map((p) => ({
      productId: p.productId,
      product: names.get(p.productId) ?? p.productId,
      out: p.out.toString(),
      kept: p.kept.toString(),
      back: p.out.sub(p.kept).toString(),
      fromShelf: p.extra.toString(),
    }));

    // Pair each line with the row the service wrote for it.
    const unused = [...seen.items];
    const lines = plan.lines.map((l) => {
      const at = unused.findIndex(
        (s) =>
          s.productId === l.product.id &&
          D(s.quantity).eq(l.qty) &&
          D(s.unitPrice).eq(l.unitPrice),
      );
      const row = at >= 0 ? unused.splice(at, 1)[0] : null;
      return {
        line: l.line,
        productId: l.product.id,
        product: l.product.name,
        productAr: l.product.nameAr ?? null,
        sku: l.product.sku,
        qty: String(l.qty),
        unitPrice: Number(l.unitPrice).toFixed(2),
        priceSource: l.priceSource,
        discount: Number(l.discount).toFixed(2),
        lineTotal: row?.lineTotal ?? null,
      };
    });
    const shop = order.customer.displayName;
    const priceNote = (s: string) =>
      s === 'noted'
        ? ' (price noted when left — confirm it)'
        : s === 'list'
          ? ' (list price — confirm or give the price)'
          : s === 'default'
            ? ` (default price, landed cost + ${DEFAULT_MARKUP_PCT}% — confirm or give the price)`
            : '';
    return {
      summary: [
        `${order.orderNo}: ${shop} is buying from the samples left on ${order.samples?.leftOn ?? businessDay(order.orderedAt)}. It becomes a confirmed sale on ${soldOn}${soldOn === businessToday() ? ' (today)' : ''}, owed by ${shop}:`,
        ...lines.map(
          (l) =>
            `- ${l.product} (${l.sku}): ${formatQty(l.qty)} × ${formatMoney(l.unitPrice)}${priceNote(l.priceSource)}` +
            (Number(l.discount) ? ` less ${formatMoney(l.discount)}` : '') +
            (l.lineTotal ? ` = ${formatMoney(l.lineTotal)} ${CURRENCY}` : ''),
        ),
        ...products.map(
          (p) =>
            `  ${p.product}: ${formatQty(p.out)} went out, ${formatQty(p.kept)} kept` +
            (Number(p.back) ? `, ${formatQty(p.back)} back to the shelf` : '') +
            (Number(p.fromShelf)
              ? `, ${formatQty(p.fromShelf)} more from the shelf`
              : ''),
        ),
        `Total: ${formatMoney(seen.total)} ${CURRENCY}; ${shop} will owe ${formatMoney(seen.outstanding)} ${CURRENCY}. No payment is recorded.`,
      ].join('\n'),
      data: {
        orderId: plan.id,
        orderNo: order.orderNo,
        customer: { id: order.customerId, name: shop },
        channel: plan.channel,
        currency: order.currency,
        orderedOn: soldOn,
        lines,
        products,
        total: seen.total,
        statusAfter: seen.status,
        outstandingAfter: seen.outstanding,
      },
    };
  }

  writeTool(
    server,
    ctx,
    'complete_samples_sale',
    {
      title: "They're buying: complete the sale from samples",
      description:
        'The shop is buying from samples left with it: the samples order becomes a confirmed sale, in place (same ORD number), owed by that shop, dated today unless the partner says an earlier day. Give every product and quantity the shop is buying — fewer than went out (the rest goes back to the shelf), more (the extra comes from the shelf), or other products; leave lines out only when it buys exactly what was left. ' +
        'Without a price a line uses the price noted when the samples were left, else the list price — the partner must confirm it. ' +
        'Refused when the order was already decided (SAMPLES_ALREADY_DECIDED), is not samples (NOT_SAMPLES), the shelf lacks the extra (SAMPLES_EXTRA_NOT_IN_STOCK, NOT_ENOUGH_STOCK), or the day is before the samples were left (SAMPLES_SALE_BEFORE_LEFT). If every sample came back use return_samples instead. Call without a confirmationToken to preview.',
      inputSchema: completeShape,
    },
    {
      preview: previewComplete,
      binds: (shown) => {
        if (shown.needsAnswers) return { needsAnswers: shown.data };
        const d = shown.data as {
          orderId: string;
          orderedOn: string;
          lines: {
            productId: string;
            qty: string;
            unitPrice: string;
            discount: string;
            lineTotal: string | null;
          }[];
          products: {
            productId: string;
            out: string;
            kept: string;
            back: string;
            fromShelf: string;
          }[];
          total: string;
        };
        return {
          order: d.orderId,
          orderedOn: d.orderedOn,
          lines: d.lines.map((l) => [
            l.productId,
            l.qty,
            l.unitPrice,
            l.discount,
            l.lineTotal,
          ]),
          products: d.products.map((p) => [
            p.productId,
            p.out,
            p.kept,
            p.back,
            p.fromShelf,
          ]),
          total: d.total,
        };
      },
      async commit(input) {
        assertRole(SALES_ROLES);
        const plan = await planComplete(input);
        if (plan.status === 'questions') throw previewChanged();
        const { data } = await sales().convertSamples(
          plan.id,
          plan.body,
          actor,
        );
        return {
          summary: `Recorded the sale from samples ${data.orderNo} to ${plan.order.customer.displayName}: ${formatMoney(money2(data.total))} ${CURRENCY}, owed.`,
          data: {
            orderId: data.id,
            orderNo: data.orderNo,
            status: data.status,
            total: money2(data.total),
            outstanding: money2(data.outstanding),
          },
        };
      },
    },
  );

  // ─── return_samples ─────────────────────────────────────────────────

  /**
   * The products the partner named as come back, matched to the products on
   * the order — the same lines the office's "Returned" sends (owner
   * 2026-10-28: some may come back and the rest stay). A close name is a
   * question, never assumed; a name matching nothing on the order is
   * `SAMPLES_RETURN_PRODUCT_NOT_OUT`. Every amount — 0 or less, more than is
   * out — is the service's check, not a second copy here.
   */
  function returnedLines(
    order: OrderRead,
    returned: ReturnInput['returned'],
  ):
    | { questions: SaleQuestion[] }
    | { lines: { productId: string; quantity: number }[] | undefined } {
    if (!returned) return { lines: undefined };
    const items = unitsOut(order.items).map((r) => ({
      id: r.productId,
      name: r.product,
      nameAr: r.productAr,
      sku: r.sku,
    }));
    const questions: SaleQuestion[] = [];
    const lines: { productId: string; quantity: number }[] = [];
    returned.forEach((l, i) => {
      const line = i + 1;
      const match = matchByName(
        { id: l.product, name: l.product, sku: l.product },
        items,
        'product',
      );
      if (match.status === 'unknown') {
        throw badRequest(
          'SAMPLES_RETURN_PRODUCT_NOT_OUT',
          `${order.orderNo} holds no ${l.product} as a sample, so none can come back.`,
          { order: order.orderNo, product: l.product },
        );
      }
      if (match.status !== 'matched') {
        questions.push({
          id: `LINE_WHICH:${line}`,
          kind: 'LINE_WHICH',
          line,
          text: `Line ${line} ("${l.product}") is not an exact match for a product on ${order.orderNo}. Which one came back?`,
          options: options(match, (p) => productLabel(p)),
        });
        return;
      }
      lines.push({ productId: match.match.item.id, quantity: l.qty });
    });
    return questions.length ? { questions } : { lines };
  }

  async function previewReturn(input: ReturnInput): Promise<ToolOutcome> {
    assertRole(SALES_ROLES);
    const id = await orderId(input.order);
    const order = await readOrder(id);
    const asked = returnedLines(order, input.returned);
    // The office's own "Returned", rolled back — every refusal is its own:
    // decided already, not samples, 0 or less, more than is out.
    const seen = await previewByRollback<SeenOrder>(() =>
      dryService(seenOrder(id)).returnSamples(id, actor, {
        lines: 'lines' in asked ? asked.lines : undefined,
      }),
    );
    if ('questions' in asked) {
      return questionsOutcome('This return', asked.questions);
    }
    const lines = outLines(order);
    const all = seen.status === 'SAMPLES_RETURNED';
    const stays = all
      ? []
      : lines
          .map((l) => ({
            ...l,
            qty: seen.items
              .filter((i) => i.productId === l.productId)
              .reduce((s, i) => s.add(i.quantity), D(0))
              .toString(),
          }))
          .filter((l) => D(l.qty).gt(0));
    const back = lines
      .map((l) => ({
        ...l,
        qty: D(l.qty)
          .sub(stays.find((s) => s.productId === l.productId)?.qty ?? 0)
          .toString(),
      }))
      .filter((l) => D(l.qty).gt(0));
    const shop = order.customer.displayName;
    return {
      summary: [
        all
          ? `${order.orderNo}: every sample left with ${shop} on ${order.samples?.leftOn ?? businessDay(order.orderedAt)} comes back to the shelf:`
          : `${order.orderNo}: these samples left with ${shop} on ${order.samples?.leftOn ?? businessDay(order.orderedAt)} come back to the shelf:`,
        ...back.map((l) => `- ${l.product} (${l.sku}): ${formatQty(l.qty)}`),
        ...(all
          ? ['No sale, nothing owed; the order ends as returned samples.']
          : [
              'Still at the shop as samples, on the same order (its day left and reminder unchanged):',
              ...stays.map(
                (l) => `- ${l.product} (${l.sku}): ${formatQty(l.qty)}`,
              ),
              'No sale, nothing owed.',
            ]),
      ].join('\n'),
      data: {
        orderId: id,
        orderNo: order.orderNo,
        customer: { id: order.customerId, name: shop },
        lines,
        returned: back,
        stays,
        statusAfter: all ? 'SAMPLES_RETURNED' : SAMPLES_OPEN_STATUS,
      },
    };
  }

  writeTool(
    server,
    ctx,
    'return_samples',
    {
      title: 'Samples returned',
      description:
        'Samples came back from the shop: the units go back to the shelf, to the batch each left; no sale, nothing owed. Without `returned`, every unit on the order comes back and it ends as returned samples. With `returned`, only those units come back and the rest stay samples on the same order (its day left and reminder unchanged) — the same lines the office\'s "Returned" takes. If the shop kept some and is paying for them, use complete_samples_sale. ' +
        'Refused when the order was already decided (SAMPLES_ALREADY_DECIDED) or is not samples (NOT_SAMPLES), a product is not on the order (SAMPLES_RETURN_PRODUCT_NOT_OUT), more comes back than went out (SAMPLES_RETURN_MORE_THAN_OUT), or a quantity is 0 or less (QTY_NOT_POSITIVE). Call without a confirmationToken to preview.',
      inputSchema: returnShape,
    },
    {
      preview: previewReturn,
      binds: (shown) => {
        if (shown.needsAnswers) return { needsAnswers: shown.data };
        const d = shown.data as {
          orderId: string;
          lines: { productId: string; qty: string }[];
          returned: { productId: string; qty: string }[];
        };
        return {
          order: d.orderId,
          lines: d.lines.map((l) => [l.productId, l.qty]),
          returned: d.returned.map((l) => [l.productId, l.qty]),
        };
      },
      async commit(input) {
        assertRole(SALES_ROLES);
        const id = await orderId(input.order);
        const asked = returnedLines(await readOrder(id), input.returned);
        if ('questions' in asked) throw previewChanged();
        const { data } = await sales().returnSamples(id, actor, {
          lines: asked.lines,
        });
        const all = data.status === 'SAMPLES_RETURNED';
        return {
          summary: all
            ? `Recorded ${data.orderNo} as returned: every sample is back on the shelf.`
            : `Recorded the samples that came back on ${data.orderNo}: they are back on the shelf, and ${data.samples?.unitsOut ?? '0'} unit(s) stay at the shop as samples.`,
          data: {
            orderId: data.id,
            orderNo: data.orderNo,
            status: data.status,
          },
        };
      },
    },
  );

  // ─── write_off_samples ──────────────────────────────────────────────

  async function previewWriteOff(input: WriteOffInput): Promise<ToolOutcome> {
    assertRole(SALES_PARTNER_ROLES);
    const id = await orderId(input.order);
    const order = await readOrder(id);
    await previewByRollback(() =>
      dryService(() => Promise.resolve(null)).writeOffSamples(
        id,
        { reason: input.reason },
        actor,
      ),
    );
    const lines = outLines(order);
    const cost = costOut(order);
    const shop = order.customer.displayName;
    return {
      summary: [
        `${order.orderNo}: write off the samples left with ${shop} — they never come back to the shelf:`,
        ...lines.map((l) => `- ${l.product} (${l.sku}): ${formatQty(l.qty)}`),
        `Their landed cost, ${formatMoney(cost)} ${CURRENCY}, becomes a cost of the cycles they came from ("Samples written off"). Nothing is sold and nothing is owed. This cannot be undone.`,
      ].join('\n'),
      data: {
        orderId: id,
        orderNo: order.orderNo,
        customer: { id: order.customerId, name: shop },
        lines,
        costEgp: cost,
        reason: input.reason ?? null,
        statusAfter: 'SAMPLES_WRITTEN_OFF',
      },
    };
  }

  writeTool(
    server,
    ctx,
    'write_off_samples',
    {
      title: 'Write off samples',
      description:
        "The shop kept the samples without paying, or they were lost: the whole order's units never come back, and their landed cost becomes a cost of the cycles they came from. A core partner's decision; cannot be undone. The preview shows the cost written off — tell the partner before they confirm. " +
        'Refused when the order was already decided (SAMPLES_ALREADY_DECIDED) or is not samples (NOT_SAMPLES). Call without a confirmationToken to preview.',
      inputSchema: writeOffShape,
    },
    {
      preview: previewWriteOff,
      binds: (shown) => {
        const d = shown.data as {
          orderId: string;
          lines: { productId: string; qty: string }[];
          costEgp: string;
        };
        return {
          order: d.orderId,
          lines: d.lines.map((l) => [l.productId, l.qty]),
          cost: d.costEgp,
        };
      },
      async commit(input) {
        assertRole(SALES_PARTNER_ROLES);
        const id = await orderId(input.order);
        const { data } = await sales().writeOffSamples(
          id,
          { reason: input.reason },
          actor,
        );
        return {
          summary: `Wrote off the samples on ${data.orderNo}.`,
          data: {
            orderId: data.id,
            orderNo: data.orderNo,
            status: data.status,
          },
        };
      },
    },
  );
}

function previewChanged() {
  return conflict(
    'PREVIEW_CHANGED',
    'What this would save has changed since the preview. Nothing was saved — show the new preview and confirm that.',
  );
}
