import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isUUID } from 'class-validator';
import { z } from 'zod';

import { conflict, forbidden, notFound } from '../../../common/api-error';
import { formatMoney, formatQty } from '../../../common/money';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  OrderEditsService,
  type OrderEditInput,
} from '../../sales/order-edits.service';
import { SALES_PARTNER_ROLES } from '../../sales/sales-roles';
import { matchByName } from '../receipt/name-matching';
import {
  writeTool,
  type AssistantContext,
  type ToolOutcome,
} from '../tool-kit';
import { loadSaleCatalogue, options, type SaleQuestion } from './sales';

/**
 * Editing a confirmed order through the assistant and the office chat
 * (BUSINESS_LOGIC §4 "Editing a confirmed order"; GUESS 2026-10-26 that it is
 * offered there at all — the BUILD_LOG asked for it "if exposed there").
 *
 * - edit_order = POST /sales/orders/:id/edits/preview, then
 *                POST /sales/orders/:id/edits at the version previewed
 *
 * Every rule stays in `OrderEditsService`: the preview is its own `preview`
 * (which writes nothing), the commit its own `create`. The roles are the
 * office endpoint's (`SALES_PARTNER_ROLES`). What the partner agrees to —
 * the order's version, each line before and after, what the shop will owe —
 * is bound to the confirmation, so anything that moved the order in between
 * (a payment, a return, another edit) is refused PREVIEW_CHANGED.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const editShape = {
  order: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      'The confirmed sale to edit: its ORD- number (e.g. ORD-2026-00042) or its id. list_sales shows both.',
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
        quantity: z
          .number()
          .describe(
            'How many units the shop should hold of this product AFTER the edit (not how many to add). 0 gives every unit back.',
          ),
        unitPrice: z
          .number()
          .optional()
          .describe(
            'The price per unit in EGP after the edit, ONLY if the partner said one. Left out, the price stays. Required for a product new on the order.',
          ),
      }),
    )
    .min(1)
    .describe(
      'Only the products that change, each once. Every other line stays as it is.',
    ),
  editedOn: z
    .string()
    .trim()
    .regex(DAY, 'YYYY-MM-DD')
    .optional()
    .describe(
      'The day of the change, YYYY-MM-DD — ONLY when the partner says it was an earlier day. Leave out for today (Cairo). Never a future day, never before the sale.',
    ),
  reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe('Why, in the partner’s words. Shown on the order’s History.'),
};

type EditInput = z.output<z.ZodObject<typeof editShape>>;

type Plan =
  | { status: 'questions'; questions: SaleQuestion[] }
  | {
      status: 'ready';
      orderId: string;
      body: Omit<OrderEditInput, 'version'> & {
        lines: { productId: string; quantity: number; unitPrice?: number }[];
      };
    };

type Preview = Awaited<ReturnType<OrderEditsService['preview']>>['data'];

export function registerOrderEditTools(
  server: McpServer,
  ctx: AssistantContext,
): void {
  const actor = ctx.user.id;
  const prisma = () => ctx.resolve(PrismaService);
  const edits = () => ctx.resolve(OrderEditsService);
  /**
   * The last preview this request made. A server lives for one request, and
   * a commit is redeemed by previewing again (the bound check) right before
   * `commit` runs: that preview's version is the one the partner agreed to,
   * so the save is refused if the order moved even a moment after it.
   */
  let lastPreview: Preview | null = null;

  /** The office endpoint's roles (CLAUDE.md §12), not a list of its own. */
  function assertAllowed() {
    if (!(SALES_PARTNER_ROLES as readonly string[]).includes(ctx.user.role)) {
      throw forbidden(
        'ROLE_NOT_ALLOWED',
        'Your role does not allow this action.',
        { role: ctx.user.role },
      );
    }
  }

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

  async function plan(input: EditInput): Promise<Plan> {
    assertAllowed();
    const id = await orderId(input.order);
    const onOrder = await prisma().saleItem.findMany({
      where: { saleOrderId: id },
      select: { productId: true },
    });
    // The order's own products whatever their status, and what can be sold.
    const catalogue = await loadSaleCatalogue(
      prisma(),
      onOrder.map((i) => i.productId),
    );
    const questions: SaleQuestion[] = [];
    const lines: Extract<Plan, { status: 'ready' }>['body']['lines'] = [];
    input.lines.forEach((l, i) => {
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
                text: `Line ${line} ("${l.product}") matches no product on file. Which product is it?`,
                options: [],
              }
            : {
                id: `LINE_WHICH:${line}`,
                kind: 'LINE_WHICH',
                line,
                text: `Line ${line} ("${l.product}") is not an exact match for a product on file. Which one is it?`,
                options: options(match, (p) => `${p.name} (${p.sku})`),
              },
        );
        return;
      }
      lines.push({
        productId: match.match.item.id,
        quantity: l.quantity,
        ...(l.unitPrice !== undefined ? { unitPrice: l.unitPrice } : {}),
      });
    });
    if (questions.length) return { status: 'questions', questions };
    return {
      status: 'ready',
      orderId: id,
      body: {
        lines,
        ...(input.editedOn ? { editedOn: input.editedOn } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
    };
  }

  function describe(p: Preview): string {
    const rows = p.lines.map((l) => {
      const qty =
        l.qtyBefore === l.qtyAfter
          ? `${formatQty(l.qtyAfter)}`
          : `${formatQty(l.qtyBefore)} → ${formatQty(l.qtyAfter)}`;
      const price =
        l.priceBefore === null
          ? ` at ${formatMoney(l.priceAfter)} EGP (new on the order)`
          : l.priceBefore !== l.priceAfter
            ? `, price ${formatMoney(l.priceBefore)} → ${formatMoney(l.priceAfter)} EGP`
            : ` at ${formatMoney(l.priceAfter)} EGP`;
      return `- ${l.product}: ${qty}${price}`;
    });
    const stock = [
      ...p.stockTaken.map(
        (s) => `${formatQty(s.qty)} × ${s.product} from stock`,
      ),
      ...p.stockBack.map(
        (s) => `${formatQty(s.qty)} × ${s.product} back to stock`,
      ),
    ];
    return [
      `Edit of ${p.orderNo} on ${p.editedOn}:`,
      ...rows,
      ...(stock.length ? [`Stock: ${stock.join('; ')}.`] : []),
      `The shop owes ${formatMoney(p.owedBefore)} EGP before, ${formatMoney(p.owedAfter)} EGP after (${Number(p.changeEgp) >= 0 ? '+' : ''}${formatMoney(p.changeEgp)}).`,
      `Profit changes by ${formatMoney(p.profitChangeEgp)} EGP.`,
    ].join('\n');
  }

  async function preview(input: EditInput): Promise<ToolOutcome> {
    const p = await plan(input);
    if (p.status === 'questions') {
      return {
        needsAnswers: true,
        summary: [
          'This edit cannot be previewed yet:',
          ...p.questions.map(
            (q) =>
              `- ${q.text}${q.options.length ? ` Options: ${q.options.map((o) => o.label).join('; ')}.` : ''}`,
          ),
        ].join('\n'),
        data: { questions: p.questions },
      };
    }
    const { data } = await edits().preview(p.orderId, p.body);
    lastPreview = data;
    return { summary: describe(data), data };
  }

  writeTool(
    server,
    ctx,
    'edit_order',
    {
      title: 'Edit a confirmed order',
      description:
        'Changes a confirmed sale: adds a product, changes how many the shop holds, or changes a price up or down — each a dated change, never an overwrite. ' +
        'Name only the products that change, with the quantity the shop should hold after the edit. ' +
        'Refused for a draft, cancelled, fully returned, samples or walk-in order, an order under an instalment contract or on a cycle being settled, a day before the sale or in the future, more than the shelf holds, and any edit that would take the order below what was paid. ' +
        'The preview shows each line before and after, stock taken and given back, and what the shop owes before and after. Call without a confirmationToken to preview.',
      inputSchema: editShape,
    },
    {
      preview,
      // What was agreed to: the order at that version, each line, and what
      // the shop will owe. Anything that moved the order since is refused.
      binds: (shown) => {
        if (shown.needsAnswers) return { needsAnswers: shown.data };
        const d = shown.data as Preview;
        return {
          order: d.saleOrderId,
          version: d.version,
          editedOn: d.editedOn,
          lines: d.lines,
          owedBefore: d.owedBefore,
          owedAfter: d.owedAfter,
          stockTaken: d.stockTaken,
          stockBack: d.stockBack,
        };
      },
      async commit(input) {
        const p = await plan(input);
        // Unreachable after a bound preview, which already refused this.
        if (p.status === 'questions') {
          throw conflict(
            'PREVIEW_CHANGED',
            'What this would save has changed since the preview. Nothing was saved — show the new preview and confirm that.',
          );
        }
        // The bound preview, just made, matched the one shown: save at its
        // version, never a newer one nobody saw.
        if (!lastPreview || lastPreview.saleOrderId !== p.orderId) {
          throw conflict(
            'PREVIEW_CHANGED',
            'What this would save has changed since the preview. Nothing was saved — show the new preview and confirm that.',
          );
        }
        const { data } = await edits().create(
          p.orderId,
          { ...p.body, version: lastPreview.version },
          actor,
        );
        return { summary: `Saved. ${describe(data)}`, data };
      },
    },
  );
}
