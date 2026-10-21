/* eslint-disable @typescript-eslint/no-explicit-any -- API and MCP responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: the assistant handles samples at shops
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §4 "Samples at shops" (owner 2026-10-18), §16 (the
 *  assistant): leave_samples, list_samples, complete_samples_sale,
 *  return_samples, write_off_samples — each the office endpoint's own service
 *  call, previewed by rolling it back and committed with the token.
 *
 *  As 93 does it: the partner signs Claude in through the real OAuth flow and
 *  the MCP SDK's own client calls the tools over Streamable HTTP. Stock exists
 *  only through a cycle and a verified receipt (CLAUDE.md rule 4,
 *  `stockedProduct`); what the assistant wrote is read back through the
 *  office's own sales and inventory endpoints.
 *
 *  Unit tests for the same cases, against Postgres:
 *  apps/api/src/modules/assistant/tools/samples.db.spec.ts.
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
    error?: { code: string; message: string; params?: any };
  };
}

const codeOf = (r: ToolResult) => r.structuredContent?.error?.code;
const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');
const stamp = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;

let client: Client | undefined;

test.beforeAll(async ({ request }) => {
  const res = await redeem(request, await codeFor(request, EMAIL, PASSWORD));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  client = new Client({ name: 'claude-e2e-samples', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      requestInit: { headers: { Authorization: `Bearer ${res.body.access_token}` } },
    }),
  );
});

test.afterAll(async () => {
  await client?.close();
});

const tool = (name: string, args: Record<string, unknown>) =>
  client!.callTool({ name, arguments: args }) as Promise<ToolResult>;

/** Preview, then commit with that preview's token. */
async function confirmed(name: string, args: Record<string, unknown>) {
  const shown = await tool(name, args);
  expect(shown.structuredContent?.status, text(shown)).toBe('preview');
  const done = await tool(name, { ...args, confirmationToken: shown.structuredContent!.confirmationToken });
  expect(done.structuredContent?.status, text(done)).toBe('committed');
  return { shown, done };
}

/** A product with `qty` received into stock, and a shop to leave samples with. */
async function setup(request: APIRequestContext, label: string, qty = 10) {
  const { headers, mk } = await apiCtx(request);
  const { product } = await stockedProduct(request, headers, mk, `${label} ${stamp()}`, qty);
  const shop = await mk('customers', { displayName: `${label} Shop ${stamp()}`, type: 'B2B' });
  return { headers, mk, product, shop };
}

async function ordersOf(request: APIRequestContext, headers: any, customerId: string) {
  const res = await request.get(`${API}/sales/orders?customerId=${customerId}&limit=100`, { headers });
  return (await res.json()).data as any[];
}

async function saleable(request: APIRequestContext, headers: any, productId: string) {
  const res = await request.get(`${API}/inventory?productId=${productId}&limit=100`, { headers });
  const rows = ((await res.json()).data ?? []) as { batches?: { saleableQty: string }[] }[];
  return rows.flatMap((p) => p.batches ?? []).reduce((s, b) => s + Number(b.saleableQty), 0);
}

/** Samples of `qty` left with the shop through the assistant; the order as the office lists it. */
async function leave(request: APIRequestContext, label: string, qty: number, stock = 10) {
  const ctx = await setup(request, label, stock);
  const { done } = await confirmed('leave_samples', {
    customer: ctx.shop.displayName,
    lines: [{ product: ctx.product.name, qty, unitPrice: 300 }],
  });
  return { ...ctx, orderNo: done.structuredContent!.data.orderNo as string, orderId: done.structuredContent!.data.orderId as string };
}

test.describe('samples at shops through the assistant (§4, §16)', () => {
  test('TC-ASM-01: "left 5 with <shop>" → preview writes nothing; confirm leaves a SAMPLES order the office lists, owed nothing', async ({ request }) => {
    const { headers, product, shop } = await setup(request, 'ASM01');
    const args = { customer: shop.displayName, lines: [{ product: product.name, qty: 5, unitPrice: 300 }] };

    const shown = await tool('leave_samples', args);
    expect(shown.structuredContent?.status, text(shown)).toBe('preview');
    expect(shown.structuredContent?.data).toMatchObject({ total: '0.00', statusAfter: 'SAMPLES' });
    expect(shown.structuredContent?.data.lines[0]).toMatchObject({ qty: '5', notedPrice: '300.00', available: '10' });
    expect(await ordersOf(request, headers, shop.id)).toHaveLength(0);
    expect(await saleable(request, headers, product.id)).toBe(10);

    await tool('leave_samples', { ...args, confirmationToken: shown.structuredContent!.confirmationToken });
    const [order] = await ordersOf(request, headers, shop.id);
    expect(order.status).toBe('SAMPLES');
    expect(Number(order.outstanding)).toBe(0);
    expect(order.samples.unitsOut).toBe('5');
    expect(await saleable(request, headers, product.id)).toBe(5);
  });

  test('TC-ASM-02: list_samples shows the order per shop and per product', async ({ request }) => {
    const { shop, product, orderNo } = await leave(request, 'ASM02', 3);
    const r = await tool('list_samples', { customerId: shop.id });
    expect(r.structuredContent?.data).toMatchObject({
      totalUnits: '3',
      byShop: [{ customerId: shop.id, units: '3' }],
      byProduct: [{ productId: product.id, units: '3' }],
    });
    expect(r.structuredContent?.data.orders[0].orderNo).toBe(orderNo);
  });

  test('TC-ASM-03: "they bought 3 of the 5" → a CONFIRMED sale in place, owed; 2 back on the shelf', async ({ request }) => {
    const { headers, product, shop, orderNo, orderId } = await leave(request, 'ASM03', 5);
    const { shown } = await confirmed('complete_samples_sale', { order: orderNo, lines: [{ product: product.name, qty: 3 }] });
    expect(shown.structuredContent?.data.lines[0]).toMatchObject({ unitPrice: '300.00', priceSource: 'noted' });
    expect(shown.structuredContent?.data.products[0]).toMatchObject({ out: '5', kept: '3', back: '2' });

    const [order] = await ordersOf(request, headers, shop.id);
    expect(order.id).toBe(orderId);
    expect(order.orderNo).toBe(orderNo);
    expect(order.status).toBe('CONFIRMED');
    expect(Number(order.outstanding)).toBe(900);
    expect(await saleable(request, headers, product.id)).toBe(7);
  });

  test('TC-ASM-04: returned → all back; deciding again is SAMPLES_ALREADY_DECIDED', async ({ request }) => {
    const { headers, product, orderNo } = await leave(request, 'ASM04', 4);
    await confirmed('return_samples', { order: orderNo });
    expect(await saleable(request, headers, product.id)).toBe(10);

    expect(codeOf(await tool('return_samples', { order: orderNo }))).toBe('SAMPLES_ALREADY_DECIDED');
    expect(codeOf(await tool('write_off_samples', { order: orderNo }))).toBe('SAMPLES_ALREADY_DECIDED');
    expect(codeOf(await tool('complete_samples_sale', { order: orderNo }))).toBe('SAMPLES_ALREADY_DECIDED');
  });

  test('TC-ASM-05: write off → the cost is shown, the order ends SAMPLES_WRITTEN_OFF, nothing comes back', async ({ request }) => {
    const { headers, product, shop, orderNo } = await leave(request, 'ASM05', 2);
    const { shown } = await confirmed('write_off_samples', { order: orderNo, reason: 'the shop kept them' });
    expect(Number(shown.structuredContent?.data.costEgp)).toBeGreaterThan(0);
    const [order] = await ordersOf(request, headers, shop.id);
    expect(order.status).toBe('SAMPLES_WRITTEN_OFF');
    expect(await saleable(request, headers, product.id)).toBe(8);
  });

  test('TC-ASM-06: a walk-in, no shop, more than in stock, zero → refused with their codes; nothing written', async ({ request }) => {
    const { headers, product, shop } = await setup(request, 'ASM06', 3);
    const line = (qty: number) => [{ product: product.name, qty }];
    expect(codeOf(await tool('leave_samples', { walkIn: true, lines: line(1) }))).toBe('SAMPLES_NEED_SHOP');
    expect(codeOf(await tool('leave_samples', { lines: line(1) }))).toBe('CUSTOMER_REQUIRED');
    expect(codeOf(await tool('leave_samples', { customer: shop.displayName, lines: line(4) }))).toBe('NOT_ENOUGH_STOCK');
    expect(codeOf(await tool('leave_samples', { customer: shop.displayName, lines: line(0) }))).toBe('QTY_NOT_POSITIVE');
    expect(codeOf(await tool('leave_samples', { customer: shop.displayName, lines: line(-1) }))).toBe('QTY_NOT_POSITIVE');
    expect(await ordersOf(request, headers, shop.id)).toHaveLength(0);
    expect(await saleable(request, headers, product.id)).toBe(3);
  });

  test('TC-ASM-07: returning more than was left, or only part → refused; still at the shop', async ({ request }) => {
    const { headers, product, shop, orderNo } = await leave(request, 'ASM07', 4);
    const more = await tool('return_samples', { order: orderNo, returned: [{ product: product.name, qty: 5 }] });
    expect(codeOf(more)).toBe('SAMPLES_RETURN_MORE_THAN_OUT');
    const part = await tool('return_samples', { order: orderNo, returned: [{ product: product.name, qty: 1 }] });
    expect(codeOf(part)).toBe('SAMPLES_RETURN_NOT_ALL');
    const [order] = await ordersOf(request, headers, shop.id);
    expect(order.status).toBe('SAMPLES');
    expect(await saleable(request, headers, product.id)).toBe(6);
  });

  test('TC-ASM-08: buying more than went out with an empty shelf → SAMPLES_EXTRA_NOT_IN_STOCK', async ({ request }) => {
    const { product, orderNo } = await leave(request, 'ASM08', 4, 4);
    const r = await tool('complete_samples_sale', { order: orderNo, lines: [{ product: product.name, qty: 6, unitPrice: 300 }] });
    expect(codeOf(r)).toBe('SAMPLES_EXTRA_NOT_IN_STOCK');
  });

  test('TC-ASM-09: an ordinary sale → NOT_SAMPLES; an order that does not exist → NOT_FOUND', async ({ request }) => {
    const { mk, product, shop } = await setup(request, 'ASM09', 5);
    const sale = await mk('sales/orders', {
      customerId: shop.id, channel: 'B2B', currency: 'EGP', confirm: true,
      items: [{ productId: product.id, quantity: 1, unitPrice: 200 }],
    });
    expect(codeOf(await tool('return_samples', { order: sale.orderNo }))).toBe('NOT_SAMPLES');
    expect(codeOf(await tool('write_off_samples', { order: sale.id }))).toBe('NOT_SAMPLES');
    expect(codeOf(await tool('return_samples', { order: 'ORD-1999-99999' }))).toBe('NOT_FOUND');
    expect(codeOf(await tool('complete_samples_sale', { order: '00000000-0000-4000-8000-000000000000' }))).toBe('NOT_FOUND');
  });

  test('TC-ASM-10: the same token twice → CONFIRMATION_USED; one return', async ({ request }) => {
    const { headers, product, orderNo } = await leave(request, 'ASM10', 2);
    const { shown } = await confirmed('return_samples', { order: orderNo });
    const again = await tool('return_samples', { order: orderNo, confirmationToken: shown.structuredContent!.confirmationToken });
    expect(codeOf(again)).toBe('CONFIRMATION_USED');
    expect(await saleable(request, headers, product.id)).toBe(10);
  });
});
