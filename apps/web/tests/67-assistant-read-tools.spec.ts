/* eslint-disable @typescript-eslint/no-explicit-any -- API and MCP responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: the assistant's read tools, over HTTP
 * ═══════════════════════════════════════════════════════════════════════
 *  Spec docs/specs/2026-09-19-mcp-assistant.md, "Tools". Plan T6.
 *  BUSINESS_LOGIC §14 (two arrival dates, one definition) and §16 (what the
 *  assistant may read, and that it changes nothing outside intake).
 *
 *  Each tool is called the way claude.ai calls it — a JSON-RPC `tools/call`
 *  on /mcp with an mcp token — and its answer is compared with what the office
 *  app's own endpoint says about the same record. The point is not that the
 *  tools answer; it is that they cannot answer differently from the office.
 *
 *  The data is built through the real import pipeline (stockedProduct,
 *  owedOrder): a balance only exists behind a confirmed order, and stock only
 *  behind a verified receipt (CLAUDE.md rule 4).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, apiCtx, owedOrder, stockedProduct } from './support/fixtures';
import { assistantToken } from './support/assistant-token';

const ROOT = API.replace(/\/api\/v1\/?$/, '');
const MCP = `${ROOT}/mcp`;

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: {
    data?: any;
    error?: { code: string; message: string; params?: Record<string, string> };
  };
}

let rpcId = 1;

async function rpc(request: APIRequestContext, token: string, method: string, params: object) {
  const res = await request.post(MCP, {
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Protocol-Version': '2025-06-18',
      Authorization: `Bearer ${token}`,
    },
    data: { jsonrpc: '2.0', id: rpcId++, method, params },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result;
}

async function tool(request: APIRequestContext, token: string, name: string, args: object = {}): Promise<ToolResult> {
  return rpc(request, token, 'tools/call', { name, arguments: args });
}

function data(result: ToolResult) {
  expect(result.isError, result.content?.[0]?.text).toBeFalsy();
  return result.structuredContent!.data;
}

function refusal(result: ToolResult) {
  expect(result.isError).toBe(true);
  return result.structuredContent!.error!;
}

test.describe('Assistant read tools', () => {
  test('TC-MCP-READ-01: get_cycle by code and by id → the same cycle; unknown → NOT_FOUND', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const token = await assistantToken(request);
    const { cycle } = await stockedProduct(request, headers, mk, `ReadCyc ${Date.now()}`, 5);

    const byCode = data(await tool(request, token, 'get_cycle', { cycle: cycle.code }));
    const byId = data(await tool(request, token, 'get_cycle', { cycle: cycle.id }));
    const byLowerCode = data(await tool(request, token, 'get_cycle', { cycle: String(cycle.code).toLowerCase() }));

    expect(byCode.id).toBe(cycle.id);
    expect(byId).toEqual(byCode);
    expect(byLowerCode.id).toBe(cycle.id);

    for (const unknown of ['CYC-1999-9999', '00000000-0000-4000-8000-000000000000', 'not-a-uuid', '']) {
      expect(refusal(await tool(request, token, 'get_cycle', { cycle: unknown })).code).toBe('NOT_FOUND');
    }
  });

  test("TC-MCP-READ-02: get_stock arrival and receipt dates equal /inventory's", async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const token = await assistantToken(request);
    const { product } = await stockedProduct(request, headers, mk, `ReadStock ${Date.now()}`, 7);

    const office = await (await request.get(`${API}/inventory?productId=${product.id}`, { headers })).json();
    const officeBatch = (office.data ?? office)[0].batches[0];
    const [line] = data(await tool(request, token, 'get_stock', { productId: product.id }));
    const toolBatch = line.batches[0];

    expect(officeBatch.arrivedOn, 'the fixture dates its leg').toBeTruthy();
    expect(new Date(toolBatch.arrivedOn).getTime()).toBe(new Date(officeBatch.arrivedOn).getTime());
    expect(new Date(toolBatch.receivedAt).getTime()).toBe(new Date(officeBatch.receivedAt).getTime());
    // Two dates, not one: the fixture's leg landed five days before the receipt.
    expect(toolBatch.arrivedOn).not.toBe(toolBatch.receivedAt);
  });

  test("TC-MCP-READ-03: get_customer balance equals the office app's for the same customer", async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const token = await assistantToken(request);
    const stamp = Date.now();
    const { product } = await stockedProduct(request, headers, mk, `ReadBal ${stamp}`, 10);
    const customer = await mk('customers', { displayName: `ReadBal Shop ${stamp}`, type: 'B2B' });
    await owedOrder(mk, customer.id, product.id, 300);
    await owedOrder(mk, customer.id, product.id, 450);
    // A draft owes nothing. If the balance counted it, it would read 1,750.
    await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: 1000, discount: 0 }],
    });

    // The office app's figure, the way the customer page works it out...
    const orders = await (await request.get(`${API}/sales/orders?customerId=${customer.id}&limit=100`, { headers })).json();
    const page = (orders.data ?? orders)
      .filter((o: any) => ['CONFIRMED', 'PARTIALLY_PAID'].includes(o.status))
      .reduce((s: number, o: any) => s + Number(o.outstanding), 0);
    // ...and as the customer endpoint reports it.
    const detail = await (await request.get(`${API}/customers/${customer.id}`, { headers })).json();

    const answer = data(await tool(request, token, 'get_customer', { customer: customer.id }));

    expect(Number(answer.balance)).toBe(page);
    expect(answer.balance).toBe((detail.data ?? detail).outstandingBalance);
    expect(Number(answer.balance)).toBe(750);
    expect(answer.openOrders).toHaveLength(2);

    // The same customer found by name gives the same answer.
    const byName = data(await tool(request, token, 'get_customer', { customer: `readbal shop ${stamp}` }));
    expect(byName.balance).toBe(answer.balance);
  });

  test('TC-MCP-READ-04: find_products is case-insensitive and matches part of a SKU', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const token = await assistantToken(request);
    const stamp = Date.now();
    const { product } = await stockedProduct(request, headers, mk, `ReadFind ${stamp}`, 4);

    const byName = data(await tool(request, token, 'find_products', { search: `READFIND ${stamp}`.toLowerCase() }));
    expect(byName.map((p: any) => p.id)).toContain(product.id);

    const skuTail = String(product.sku).slice(-6).toLowerCase();
    const bySku = data(await tool(request, token, 'find_products', { search: skuTail, limit: 50 }));
    const found = bySku.find((p: any) => p.id === product.id);
    expect(found, `"${skuTail}" should find ${product.sku}`).toBeTruthy();
    expect(found.stock.total).toBe(4);
  });

  test('TC-MCP-READ-05: list_sales with from after to → tool error', async ({ request }) => {
    const token = await assistantToken(request);

    const error = refusal(await tool(request, token, 'list_sales', { from: '2026-09-10', to: '2026-09-01' }));

    expect(error.code).toBe('DATE_RANGE_REVERSED');
    expect(refusal(await tool(request, token, 'list_payments', { from: '2026-09-10', to: '2026-09-01' })).code).toBe(
      'DATE_RANGE_REVERSED',
    );
    expect(refusal(await tool(request, token, 'list_sales', { from: '2026-02-30' })).code).toBe('BAD_DATE');
  });

  test('TC-MCP-READ-06: tools/list offers no tool that writes instalments, settlements, returns or the ledger (record_sale and record_payment are the sale and payment writes)', async ({
    request,
  }) => {
    const token = await assistantToken(request);
    const { tools } = await rpc(request, token, 'tools/list', {});

    // record_delivery added 2026-10-10 (B4): §16 lets the assistant record deliveries;
    // record_departure 2026-10-12 (L8): goods leave in parts too.
    const intake = new Set([
      'create_supplier', 'create_product', 'create_purchase_order',
      'create_cycle', 'add_shipping_leg', 'transition_cycle', 'record_departure', 'record_delivery', 'verify_stock',
      // record_sale added 2026-10-11 (W3): the owner asked the assistant to record sales (§16).
      'record_sale',
    ]);
    // record_payment added 2026-10-11 (I2): the owner approved the assistant recording a shop's payment (§16).
    const moneyIn = new Set(['record_payment']);
    // Added 2026-10-11 (L2): what a friend paid a supplier, and repaying him (§16, §18).
    const lenders = new Set(['record_lender_financing', 'record_lender_repayment']);
    // Still office-only: reversing or allocating payments, instalments, settlements, returns, refunds and the ledger.
    const officeOnly = /payment|instal|settle|return|refund|ledger|transaction|allocat/i;
    const writes = tools.filter((t: any) => t.annotations?.readOnlyHint !== true);

    expect(
      writes
        .filter((t: any) => !moneyIn.has(t.name))
        .filter((t: any) => !lenders.has(t.name))
        .filter((t: any) => !intake.has(t.name) || officeOnly.test(t.name))
        .map((t: any) => t.name),
    ).toEqual([]);
    expect(writes.map((t: any) => t.name)).toEqual(expect.arrayContaining(['record_sale', 'record_payment']));
    for (const name of ['list_sales', 'list_payments', 'list_receivables', 'get_customer', 'get_dashboard', 'list_lenders', 'get_lender']) {
      expect(tools.find((t: any) => t.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
  });

  test('TC-MCP-READ-07: abuse — a non-uuid id, a huge limit, an empty search', async ({ request }) => {
    const token = await assistantToken(request);

    // Never a 500: an id that is not a uuid is simply not found.
    expect(refusal(await tool(request, token, 'list_sales', { customerId: 'Nile Motors' })).code).toBe('NOT_FOUND');
    expect(refusal(await tool(request, token, 'get_stock', { productId: '12' })).code).toBe('NOT_FOUND');

    // A huge limit is capped rather than refused or obeyed.
    const many = data(await tool(request, token, 'find_suppliers', { limit: 100000 }));
    expect(many.length).toBeLessThanOrEqual(50);

    // A blank search lists, it does not fail.
    expect(Array.isArray(data(await tool(request, token, 'find_products', { search: '   ' })))).toBe(true);

    // The two that take no input still answer.
    expect(data(await tool(request, token, 'get_dashboard'))).toHaveProperty('receivables');
    expect(Array.isArray(data(await tool(request, token, 'get_fx_rates')))).toBe(true);
  });

  test("TC-MCP-READ-08: list_receivables — who owes what, largest first, overdue from the plan, balances equal the office's", async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const token = await assistantToken(request);
    const stamp = Date.now();
    const { product } = await stockedProduct(request, headers, mk, `Recv ${stamp}`, 10);
    const day = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
    };

    // Large enough to sit above anything else the run has left owing.
    const late = await mk('customers', { displayName: `Recv Late ${stamp}`, type: 'B2B' });
    await owedOrder(mk, late.id, product.id, 7_000_000);
    await owedOrder(mk, late.id, product.id, 1_000_000);
    await mk('payment-plans', {
      customerId: late.id, agreedOn: day(-20),
      instalments: [{ dueOn: day(-5), amount: 3_000_000 }, { dueOn: day(10), amount: 1_000_000 }],
    });
    const big = await mk('customers', { displayName: `Recv Big ${stamp}`, type: 'B2B' });
    await owedOrder(mk, big.id, product.id, 9_000_000);
    // A draft owes nothing and must not make a shop appear.
    const draftOnly = await mk('customers', { displayName: `Recv Draft ${stamp}`, type: 'B2B' });
    await mk('sales/orders', {
      customerId: draftOnly.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: 99_000_000, discount: 0 }],
    });

    const rows = data(await tool(request, token, 'list_receivables', { limit: 50 }));
    const ids = rows.map((r: any) => r.customerId);
    expect(ids.indexOf(big.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(big.id)).toBeLessThan(ids.indexOf(late.id));
    expect(ids).not.toContain(draftOnly.id);
    const outstanding = rows.map((r: any) => Number(r.outstanding));
    expect(outstanding).toEqual([...outstanding].sort((a, b) => b - a));

    const lateRow = rows.find((r: any) => r.customerId === late.id);
    expect(lateRow).toMatchObject({ outstanding: '8000000.00', overdue: '3000000.00', openOrders: 2, oldestUnpaidOn: day(0) });
    expect(rows.find((r: any) => r.customerId === big.id).overdue).toBe('0.00');

    // The same balance the customer's page shows.
    const detail = await (await request.get(`${API}/customers/${late.id}`, { headers })).json();
    expect(lateRow.outstanding).toBe((detail.data ?? detail).outstandingBalance);

    // overdueOnly: the late shop, not the big one.
    const overdue = data(await tool(request, token, 'list_receivables', { overdueOnly: true, limit: 50 }));
    expect(overdue.map((r: any) => r.customerId)).toContain(late.id);
    expect(overdue.map((r: any) => r.customerId)).not.toContain(big.id);
    expect(overdue.every((r: any) => Number(r.overdue) > 0)).toBe(true);

    // A second read changes nothing and tells nobody.
    const again = data(await tool(request, token, 'list_receivables', { limit: 50 }));
    expect(again.find((r: any) => r.customerId === late.id)).toEqual(lateRow);
    const notes = (await (await request.get(`${API}/notifications?limit=100`, { headers })).json()).data ?? [];
    expect(notes.filter((n: any) => n.payloadJson?.customerId === late.id)).toEqual([]);

    // Abuse: a limit that is not a number is refused by the schema, never a 500.
    expect((await tool(request, token, 'list_receivables', { limit: 'all' })).isError).toBe(true);
  });
});
