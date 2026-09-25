/* eslint-disable @typescript-eslint/no-explicit-any -- API and MCP responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The assistant's cycle tools, over HTTP
 * ═══════════════════════════════════════════════════════════════════════
 *  Plan docs/plans/2026-09-19-mcp-assistant.md → T8. BUSINESS_LOGIC §1, §2,
 *  §14, §15, §16.
 *
 *  create_cycle, add_shipping_leg, transition_cycle and verify_stock, called
 *  the way Claude calls them: a JSON-RPC `tools/call` on /mcp with the
 *  assistant's token, first without a confirmation token (a preview, nothing
 *  written) and then with the token the preview returned (the commit).
 *
 *  The cycles are built the way the business builds them (CLAUDE.md rule 4):
 *  a cycle, a purchase order with lines, a dated leg, the transitions in order.
 *  The office API builds the parts a test is not about, and reads back what
 *  the assistant wrote — so "committed" means the office app can see it.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, apiCtx, daysAgo, today, type Mk } from './support/fixtures';
import { assistantToken } from './support/assistant-token';

const MCP = `${API.replace(/\/api\/v1\/?$/, '')}/mcp`;

const stamp = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;

const daysAhead = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};

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

let rpcId = 0;

async function tool(request: APIRequestContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await request.post(MCP, {
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Protocol-Version': '2025-06-18',
      Authorization: `Bearer ${await assistantToken(request)}`,
    },
    data: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
  });
  // A refusal is a tool result, never a transport failure and never a 500.
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result as ToolResult;
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');
const codeOf = (r: ToolResult) => r.structuredContent?.error?.code;

/** Preview, then commit with the preview's token. Both must succeed. */
async function confirm(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const preview = await tool(request, name, args);
  expect(preview.isError, text(preview)).toBeFalsy();
  expect(preview.structuredContent?.status).toBe('preview');
  const commit = await tool(request, name, {
    ...args,
    confirmationToken: preview.structuredContent!.confirmationToken,
  });
  expect(commit.isError, text(commit)).toBeFalsy();
  expect(commit.structuredContent?.status).toBe('committed');
  return { preview, commit };
}

async function cycleOf(request: APIRequestContext, headers: any, id: string) {
  const res = await request.get(`${API}/cycles/${id}`, { headers });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.data ?? body;
}

async function batchesOf(request: APIRequestContext, headers: any, cycleId: string) {
  const res = await request.get(`${API}/inventory?cycleId=${cycleId}`, { headers });
  const rows: any[] = (await res.json()).data ?? [];
  return rows.flatMap((p) => p.batches ?? []);
}

/** A UAE-direct cycle in PURCHASING with one draft order of `qty` × `unitPrice`. */
async function purchasingCycle(mk: Mk, opts: { qty?: number; unitPrice?: number } = {}) {
  const tag = stamp();
  const product = await mk('products', { name: `Assistant Cycle Part ${tag}`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `Assistant Cycle Supplier ${tag}`, country: 'AE' });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  await mk(`cycles/${cycle.id}/transition`, { status: 'FUNDING' });
  await mk(`cycles/${cycle.id}/transition`, { status: 'PURCHASING' });
  const po = await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id,
    currency: 'EGP',
    fxRateToEgp: 1,
    orderedOn: today(),
    items: [{ productId: product.id, orderedQty: opts.qty ?? 40, unitPrice: opts.unitPrice ?? 25 }],
  });
  return { cycle, product, supplier, po };
}

/**
 * The same cycle carried to VERIFICATION with its leg dated and nothing
 * received yet: 40 × 25 EGP of goods and a 300 EGP leg, so each unit lands at
 * (1,000 + 300) / 40 = 32.50 EGP.
 */
async function cycleAwaitingVerification(request: APIRequestContext, headers: any, mk: Mk) {
  const run = await purchasingCycle(mk, { qty: 40, unitPrice: 25 });
  await mk(`cycles/${run.cycle.id}/shipping-legs`, {
    sequence: 1,
    origin: 'Dubai, UAE',
    destination: 'Cairo, Egypt',
    costBasis: 'FLAT',
    amount: 300,
    currency: 'EGP',
    fxRateToEgp: 1,
    departedOn: daysAgo(12),
    arrivedOn: daysAgo(4),
  });
  for (const status of ['ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
    await mk(`cycles/${run.cycle.id}/transition`, { status });
  }
  const full = await cycleOf(request, headers, run.cycle.id);
  return { ...run, poItem: full.purchaseOrders[0].items[0] };
}

test.describe('create_cycle', () => {
  for (const [route, legs] of [
    ['CHINA', 2],
    ['UAE_DIRECT', 1],
  ] as const) {
    test(`TC-MCP-CYC-01: create_cycle for ${route} → created with ${legs} leg(s) expected`, async ({ request }) => {
      const { headers } = await apiCtx(request);

      const { preview, commit } = await confirm(request, 'create_cycle', { route });

      expect(text(preview)).toContain(`ships in ${legs} leg`);
      expect(preview.structuredContent?.data.expectedLegs).toHaveLength(legs);
      const created = commit.structuredContent?.data;
      expect(created.expectedLegs).toHaveLength(legs);

      const cycle = await cycleOf(request, headers, created.id);
      expect(cycle.originType).toBe(route);
      expect(cycle.status).toBe('PLANNING');
      expect(cycle.shippingLegs).toHaveLength(0);
    });
  }

  test('TC-MCP-CYC-02: create_cycle started in the future → DATE_IN_FUTURE', async ({ request }) => {
    const r = await tool(request, 'create_cycle', { route: 'CHINA', startedOn: daysAhead(5) });
    expect(codeOf(r)).toBe('DATE_IN_FUTURE');
  });
});

test.describe('transition_cycle', () => {
  test("TC-MCP-CYC-10: a transition that skips a status → the service's refusal, surfaced", async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

    const r = await tool(request, 'transition_cycle', {
      cycleId: cycle.id,
      fromStatus: 'PLANNING',
      status: 'PURCHASING',
    });

    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe('BAD_STATUS_TRANSITION');
    expect((await cycleOf(request, headers, cycle.id)).status).toBe('PLANNING');
  });

  test('TC-MCP-CYC-11: a transition to an arrival with the leg undated → LEG_NOT_ARRIVED, surfaced', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'CHINA', currency: 'EGP' });
    await mk(`cycles/${cycle.id}/transition`, { status: 'FUNDING' });
    await mk(`cycles/${cycle.id}/transition`, { status: 'PURCHASING' });
    // Leg 1 left China and nobody has dated its arrival in the UAE.
    await confirm(request, 'add_shipping_leg', {
      cycleId: cycle.id,
      sequence: 1,
      departedOn: daysAgo(6),
      amount: 200,
    });
    await mk(`cycles/${cycle.id}/transition`, { status: 'IN_TRANSIT' });

    const r = await tool(request, 'transition_cycle', {
      cycleId: cycle.id,
      fromStatus: 'IN_TRANSIT',
      status: 'ARRIVED_UAE',
    });

    expect(codeOf(r)).toBe('LEG_NOT_ARRIVED');
    expect((await cycleOf(request, headers, cycle.id)).status).toBe('IN_TRANSIT');
  });

  test('TC-MCP-CYC-12: the preview of a transition past PURCHASING says which orders it will confirm and lock (§15)', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle, po, supplier } = await purchasingCycle(mk);
    const args = { cycleId: cycle.id, fromStatus: 'PURCHASING', status: 'ARRIVED_UAE' };

    const preview = await tool(request, 'transition_cycle', args);

    expect(text(preview)).toContain('confirms and locks 1 purchase order');
    expect(text(preview)).toContain(`${po.reference} (${supplier.name}), 1 line`);
    // A preview writes nothing: still purchasing, still a draft.
    let now = await cycleOf(request, headers, cycle.id);
    expect(now.status).toBe('PURCHASING');
    expect(now.purchaseOrders[0].status).toBe('DRAFT');

    await tool(request, 'transition_cycle', {
      ...args,
      confirmationToken: preview.structuredContent!.confirmationToken,
    });
    now = await cycleOf(request, headers, cycle.id);
    expect(now.status).toBe('ARRIVED_UAE');
    expect(now.purchaseOrders[0].status).toBe('CONFIRMED');
  });

  test('TC-MCP-CYC-13: the preview of a cancel says it is final', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle } = await purchasingCycle(mk);
    const args = { cycleId: cycle.id, fromStatus: 'PURCHASING', status: 'CANCELLED' };

    const { preview } = await confirm(request, 'transition_cycle', args);

    expect(text(preview)).toMatch(/Cancelling is final/);
    expect(preview.structuredContent?.data.ordersToConfirm).toEqual([]);
    const now = await cycleOf(request, headers, cycle.id);
    expect(now.status).toBe('CANCELLED');
    expect(now.purchaseOrders[0].status).toBe('DRAFT');
  });

  test('TC-MCP-CYC-14: a confirmation used after the cycle moved on → CYCLE_STATUS_CHANGED, nothing changed', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await mk(`cycles/${cycle.id}/transition`, { status: 'FUNDING' });
    const args = { cycleId: cycle.id, fromStatus: 'FUNDING', status: 'CANCELLED' };
    const preview = await tool(request, 'transition_cycle', args);

    // Another partner moves it on in the office app before this "yes" arrives.
    await mk(`cycles/${cycle.id}/transition`, { status: 'PURCHASING' });

    const commit = await tool(request, 'transition_cycle', {
      ...args,
      confirmationToken: preview.structuredContent!.confirmationToken,
    });
    expect(codeOf(commit)).toBe('CYCLE_STATUS_CHANGED');
    expect((await cycleOf(request, headers, cycle.id)).status).toBe('PURCHASING');
  });
});

test.describe('add_shipping_leg', () => {
  test('TC-MCP-CYC-20: add_shipping_leg with arrivedOn in the future → refused', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle } = await purchasingCycle(mk);

    const r = await tool(request, 'add_shipping_leg', {
      cycleId: cycle.id,
      sequence: 1,
      departedOn: daysAgo(2),
      arrivedOn: daysAhead(3),
      amount: 300,
    });

    expect(codeOf(r)).toBe('DATE_IN_FUTURE');
    expect((await cycleOf(request, headers, cycle.id)).shippingLegs).toHaveLength(0);
  });

  test('TC-MCP-CYC-21: a leg on a cancelled cycle → CYCLE_FINAL_NO_LEGS', async ({ request }) => {
    const { mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await mk(`cycles/${cycle.id}/transition`, { status: 'CANCELLED' });

    const r = await tool(request, 'add_shipping_leg', { cycleId: cycle.id, sequence: 1, amount: 300 });
    expect(codeOf(r)).toBe('CYCLE_FINAL_NO_LEGS');
  });

  test('TC-MCP-CYC-22: a cycle id that is not a UUID → VALIDATION_FAILED, never a 500', async ({ request }) => {
    for (const [name, rest] of [
      ['add_shipping_leg', { sequence: 1, amount: 300 }],
      ['transition_cycle', { fromStatus: 'PLANNING', status: 'FUNDING' }],
      ['verify_stock', { items: [] }],
    ] as const) {
      const r = await tool(request, name, { cycleId: 'CYC-2026-0001', ...rest });
      expect(codeOf(r), name).toBe('VALIDATION_FAILED');
    }
  });
});

test.describe('verify_stock', () => {
  test('TC-MCP-CYC-30: the verify_stock preview shows the landed unit cost per line before anything is written (money)', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle, poItem, product } = await cycleAwaitingVerification(request, headers, mk);
    const args = { cycleId: cycle.id, items: [{ purchaseOrderItemId: poItem.id, receivedQty: 40 }] };

    const preview = await tool(request, 'verify_stock', args);

    expect(text(preview)).toContain(`${product.name}: 40 of 40 ordered, landed 32.5000 EGP/unit = 1,300.00 EGP`);
    expect(preview.structuredContent?.data.lines[0].landedUnitCostEgp).toBe('32.5000');
    expect(await batchesOf(request, headers, cycle.id)).toHaveLength(0);

    await tool(request, 'verify_stock', {
      ...args,
      confirmationToken: preview.structuredContent!.confirmationToken,
    });
    const batches = await batchesOf(request, headers, cycle.id);
    expect(batches).toHaveLength(1);
    expect(Number(batches[0].landedUnitCostEgp)).toBeCloseTo(32.5, 4);
  });

  test('TC-MCP-CYC-31: verify_stock twice for one order line → STOCK_ALREADY_VERIFIED, surfaced', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle, poItem } = await cycleAwaitingVerification(request, headers, mk);
    const args = { cycleId: cycle.id, items: [{ purchaseOrderItemId: poItem.id, receivedQty: 40 }] };
    await confirm(request, 'verify_stock', args);

    const again = await tool(request, 'verify_stock', args);

    expect(codeOf(again)).toBe('STOCK_ALREADY_VERIFIED');
    expect(await batchesOf(request, headers, cycle.id)).toHaveLength(1);
  });

  test('TC-MCP-CYC-32: verifying more than was ordered, zero, or less than zero → refused, nothing written', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle, poItem } = await cycleAwaitingVerification(request, headers, mk);

    for (const [qty, code] of [
      [41, 'RECEIVED_EXCEEDS_ORDERED'],
      [0, 'QTY_NOT_POSITIVE'],
      [-5, 'QTY_NOT_POSITIVE'],
    ] as const) {
      const r = await tool(request, 'verify_stock', {
        cycleId: cycle.id,
        items: [{ purchaseOrderItemId: poItem.id, receivedQty: qty }],
      });
      expect(codeOf(r), String(qty)).toBe(code);
    }
    expect(await batchesOf(request, headers, cycle.id)).toHaveLength(0);
  });

  test("TC-MCP-CYC-33: another cycle's order line → PO_ITEM_NOT_IN_CYCLE", async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const mine = await cycleAwaitingVerification(request, headers, mk);
    const theirs = await cycleAwaitingVerification(request, headers, mk);

    const r = await tool(request, 'verify_stock', {
      cycleId: mine.cycle.id,
      items: [{ purchaseOrderItemId: theirs.poItem.id, receivedQty: 1 }],
    });
    expect(codeOf(r)).toBe('PO_ITEM_NOT_IN_CYCLE');
  });
});
