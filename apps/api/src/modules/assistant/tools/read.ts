import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CycleStatus } from '@prisma/client';
import { isUUID } from 'class-validator';
import { z } from 'zod';

import { notFound } from '../../../common/api-error';
import { pageSize } from '../../../common/dto/pagination.dto';
import { AnalyticsService } from '../../analytics/analytics.service';
import { CurrencyRatesService } from '../../currency-rates/currency-rates.service';
import { CustomersService } from '../../customers/customers.service';
import { CyclesService } from '../../cycles/cycles.service';
import { InventoryService } from '../../inventory/inventory.service';
import { PaymentPlansService } from '../../payment-plans/payment-plans.service';
import { PaymentsService } from '../../payments/payments.service';
import { priceOn } from '../../portal/portal-pricing';
import { ProductsService } from '../../products/products.service';
import { SalesService } from '../../sales/sales.service';
import { SuppliersService } from '../../suppliers/suppliers.service';
import { readTool, type AssistantContext, type ToolOutcome } from '../tool-kit';

/**
 * The read tools: find_suppliers, find_products, list_cycles, get_cycle,
 * get_stock, list_sales, get_customer, list_payments, get_dashboard,
 * get_fx_rates.
 *
 * Each calls the service method the office app's controller calls and only
 * reshapes what comes back — it never queries for a figure of its own. A
 * balance or an arrival date worked out a second time here is a second
 * definition, and the day the service's rule changes this one would not
 * (CLAUDE.md rule 11). The tests pin that for the balance and the dates.
 */

/**
 * The largest page a read tool returns. Lower than the API's own cap: every
 * row lands in the model's context, and a partner asking a question in a chat
 * wants the first screenful, not a table.
 */
export const ASSISTANT_MAX_ROWS = 50;

/** Same reading of a requested size as every list endpoint, then capped. */
function rows(limit: number | undefined): number {
  return Math.min(pageSize(limit), ASSISTANT_MAX_ROWS);
}

const limitField = z
  .number()
  .optional()
  .describe(
    `How many rows to return. Default 20, at most ${ASSISTANT_MAX_ROWS}; a larger number is capped.`,
  );

const dayField = (what: string) =>
  z
    .string()
    .optional()
    .describe(`${what}, as YYYY-MM-DD. Both ends of the range are included.`);

/**
 * Every cycle status, checked against the schema's enum at compile time: a
 * status added to the schema and not here fails the build rather than
 * becoming a value the tool silently cannot filter by.
 */
const CYCLE_STATUSES = [
  'PLANNING',
  'FUNDING',
  'PURCHASING',
  'IN_TRANSIT',
  'ARRIVED_UAE',
  'IN_TRANSIT_TO_EGYPT',
  'ARRIVED_EGYPT',
  'VERIFICATION',
  'SELLING',
  'SETTLEMENT',
  'CLOSED',
  'CANCELLED',
] as const satisfies readonly CycleStatus[];
type MissingStatus = Exclude<CycleStatus, (typeof CYCLE_STATUSES)[number]>;
const _everyStatus: [MissingStatus] extends [never] ? true : MissingStatus =
  true;
void _everyStatus;

type Decimalish = { toString(): string } | number | string | null | undefined;

/** Money and quantities go out as the exact decimal string the database holds. */
function dec(value: Decimalish): string | null {
  return value === null || value === undefined ? null : value.toString();
}

/** A `@db.Date` column: the calendar day, not a midnight instant. */
function day(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function instant(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

/**
 * The answer, with its facts in the text.
 *
 * A client that ignores `structuredContent` — and several do — would otherwise
 * give the model the headline and nothing to answer from.
 */
function answer(headline: string, data: unknown): ToolOutcome {
  return { summary: `${headline}\n${JSON.stringify(data)}`, data };
}

/**
 * A search box: surrounding space ignored, and nothing typed means no filter.
 * An empty search lists the first page rather than refusing, which is what the
 * same box does in the office app.
 */
function searchTerm(value: string | undefined): string | undefined {
  const term = value?.trim();
  return term ? term : undefined;
}

/**
 * An id that is not a uuid identifies nothing. Refused as not found here
 * rather than handed to Postgres, which rejects it as a malformed uuid — and
 * that reaches the partner as an unexpected error instead of "no such thing".
 */
function assertId(
  value: string | undefined,
  entity: string,
): string | undefined {
  if (value === undefined) return undefined;
  const id = value.trim();
  if (!isUUID(id)) throw notFound(entity);
  return id;
}

export function registerReadTools(
  server: McpServer,
  ctx: AssistantContext,
): void {
  readTool(
    server,
    'find_suppliers',
    {
      title: 'Find suppliers',
      description:
        'Search suppliers by name or country (case-insensitive, part of a word is enough). Returns id, name, country, and how many products and purchase orders each has. Use it to find a supplier id before looking at their orders, or to check whether a supplier already exists before suggesting a new one.',
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe(
            'Part of the name or country. Leave out to list suppliers alphabetically.',
          ),
        limit: limitField,
      },
    },
    async ({ search, limit }) => {
      const res = await ctx.resolve(SuppliersService).findAll({
        search: searchTerm(search),
        limit: rows(limit),
      });
      const data = res.data.map((s) => ({
        id: s.id,
        name: s.name,
        country: s.country,
        products: s._count.products,
        purchaseOrders: s._count.purchaseOrders,
      }));
      return answer(
        `${data.length} supplier(s)${res.meta.nextCursor ? ', more exist — narrow the search' : ''}.`,
        data,
      );
    },
  );

  readTool(
    server,
    'find_products',
    {
      title: 'Find products',
      description:
        'Search products by name or SKU (case-insensitive, part of either is enough — "prd-00" finds PRD-000012). Returns id, SKU, name, status, category, the current B2B and B2C selling prices (null when none is set), and stock: total on hand, reserved, and available to sell. Use it to answer "do we have X", "what does X sell for", or to find a product id.',
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe(
            'Part of the product name or SKU. Leave out to list the newest products.',
          ),
        limit: limitField,
      },
    },
    async ({ search, limit }) => {
      const res = await ctx.resolve(ProductsService).findAll({
        search: searchTerm(search),
        limit: rows(limit),
      });
      const inventory = ctx.resolve(InventoryService);
      const data = await Promise.all(
        res.data.map(async (p) => {
          const [stock] = (await inventory.getStock({ productId: p.id }))
            .data as StockLine[];
          return {
            id: p.id,
            sku: p.sku,
            name: p.name,
            status: p.status,
            category: p.category?.name ?? null,
            prices: {
              B2B: dec(priceOn(p.prices, 'B2B')),
              B2C: dec(priceOn(p.prices, 'B2C')),
            },
            stock: {
              total: stock?.totalStock ?? 0,
              reserved: stock?.reservedStock ?? 0,
              available: stock?.availableStock ?? 0,
            },
          };
        }),
      );
      return answer(
        `${data.length} product(s)${res.meta.nextCursor ? ', more exist — narrow the search' : ''}.`,
        data,
      );
    },
  );

  readTool(
    server,
    'list_cycles',
    {
      title: 'List import cycles',
      description:
        'List import cycles, newest first, optionally only those in one status. Returns id, code, status, origin (CHINA or UAE_DIRECT), currency, start date and how many purchase orders, shipping legs and participants each has. Use get_cycle for the detail of one.',
      inputSchema: {
        status: z
          .enum(CYCLE_STATUSES)
          .optional()
          .describe('Only cycles in this status.'),
        limit: limitField,
      },
    },
    async ({ status, limit }) => {
      const res = await ctx
        .resolve(CyclesService)
        .findAll({ status, limit: rows(limit) });
      const data = res.data.map((c) => ({
        id: c.id,
        code: c.code,
        status: c.status,
        originType: c.originType,
        currency: c.currency,
        startedOn: day(c.startedOn),
        purchaseOrders: c.purchaseOrders.length,
        shippingLegs: c.shippingLegs.length,
        participants: c.participants.length,
      }));
      return answer(
        `${data.length} cycle(s)${res.meta.nextCursor ? ', more exist' : ''}.`,
        data,
      );
    },
  );

  readTool(
    server,
    'get_cycle',
    {
      title: 'Get one cycle',
      description:
        'One import cycle by its code (e.g. CYC-2026-0003, any case) or its id. Returns status, origin, currency, dates, participants with their contributions, purchase orders with supplier and lines, shipping legs in order with departure and arrival dates and cost, and how many stock batches were received. Refuses with NOT_FOUND when no cycle has that code or id.',
      inputSchema: {
        cycle: z
          .string()
          .describe('The cycle code as the partner said it, or its id.'),
      },
    },
    async ({ cycle: ref }) => {
      const { data: c } = await ctx.resolve(CyclesService).findByRef(ref);
      const data = {
        id: c.id,
        code: c.code,
        status: c.status,
        originType: c.originType,
        currency: c.currency,
        startedOn: day(c.startedOn),
        closedOn: day(c.closedOn),
        participants: c.participants.map((p) => {
          const user = p.partner ?? p.investor;
          return {
            type: p.participantType,
            name: user?.partner?.displayName ?? user?.email ?? null,
            contribution: dec(p.contributionAmount),
            customProfitPct: dec(p.customProfitPct),
            investorFeePct: dec(p.investorFeePct),
          };
        }),
        purchaseOrders: c.purchaseOrders.map((po) => ({
          id: po.id,
          reference: po.reference,
          supplier: po.supplier.name,
          supplierInvoiceRef: po.supplierInvoiceRef,
          status: po.status,
          orderedOn: day(po.orderedOn),
          currency: po.currency,
          fxRateToEgp: dec(po.fxRateToEgp),
          lines: po.items.map((i) => ({
            sku: i.product.sku,
            product: i.product.name,
            orderedQty: dec(i.orderedQty),
            unitPrice: dec(i.unitPrice),
            discount: dec(i.discount),
            lineTotal: dec(i.lineTotal),
            receivedQty: dec(i.receivedQty),
          })),
        })),
        shippingLegs: [...c.shippingLegs]
          .sort((a, b) => a.sequence - b.sequence)
          .map((l) => ({
            sequence: l.sequence,
            origin: l.origin,
            destination: l.destination,
            provider: l.provider,
            status: l.status,
            departedOn: instant(l.departedOn),
            arrivedOn: instant(l.arrivedOn),
            amount: dec(l.amount),
            currency: l.currency,
            amountEgp: dec(l.amountEgp),
          })),
        stockBatches: c.inventoryBatches.length,
        settlements: c.settlements.length,
      };
      return answer(`Cycle ${c.code}, ${c.status}.`, data);
    },
  );

  readTool(
    server,
    'get_stock',
    {
      title: 'Get stock',
      description:
        "Stock on hand per product, with each batch: which cycle it came from, quantities received, remaining, reserved and available to sell, landed unit cost in EGP, and two dates — arrivedOn (when the shipment landed in Egypt: the cycle's last dated shipping leg; null when nobody dated it) and receivedAt (when it was verified into stock and became sellable). They are usually days apart. Filter by product id, by cycle (code or id), or leave both out for everything.",
      inputSchema: {
        productId: z
          .string()
          .optional()
          .describe(
            'Only this product (its id — use find_products to get it).',
          ),
        cycle: z
          .string()
          .optional()
          .describe('Only stock from this cycle, by code or id.'),
      },
    },
    async ({ productId, cycle }) => {
      const product = assertId(productId, 'product');
      const cycleId = cycle
        ? (await ctx.resolve(CyclesService).findByRef(cycle)).data.id
        : undefined;
      const res = await ctx
        .resolve(InventoryService)
        .getStock({ productId: product, cycleId });
      const lines = res.data as StockLine[];
      const data = lines.map((p) => ({
        productId: p.productId,
        product: p.productName,
        total: p.totalStock,
        reserved: p.reservedStock,
        available: p.availableStock,
        batches: p.batches.map((b) => ({
          batchId: b.id,
          cycle: b.cycle?.code ?? null,
          receivedQty: dec(b.receivedQty),
          remainingQty: dec(b.remainingQty),
          reservedQty: dec(b.reservedQty),
          saleableQty: dec(b.saleableQty),
          landedUnitCostEgp: dec(b.landedUnitCostEgp),
          arrivedOn: instant(b.arrivedOn),
          receivedAt: instant(b.receivedAt),
        })),
      }));
      return answer(`${data.length} product(s) in stock.`, data);
    },
  );

  readTool(
    server,
    'list_sales',
    {
      title: 'List sales',
      description:
        'Sale orders, newest first, optionally for one customer and/or between two days (the day it was ordered, in Cairo time). Returns order number, customer, channel, status, currency, total, discount, what is still outstanding, when it was ordered, and its lines. A DRAFT is not a sale and owes nothing. Refuses DATE_RANGE_REVERSED when from is after to.',
      inputSchema: {
        customerId: z
          .string()
          .optional()
          .describe(
            'Only this customer (its id — use get_customer to find it by name).',
          ),
        from: dayField('Earliest order day'),
        to: dayField('Latest order day'),
        limit: limitField,
      },
    },
    async ({ customerId, from, to, limit }) => {
      const res = await ctx.resolve(SalesService).findAll({
        customerId: assertId(customerId, 'customer'),
        from,
        to,
        limit: rows(limit),
      });
      const data = res.data.map((o) => ({
        id: o.id,
        orderNo: o.orderNo,
        customer: o.customer.displayName,
        customerId: o.customerId,
        channel: o.channel,
        status: o.status,
        currency: o.currency,
        total: dec(o.total),
        discount: dec(o.discount),
        outstanding: dec(o.outstanding),
        orderedAt: instant(o.orderedAt),
        lines: o.items.map((i) => ({
          sku: i.product.sku,
          product: i.product.name,
          quantity: dec(i.quantity),
          unitPrice: dec(i.unitPrice),
          discount: dec(i.discount),
        })),
      }));
      return answer(
        `${data.length} sale order(s)${res.meta.nextCursor ? ', more exist — narrow the range' : ''}.`,
        data,
      );
    },
  );

  readTool(
    server,
    'get_customer',
    {
      title: 'Get a customer',
      description:
        "One customer (a shop or a person) by id or by name. Returns their details, their balance — what they owe across confirmed and partly paid orders, the same figure the office app shows and enforces when a payment is taken — the orders still open, and their payment plans with each instalment's state. When a name matches several customers, returns the candidates instead; ask the partner which one.",
      inputSchema: {
        customer: z
          .string()
          .describe(
            "The customer's id, or part of their name, phone or email.",
          ),
      },
    },
    async ({ customer: ref }) => {
      const customers = ctx.resolve(CustomersService);
      const key = ref.trim();
      let id: string;
      if (isUUID(key)) {
        id = key;
      } else {
        const term = searchTerm(key);
        if (!term) throw notFound('customer');
        const found = await customers.findAll({
          search: term,
          verification: 'ALL',
          limit: 10,
        });
        const exact = found.data.filter(
          (c) => c.displayName.toLowerCase() === term.toLowerCase(),
        );
        const pick = exact.length === 1 ? exact : found.data;
        if (pick.length === 0) throw notFound('customer');
        if (pick.length > 1) {
          const candidates = pick.map((c) => ({
            id: c.id,
            name: c.displayName,
            phone: c.phone,
            type: c.type,
          }));
          return answer(
            `${candidates.length} customers match "${term}". Ask the partner which one, then call get_customer with its id.`,
            { candidates },
          );
        }
        id = pick[0].id;
      }

      const { data: c } = await customers.findById(id);
      const sales = ctx.resolve(SalesService);
      const [confirmed, partlyPaid, plans] = await Promise.all([
        sales.findAll({
          customerId: id,
          status: 'CONFIRMED',
          limit: ASSISTANT_MAX_ROWS,
        }),
        sales.findAll({
          customerId: id,
          status: 'PARTIALLY_PAID',
          limit: ASSISTANT_MAX_ROWS,
        }),
        ctx
          .resolve(PaymentPlansService)
          .findAll({ customerId: id, limit: ASSISTANT_MAX_ROWS }),
      ]);
      const openOrders = [...confirmed.data, ...partlyPaid.data]
        .sort((a, b) => a.orderedAt.getTime() - b.orderedAt.getTime())
        .map((o) => ({
          id: o.id,
          orderNo: o.orderNo,
          status: o.status,
          total: dec(o.total),
          outstanding: dec(o.outstanding),
          orderedAt: instant(o.orderedAt),
        }));

      const data = {
        id: c.id,
        name: c.displayName,
        type: c.type,
        phone: c.phone,
        email: c.email,
        verificationStatus: c.verificationStatus,
        balance: c.outstandingBalance,
        openOrders,
        paymentPlans: plans.data.map((p) => ({
          reference: p.reference,
          status: p.status,
          agreedOn: day(p.agreedOn),
          totalEgp: dec(p.totalEgp),
          paidEgp: dec(p.paidEgp),
          remainingEgp: dec(p.remainingEgp),
          overdueEgp: dec(p.overdueEgp),
          isOverdue: p.isOverdue,
          nextDueOn: day(p.nextDueOn),
          instalments: p.instalments.map((i) => ({
            sequence: i.sequence,
            dueOn: day(i.dueOn),
            amount: dec(i.amount),
            outstandingEgp: dec(i.outstandingEgp),
            state: i.state,
          })),
        })),
      };
      return answer(`${c.displayName} owes ${c.outstandingBalance} EGP.`, data);
    },
  );

  readTool(
    server,
    'list_payments',
    {
      title: 'List payments',
      description:
        'Payments received from customers, newest first, optionally for one customer and/or between two days (the day the money was received). Returns amount, currency, the day received, method, reference, status (RECORDED or REVERSED) and how it was allocated to orders. Refuses DATE_RANGE_REVERSED when from is after to.',
      inputSchema: {
        customerId: z
          .string()
          .optional()
          .describe(
            'Only this customer (its id — use get_customer to find it by name).',
          ),
        from: dayField('Earliest day received'),
        to: dayField('Latest day received'),
        limit: limitField,
      },
    },
    async ({ customerId, from, to, limit }) => {
      const res = await ctx.resolve(PaymentsService).findAll({
        customerId: assertId(customerId, 'customer'),
        from,
        to,
        limit: rows(limit),
      });
      const data = res.data.map((p) => ({
        id: p.id,
        customer: p.customer.displayName,
        customerId: p.customerId,
        amount: dec(p.amount),
        currency: p.currency,
        receivedOn: day(p.receivedOn),
        method: p.method,
        reference: p.reference,
        status: p.status,
        allocations: p.allocations.map((a) => ({
          saleOrderId: a.saleOrderId,
          amount: dec(a.amount),
        })),
      }));
      return answer(
        `${data.length} payment(s)${res.meta.nextCursor ? ', more exist — narrow the range' : ''}.`,
        data,
      );
    },
  );

  readTool(
    server,
    'get_dashboard',
    {
      title: 'Get the dashboard',
      description:
        'The office dashboard\'s figures, in EGP: revenue, cost of goods sold, operating expenses, net profit, cash in, cash out and cash on hand, what has been collected, receivables (what customers owe), inventory value at landed cost, active cycles, low-stock alerts, and customer and product counts. Use it for "how are we doing" questions.',
      inputSchema: {},
    },
    async () => {
      const { data } = await ctx.resolve(AnalyticsService).getDashboardKPIs();
      return answer('Dashboard figures, EGP.', data);
    },
  );

  readTool(
    server,
    'get_fx_rates',
    {
      title: 'Get FX rates',
      description:
        'The stored exchange rates to EGP, one per currency, with when each was last set. A rate of null means nobody has entered one. These prefill new documents; every purchase order and shipping leg keeps the rate it was agreed at.',
      inputSchema: {},
    },
    async () => {
      const { data: rates } = await ctx.resolve(CurrencyRatesService).findAll();
      const data = rates.map((r) => ({
        code: r.code,
        rateToEgp: dec(r.rateToEgp),
        updatedAt: instant(r.updatedAt),
      }));
      return answer(`${data.length} currencies.`, data);
    },
  );
}

/** What `InventoryService.getStock` returns per product — read, never recomputed. */
interface StockLine {
  productId: string;
  productName: string;
  totalStock: number;
  reservedStock: number;
  availableStock: number;
  batches: Array<{
    id: string;
    cycle?: { code: string } | null;
    receivedQty: Decimalish;
    remainingQty: Decimalish;
    reservedQty: Decimalish;
    saleableQty: Decimalish;
    landedUnitCostEgp: Decimalish;
    arrivedOn: Date | null;
    receivedAt: Date;
  }>;
}
