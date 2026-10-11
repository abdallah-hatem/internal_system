/* eslint-disable @typescript-eslint/no-explicit-any -- API and MCP responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: the assistant records a payment (I2, item 1)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §16 (owner 2026-10-11: the assistant may record a payment a
 *  shop made), §7 (oldest unpaid orders first, or a chosen order), §7a (never
 *  more than is owed, never dated forward, only the payer's own orders).
 *
 *  As 93 does it: the partner signs Claude in through the real OAuth flow and
 *  the MCP SDK's own client calls record_payment over Streamable HTTP. The
 *  debt is real — a confirmed order on stock that came through a cycle
 *  (CLAUDE.md rule 4) — and what the assistant wrote is read back through the
 *  office's own endpoints and, once, on the customer's page reached by
 *  clicking.
 *
 *  Unit tests for the same cases: apps/api/src/modules/assistant/tools/payments.spec.ts.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { API, EMAIL, PASSWORD, apiCtx, owedOrder, outstandingOf, stockedProduct } from './support/fixtures';
import { ROOT, codeFor, redeem } from './support/oauth-flow';
import { login, openCustomer } from './support/ui';

const MCP = `${ROOT}/mcp`;

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: {
    status?: string;
    confirmationToken?: string;
    data?: any;
    error?: { code: string; message: string; params?: Record<string, unknown> };
  };
}

const codeOf = (r: ToolResult) => r.structuredContent?.error?.code;
const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');
const stamp = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;

let client: Client | undefined;

test.beforeAll(async ({ request }) => {
  const res = await redeem(request, await codeFor(request, EMAIL, PASSWORD));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  client = new Client({ name: 'claude-e2e-payments', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      requestInit: { headers: { Authorization: `Bearer ${res.body.access_token}` } },
    }),
  );
});

test.afterAll(async () => {
  await client?.close();
});

const pay = (args: Record<string, unknown>) =>
  client!.callTool({ name: 'record_payment', arguments: args }) as Promise<ToolResult>;
const commit = (args: Record<string, unknown>, shown: ToolResult) =>
  pay({ ...args, confirmationToken: shown.structuredContent!.confirmationToken });

/** A shop owing two confirmed orders, the older one first. */
async function shopOwing(request: APIRequestContext, label: string, first = 3000, second = 4000) {
  const { headers, mk } = await apiCtx(request);
  const { product } = await stockedProduct(request, headers, mk, `${label} ${stamp()}`, 10);
  const shop = await mk('customers', { displayName: `${label} Shop ${stamp()}`, type: 'B2B' });
  const older = await owedOrder(mk, shop.id, product.id, first);
  const newer = await owedOrder(mk, shop.id, product.id, second);
  return { headers, mk, shop, older, newer, product };
}

async function paymentsOf(request: APIRequestContext, headers: any, customerId: string) {
  const res = await request.get(`${API}/payments?customerId=${customerId}&limit=100`, { headers });
  return (await res.json()).data as any[];
}

test.describe('record_payment (§16, 2026-10-11)', () => {
  test('TC-AP-01: "<shop> paid 5,000 cash" → oldest first, balance before and after; nothing written until yes; the shop page shows it', async ({
    page,
    request,
  }) => {
    const { headers, shop, older, newer } = await shopOwing(request, 'AP01');
    const args = { customer: shop.displayName, amount: 5000, method: 'CASH' };

    const shown = await pay(args);
    expect(shown.structuredContent?.status, text(shown)).toBe('preview');
    expect(shown.structuredContent?.data).toMatchObject({
      balanceBefore: '7000.00',
      balanceAfter: '2000.00',
      allocations: [
        { orderNo: older.orderNo, amount: '3000.00', owesAfter: '0.00' },
        { orderNo: newer.orderNo, amount: '2000.00', owesAfter: '2000.00' },
      ],
    });
    expect(text(shown)).toContain('7,000.00 EGP before, 2,000.00 EGP after');
    expect(await paymentsOf(request, headers, shop.id)).toHaveLength(0);

    const done = await commit(args, shown);
    expect(done.structuredContent?.status, text(done)).toBe('committed');
    expect(await outstandingOf(request, headers, older.id)).toBe(0);
    expect(await outstandingOf(request, headers, newer.id)).toBe(2000);
    const [payment] = await paymentsOf(request, headers, shop.id);
    expect(payment).toMatchObject({ method: 'CASH', status: 'RECORDED' });
    expect(Number(payment.amount)).toBe(5000);

    // What a partner sees afterwards, reached the way they reach it.
    await login(page);
    await openCustomer(page, shop.displayName);
    await expect(page.getByTestId('customer-balance')).toContainText('2,000.00');
  });

  test('TC-AP-02: more than the shop owes → PAYMENT_EXCEEDS_OWED in the preview, no token, nothing recorded', async ({ request }) => {
    const { headers, shop } = await shopOwing(request, 'AP02');
    const r = await pay({ customer: shop.displayName, amount: 7000.01 });
    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe('PAYMENT_EXCEEDS_OWED');
    expect(r.structuredContent?.confirmationToken).toBeUndefined();
    expect(await paymentsOf(request, headers, shop.id)).toHaveLength(0);
  });

  test('TC-AP-03: a day that has not come yet → DATE_IN_FUTURE; zero → AMOUNT_NOT_POSITIVE', async ({ request }) => {
    const { headers, shop } = await shopOwing(request, 'AP03');
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(codeOf(await pay({ customer: shop.displayName, amount: 100, receivedOn: tomorrow }))).toBe('DATE_IN_FUTURE');
    expect(codeOf(await pay({ customer: shop.displayName, amount: 0 }))).toBe('AMOUNT_NOT_POSITIVE');
    expect(await paymentsOf(request, headers, shop.id)).toHaveLength(0);
  });

  test("TC-AP-04: another shop's order → NOT_FOUND, its debt untouched; a named order of its own takes the money", async ({ request }) => {
    const a = await shopOwing(request, 'AP04a');
    const b = await shopOwing(request, 'AP04b');
    const wrong = await pay({ customer: a.shop.displayName, amount: 100, order: b.older.orderNo });
    expect(codeOf(wrong)).toBe('NOT_FOUND');
    expect(await outstandingOf(request, b.headers, b.older.id)).toBe(3000);

    const args = { customer: a.shop.displayName, amount: 1000, order: a.newer.orderNo };
    const shown = await pay(args);
    expect(shown.structuredContent?.data.allocations).toEqual([
      { orderNo: a.newer.orderNo, amount: '1000.00', owesAfter: '3000.00' },
    ]);
    await commit(args, shown);
    expect(await outstandingOf(request, a.headers, a.older.id)).toBe(3000);
    expect(await outstandingOf(request, a.headers, a.newer.id)).toBe(3000);
  });

  test('TC-AP-05: the same yes twice → CONFIRMATION_USED; the money is taken once', async ({ request }) => {
    const { headers, shop } = await shopOwing(request, 'AP05');
    const args = { customer: shop.displayName, amount: 500 };
    const shown = await pay(args);
    await commit(args, shown);
    expect(codeOf(await commit(args, shown))).toBe('CONFIRMATION_USED');
    expect(await paymentsOf(request, headers, shop.id)).toHaveLength(1);
  });

  test('TC-AP-06: a payment taken at the office between preview and yes → PREVIEW_CHANGED; nothing more recorded', async ({ request }) => {
    const { headers, mk, shop } = await shopOwing(request, 'AP06');
    const args = { customer: shop.displayName, amount: 500 };
    const shown = await pay(args);
    await mk('payments', { customerId: shop.id, amount: 1000, currency: 'EGP', applyOldestFirst: true });
    expect(codeOf(await commit(args, shown))).toBe('PREVIEW_CHANGED');
    expect(await paymentsOf(request, headers, shop.id)).toHaveLength(1);
  });

  test('TC-AP-07: a close name is a question with candidates and no token; nothing recorded', async ({ request }) => {
    const { headers, shop } = await shopOwing(request, 'AP07');
    const r = await pay({ customer: shop.displayName.replace(' Shop ', ' Shops '), amount: 100 });
    expect(r.structuredContent?.status, text(r)).toBe('needs_answers');
    expect(r.structuredContent?.confirmationToken).toBeUndefined();
    expect(await paymentsOf(request, headers, shop.id)).toHaveLength(0);
  });

  test('TC-AP-08: the office applies oldest first in one request too, and the investor is still refused', async ({ request }) => {
    const { headers, mk, shop, older, newer } = await shopOwing(request, 'AP08');
    await mk('payments', { customerId: shop.id, amount: 3500, currency: 'EGP', applyOldestFirst: true });
    expect(await outstandingOf(request, headers, older.id)).toBe(0);
    expect(await outstandingOf(request, headers, newer.id)).toBe(3500);

    // Too much is refused whole: no payment is left recorded and unapplied.
    const tooMuch = await request.post(`${API}/payments`, {
      headers,
      data: { customerId: shop.id, amount: 3500.01, currency: 'EGP', applyOldestFirst: true },
    });
    expect(tooMuch.status()).toBe(400);
    expect((await tooMuch.json()).error.code).toBe('PAYMENT_EXCEEDS_OWED');
    expect(await paymentsOf(request, headers, shop.id)).toHaveLength(1);
  });
});
