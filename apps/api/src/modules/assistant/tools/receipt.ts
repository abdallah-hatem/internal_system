import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ProductsService } from '../../products/products.service';
import { PurchasesService } from '../../purchases/purchases.service';
import { SUPPLIER_INVOICE_REF_MAX } from '../../purchases/supplier-invoice-ref';
import { SuppliersService } from '../../suppliers/suppliers.service';
import { analyzeReceipt } from '../receipt/analyze-receipt';
import { loadReceiptSnapshot } from '../receipt/load-snapshot';
import {
  type ReceiptServices,
  productWrite,
  purchaseOrderWrite,
  supplierWrite,
} from '../receipt/receipt-writes';
import { nameKey } from '../receipt/name-matching';
import { readTool, writeTool, type AssistantContext } from '../tool-kit';

/**
 * The receipt tools: match_receipt (a `readTool`), and create_purchase_order,
 * create_supplier, create_product (each a `writeTool` — previewed, then
 * committed with the confirmation token). See `../receipt/` for the matching.
 *
 * The schemas check shape only. Amounts are left as plain numbers, not
 * `.positive()`, so a zero quantity or a negative price reaches the service
 * and comes back as its own coded refusal — the one the office app gets —
 * rather than as the SDK's uncoded "invalid input".
 */

const numeric = z.union([z.number(), z.string()]);

/** Something with a letter or digit in it: "—" is not a name. */
const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => nameKey(v) !== '', 'must contain a letter or digit');

const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'an ISO 4217 code, such as CNY or AED');

const id = z.guid();

const newSupplier = z.object({
  name: name.describe('As printed on the receipt.'),
  country: z.string().trim().min(1).max(100),
  notes: z.string().trim().max(1000).optional(),
});

const newProduct = z.object({
  name: name,
  sku: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'The model or part code printed on the receipt, if any. Left out, a SKU is generated.',
    ),
  categoryId: id.optional(),
  description: z.string().trim().max(1000).optional(),
});

const extractionShape = {
  supplierName: z.string(),
  invoiceNumber: z.string().nullish(),
  date: z.string().nullish().describe('yyyy-mm-dd, as printed.'),
  currency: z.string().describe('ISO 4217 code.'),
  lines: z.array(
    z.object({
      description: z.string(),
      sku: z.string().nullish(),
      quantity: numeric,
      unitPrice: numeric,
      discountPercent: numeric.nullish().describe('Percent off, 0–100.'),
    }),
  ),
  charges: z
    .array(
      z.object({
        kind: z.enum(['shipping', 'fee', 'tax', 'other']),
        label: z.string(),
        amount: numeric,
      }),
    )
    .optional(),
  statedSubtotal: numeric.nullish(),
  statedTotal: numeric.nullish(),
};

const purchaseOrderShape = {
  cycleId: id
    .optional()
    .describe('The cycle a NEW order goes on. Give this or addToOrderId.'),
  addToOrderId: id
    .optional()
    .describe(
      'A DRAFT order from the same supplier to add these lines to, instead of a new order.',
    ),
  supplier: z
    .union([z.object({ id }), z.object({ new: newSupplier })])
    .describe('An existing supplier by id, or { new: {...} } to create one.'),
  currency,
  fxRateToEgp: z
    .number()
    .optional()
    .describe('EGP per unit of currency. Required for a new order.'),
  orderedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'yyyy-mm-dd')
    .optional()
    .describe('yyyy-mm-dd. Required for a new order; a draft keeps its own.'),
  supplierInvoiceRef: z
    .string()
    .trim()
    .max(SUPPLIER_INVOICE_REF_MAX)
    .optional()
    .describe("The supplier's own invoice number."),
  lines: z
    .array(
      z.object({
        product: z
          .union([z.object({ id }), z.object({ new: newProduct })])
          .describe(
            'An existing product by id, or { new: {...} } to create one.',
          ),
        quantity: z.number(),
        unitPrice: z
          .number()
          .describe('In the order currency. 0 for free goods.'),
        discountPercent: z.number().optional().describe('Percent off, 0–100.'),
      }),
    )
    .min(1),
};

function services(ctx: AssistantContext): ReceiptServices {
  // Resolved when a tool runs, not when it is registered: listing the tools
  // needs no database.
  return {
    prisma: ctx.resolve(PrismaService),
    purchases: ctx.resolve(PurchasesService),
    suppliers: ctx.resolve(SuppliersService),
    products: ctx.resolve(ProductsService),
    audit: ctx.resolve(AuditService),
  };
}

export function registerReceiptTools(
  server: McpServer,
  ctx: AssistantContext,
): void {
  const actor = ctx.user.id;

  readTool(
    server,
    'match_receipt',
    {
      title: 'Match a receipt',
      description:
        'Send what you read off a supplier receipt or invoice. Returns the supplier and product matches, ' +
        'arithmetic and duplicate-invoice checks, the FX rate on file, the cycles and draft orders it could go on, ' +
        'and `questions` — every point the partner must settle before create_purchase_order. Ask exactly those.',
      inputSchema: extractionShape,
    },
    async (extraction) => {
      const snapshot = await loadReceiptSnapshot(ctx.resolve(PrismaService));
      const analysis = analyzeReceipt(extraction, snapshot, new Date());
      const open = analysis.questions.filter((q) => q.blocking).length;
      return {
        summary: analysis.blocked
          ? `${open} question(s) must be answered before a purchase order can be previewed.`
          : analysis.questions.length
            ? 'Ready to preview; there are non-blocking points to mention.'
            : 'Everything matched. Ready to preview the purchase order.',
        data: analysis,
      };
    },
  );

  writeTool(
    server,
    ctx,
    'create_purchase_order',
    {
      title: 'Create a purchase order',
      description:
        'Records a receipt as a purchase order — or adds its lines to a draft order — with any new supplier and ' +
        'new products, all in one step: everything is created, or nothing is. Call without a confirmationToken ' +
        'to preview; nothing is saved until the partner confirms.',
      inputSchema: purchaseOrderShape,
    },
    {
      preview: (input) =>
        purchaseOrderWrite(services(ctx), input, actor, 'preview'),
      commit: (input) =>
        purchaseOrderWrite(services(ctx), input, actor, 'commit'),
    },
  );

  writeTool(
    server,
    ctx,
    'create_supplier',
    {
      title: 'Create a supplier',
      description:
        'Adds a supplier. Refused when one of that name already exists. Call without a confirmationToken to preview.',
      inputSchema: newSupplier.shape,
    },
    {
      preview: (input) => supplierWrite(services(ctx), input, actor, 'preview'),
      commit: (input) => supplierWrite(services(ctx), input, actor, 'commit'),
    },
  );

  writeTool(
    server,
    ctx,
    'create_product',
    {
      title: 'Create a product',
      description:
        'Adds a product, keeping the code printed on the receipt as its SKU. Refused when another product has ' +
        'that SKU. Call without a confirmationToken to preview.',
      inputSchema: newProduct.shape,
    },
    {
      preview: (input) => productWrite(services(ctx), input, actor, 'preview'),
      commit: (input) => productWrite(services(ctx), input, actor, 'commit'),
    },
  );
}
