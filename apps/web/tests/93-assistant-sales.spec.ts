/* eslint-disable @typescript-eslint/no-explicit-any -- API and MCP responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: the assistant records a sale (W3)
 * ═══════════════════════════════════════════════════════════════════════
 *  Plan docs/superpowers/plans/2026-10-11-walk-in-and-assistant-sales.md → W3.
 *  BUSINESS_LOGIC §4 (a walk-in sale is paid on the spot), §16 (the assistant
 *  can record a sale; close names are asked, never assumed; a confirmation
 *  binds what the preview showed).
 *
 *  As 72 and 83 do it: the partner signs Claude in through the real OAuth flow
 *  and the MCP SDK's own client calls record_sale over Streamable HTTP. Stock
 *  exists only through a cycle and a verified receipt (CLAUDE.md rule 4,
 *  `stockedProduct`); what the assistant wrote is read back through the
 *  office's own sales, payments and inventory endpoints.
 *
 *  Unit tests for the same cases: apps/api/src/modules/assistant/tools/sales.spec.ts.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { API, EMAIL, PASSWORD, apiCtx, stockedProduct } from './support/fixtures';
import { ROOT, codeFor, redeem } from './support/oauth-flow';

const MCP = `${ROOT}/mcp`;

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: {
    status?: string;
    confirmationToken?: string;
    data?: any;
    error?: { code: string; message: string };
  };
}

const codeOf = (r: ToolResult) => r.structuredContent?.error?.code;
const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');
const stamp = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;

let client: Client | undefined;

test.beforeAll(async ({ request }) => {
  const res = await redeem(request, await codeFor(request, EMAIL, PASSWORD));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  client = new Client({ name: 'claude-e2e-sales', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      requestInit: { headers: { Authorization: `Bearer ${res.body.access_token}` } },
    }),
  );
});

test.afterAll(async () => {
  await client?.close();
});

const sale = (args: Record<string, unknown>) =>
  client!.callTool({ name: 'record_sale', arguments: args }) as Promise<ToolResult>;

const commit = (args: Record<string, unknown>, shown: ToolResult) =>
  sale({ ...args, confirmationToken: shown.structuredContent!.confirmationToken });

/** A product with `qty` received into stock and B2C / B2B list prices. */
async function setup(request: APIRequestContext, label: string, qty = 40) {
  const { headers, mk } = await apiCtx(request);
  const { product } = await stockedProduct(request, headers, mk, `${label} ${stamp()}`, qty);
  await mk(`products/${product.id}/prices`, { channel: 'B2C', currency: 'EGP', amount: 350 });
  await mk(`products/${product.id}/prices`, { channel: 'B2B', currency: 'EGP', amount: 280 });
  return { headers, mk, product };
}

async function ordersOf(request: APIRequestContext, headers: any, productId: string) {
  const res = await request.get(`${API}/sales/orders?limit=100`, { headers });
  return ((await res.json()).data as any[]).filter((o) =>
    o.items.some((i: any) => i.productId === productId),
  );
}

async function saleable(request: APIRequestContext, headers: any, productId: string) {
  const res = await request.get(`${API}/inventory?productId=${productId}&limit=100`, { headers });
  const rows = ((await res.json()).data ?? []) as { batches?: { saleableQty: string }[] }[];
  return rows.flatMap((p) => p.batches ?? []).reduce((s, b) => s + Number(b.saleableQty), 0);
}

test.describe('record_sale (§16, 2026-10-11)', () => {
  test('TC-AS-01: "sold 25 at 300 to anyone" → a walk-in preview of 25 × 300 with stock shown; confirm writes one paid order', async ({ request }) => {
    const { headers, product } = await setup(request, 'AS01');
    const args = { walkIn: true, lines: [{ product: product.name, qty: 25, unitPrice: 300 }] };

    const shown = await sale(args);
    expect(shown.structuredContent?.status, text(shown)).toBe('preview');
    expect(shown.structuredContent?.data).toMatchObject({
      walkIn: true,
      total: '7500.00',
      statusAfter: 'PAID',
      payment: { method: 'CASH', amount: '7500.00' },
    });
    expect(shown.structuredContent?.data.lines[0]).toMatchObject({ qty: '25', unitPrice: '300.00', available: '40' });
    expect(text(shown)).toContain('Paid on the spot by CASH');
    expect(await ordersOf(request, headers, product.id)).toHaveLength(0);

    const done = await commit(args, shown);
    expect(done.structuredContent?.status, text(done)).toBe('committed');

    const orders = await ordersOf(request, headers, product.id);
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('PAID');
    expect(Number(orders[0].outstanding)).toBe(0);
    expect(orders[0].customer.isWalkIn).toBe(true);
    const detail = await (await request.get(`${API}/sales/orders/${orders[0].id}`, { headers })).json();
    expect(detail.data.paymentAllocations).toHaveLength(1);
    expect(await saleable(request, headers, product.id)).toBe(15);
  });

  test('TC-AS-02: a close product name → candidates, nothing written, no token', async ({ request }) => {
    const { headers, product } = await setup(request, 'AS02');
    const r = await sale({ walkIn: true, lines: [{ product: `${product.name}s (front)`, qty: 1, unitPrice: 300 }] });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.status).toBe('needs_answers');
    expect(r.structuredContent?.confirmationToken).toBeUndefined();
    const q = r.structuredContent?.data.questions[0];
    expect(q.kind).toBe('LINE_WHICH');
    expect(q.options.map((o: any) => o.value)).toContain(product.id);
    expect(await ordersOf(request, headers, product.id)).toHaveLength(0);
  });

  test('TC-AS-03: an unknown customer name → a question, not a new customer', async ({ request }) => {
    const { headers, product } = await setup(request, 'AS03');
    const name = `Nobody Motors ${stamp()}`;
    const r = await sale({ customer: name, lines: [{ product: product.name, qty: 1, unitPrice: 300 }] });

    expect(r.structuredContent?.status).toBe('needs_answers');
    expect(r.structuredContent?.data.questions[0].kind).toBe('CUSTOMER_UNKNOWN');
    const list = await (await request.get(`${API}/customers?limit=100&search=Nobody`, { headers })).json();
    expect(list.data.filter((c: any) => c.displayName === name)).toHaveLength(0);
  });

  test('TC-AS-04: no price → the preview offers the list price and marks it', async ({ request }) => {
    const { product } = await setup(request, 'AS04');
    const r = await sale({ walkIn: true, lines: [{ product: product.name, qty: 2 }] });

    expect(r.structuredContent?.data.lines[0]).toMatchObject({
      unitPrice: '350.00',
      priceSource: 'list',
      note: 'list price — confirm or give the price',
    });
  });

  test('TC-AS-05: more than in stock → NOT_ENOUGH_STOCK in the preview', async ({ request }) => {
    const { product } = await setup(request, 'AS05', 5);
    const r = await sale({ walkIn: true, lines: [{ product: product.name, qty: 6, unitPrice: 300 }] });
    expect(codeOf(r)).toBe('NOT_ENOUGH_STOCK');
  });

  test('TC-AS-06: stock sold elsewhere between preview and confirm → PREVIEW_CHANGED; nothing written', async ({ request }) => {
    const { headers, mk, product } = await setup(request, 'AS06');
    const args = { walkIn: true, lines: [{ product: product.name, qty: 25, unitPrice: 300 }] };
    const shown = await sale(args);

    // The office sells 5 meanwhile — still enough, but not what was shown.
    await mk('sales/orders', {
      walkIn: true, currency: 'EGP', items: [{ productId: product.id, quantity: 5, unitPrice: 300 }],
    });

    const r = await commit(args, shown);
    expect(['PREVIEW_CHANGED', 'NOT_ENOUGH_STOCK']).toContain(codeOf(r));
    expect(await ordersOf(request, headers, product.id)).toHaveLength(1);
  });

  test('TC-AS-07: replay → CONFIRMATION_USED; one order', async ({ request }) => {
    const { headers, product } = await setup(request, 'AS07');
    const args = { walkIn: true, lines: [{ product: product.name, qty: 1, unitPrice: 300 }] };
    const shown = await sale(args);
    await commit(args, shown);

    const again = await commit(args, shown);
    expect(codeOf(again)).toBe('CONFIRMATION_USED');
    expect(await ordersOf(request, headers, product.id)).toHaveLength(1);
  });

  test('TC-AS-08: a named customer → a CONFIRMED order that is owed, no payment', async ({ request }) => {
    const { headers, mk, product } = await setup(request, 'AS08');
    const shop = await mk('customers', { displayName: `AS08 Shop ${stamp()}`, type: 'B2B' });
    const args = { customer: shop.displayName, lines: [{ product: product.name, qty: 2, unitPrice: 290 }] };

    const shown = await sale(args);
    expect(shown.structuredContent?.data).toMatchObject({ statusAfter: 'CONFIRMED', payment: null });
    await commit(args, shown);

    const [order] = await ordersOf(request, headers, product.id);
    expect(order.status).toBe('CONFIRMED');
    expect(order.customerId).toBe(shop.id);
    expect(Number(order.outstanding)).toBe(580);
    const payments = await (await request.get(`${API}/payments?customerId=${shop.id}&limit=100`, { headers })).json();
    expect(payments.data).toHaveLength(0);
  });

  test('TC-AS-09: tools/list has record_sale and record_payment and still no return, settlement or reversal tool', async () => {
    const { tools } = await client!.listTools();
    const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    expect(writes).toContain('record_sale');
    // record_payment added 2026-10-11 (I2), approved by the owner (§16).
    // record_lender_repayment added 2026-10-11 (L2): repaying a friend in pounds (§18).
    expect(writes.filter((n) => /sale|payment|instal|settle|return|refund|ledger/i.test(n)).sort()).toEqual([
      'record_lender_repayment',
      'record_payment',
      'record_sale',
    ]);
  });
});
