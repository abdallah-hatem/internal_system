/* eslint-disable @typescript-eslint/no-explicit-any -- API and MCP responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: the assistant records deliveries and receives them
 * ═══════════════════════════════════════════════════════════════════════
 *  Plan docs/superpowers/plans/2026-10-10-partial-arrivals-and-ux.md → B4.
 *  BUSINESS_LOGIC §1 (deliveries), §2 (cost per ordered unit), §3 (stock is
 *  received one delivery at a time), §14 (arrival per batch), §16 (the
 *  assistant records deliveries and receives them; marking lost is office-app
 *  only; a confirmation binds what the preview showed).
 *
 *  As 72 does it: the partner signs Claude in through the real OAuth flow and
 *  the MCP SDK's own client calls the tools over Streamable HTTP. The cycles
 *  are built through the office API the way the office builds them (CLAUDE.md
 *  rule 4) — a cycle, an order, a departed leg, the transitions in order — and
 *  what the assistant wrote is read back through the office's shipment panel
 *  endpoint and the inventory list.
 *
 *  Unit tests for the same cases: apps/api/src/modules/assistant/tools/deliveries.spec.ts.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { API, EMAIL, PASSWORD, apiCtx, daysAgo, today, type Mk } from './support/fixtures';
import { ROOT, codeFor, redeem } from './support/oauth-flow';

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

// ─── The connection, as claude.ai makes it ─────────────────────────────────

let access = '';
let client: Client | undefined;

test.beforeAll(async ({ request }) => {
  const res = await redeem(request, await codeFor(request, EMAIL, PASSWORD));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  access = res.body.access_token;
  client = new Client({ name: 'claude-e2e-deliveries', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      requestInit: { headers: { Authorization: `Bearer ${access}` } },
    }),
  );
});

test.afterAll(async () => {
  await client?.close();
});

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client!.callTool({ name, arguments: args })) as ToolResult;
}

async function preview(name: string, args: Record<string, unknown>) {
  const r = await call(name, args);
  expect(r.isError, text(r)).toBeFalsy();
  expect(r.structuredContent?.status).toBe('preview');
  return r;
}

const commitWith = (name: string, args: Record<string, unknown>, shown: ToolResult) =>
  call(name, { ...args, confirmationToken: shown.structuredContent!.confirmationToken });

// ─── Reading back what the office sees ─────────────────────────────────────

async function shipmentOf(request: APIRequestContext, headers: any, cycleId: string) {
  const res = await request.get(`${API}/cycles/${cycleId}/shipment`, { headers });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  return body.data ?? body;
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

// ─── Building states the business recognises (CLAUDE.md rule 4) ──────────

/**
 * A UAE-direct cycle whose one leg (Dubai → Cairo) left 20 days ago and has
 * delivered nothing: 40 × 25 EGP of goods and a 400 EGP leg, so a unit lands
 * at (1,000 + 400) / 40 = 35.00 EGP whichever delivery brings it.
 */
async function onTheWay(request: APIRequestContext, headers: any, mk: Mk) {
  const tag = stamp();
  const product = await mk('products', { name: `Delivery Part ${tag}`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `Delivery Supplier ${tag}`, country: 'AE' });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  await mk(`cycles/${cycle.id}/transition`, { status: 'FUNDING' });
  await mk(`cycles/${cycle.id}/transition`, { status: 'PURCHASING' });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id,
    currency: 'EGP',
    fxRateToEgp: 1,
    orderedOn: daysAgo(30),
    items: [{ productId: product.id, orderedQty: 40, unitPrice: 25 }],
  });
  const leg = await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1,
    origin: 'Dubai, UAE',
    destination: 'Cairo, Egypt',
    costBasis: 'FLAT',
    amount: 400,
    currency: 'EGP',
    fxRateToEgp: 1,
    departedOn: daysAgo(20),
  });
  for (const status of ['ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT']) {
    await mk(`cycles/${cycle.id}/transition`, { status });
  }
  const full = await cycleOf(request, headers, cycle.id);
  return { cycle, product, leg, item: full.purchaseOrders[0].items[0] };
}

/** The office records a delivery on the leg, as its Shipment panel does. */
async function officeDelivers(mk: Mk, leg: any, item: any, qty: number, day: string) {
  return mk(`shipping/legs/${leg.id}/deliveries`, {
    arrivedOn: day,
    lines: [{ purchaseOrderItemId: item.id, qty }],
  });
}

const deliveryArgs = (leg: any, item: any, qty: number, day: string) => ({
  legId: leg.id,
  arrivedOn: day,
  lines: [{ purchaseOrderItemId: item.id, qty }],
});

// ═══════════════════════════════════════════════════════════ record_delivery

test.describe('record_delivery', () => {
  test('TC-MCP-DEL-01: record_delivery preview writes nothing; confirm writes exactly the previewed delivery', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle, leg, item, product } = await onTheWay(request, headers, mk);
    const args = { ...deliveryArgs(leg, item, 15, daysAgo(5)), note: 'first pallet' };

    const shown = await preview('record_delivery', args);

    expect(text(shown)).toContain(`${product.name}: 15 arrived; 40 were on the way, 25 will still be on the way.`);
    let shipment = await shipmentOf(request, headers, cycle.id);
    expect(shipment.legs[0].deliveries).toHaveLength(0);
    expect(shipment.legs[0].onTheWay).toBe(40);

    const commit = await commitWith('record_delivery', args, shown);
    expect(commit.isError, text(commit)).toBeFalsy();

    shipment = await shipmentOf(request, headers, cycle.id);
    expect(shipment.legs[0].deliveries).toHaveLength(1);
    expect(shipment.legs[0].deliveries[0].arrivedOn).toBe(daysAgo(5));
    expect(shipment.legs[0].deliveries[0].lines.map((l: any) => [l.purchaseOrderItemId, l.qty])).toEqual([
      [item.id, 15],
    ]);
    expect(shipment.legs[0].status).toBe('PARTLY_ARRIVED');
    expect(shipment.legs[0].onTheWay).toBe(25);
  });

  test("TC-MCP-DEL-02: a delivery recorded by someone else between preview and confirm, so the preview's quantity no longer fits → PREVIEW_CHANGED or DELIVERY_EXCEEDS_IN_TRANSIT, nothing written", async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle, leg, item } = await onTheWay(request, headers, mk);

    // Still fits, but would leave less on the way than the partner was shown.
    const fits = deliveryArgs(leg, item, 15, daysAgo(5));
    const shownFits = await preview('record_delivery', fits);
    // Too much once the office has recorded its own.
    const tooMuch = deliveryArgs(leg, item, 30, daysAgo(5));
    const shownTooMuch = await preview('record_delivery', tooMuch);

    await officeDelivers(mk, leg, item, 12, daysAgo(6));

    expect(codeOf(await commitWith('record_delivery', fits, shownFits))).toBe('PREVIEW_CHANGED');
    expect(codeOf(await commitWith('record_delivery', tooMuch, shownTooMuch))).toBe('DELIVERY_EXCEEDS_IN_TRANSIT');
    const shipment = await shipmentOf(request, headers, cycle.id);
    expect(shipment.legs[0].deliveries).toHaveLength(1); // the office's only
    expect(shipment.legs[0].onTheWay).toBe(28);
  });

  test('TC-MCP-DEL-03: the refusals a delivery meets come through coded, and nothing is written', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle, leg, item } = await onTheWay(request, headers, mk);
    const tomorrow = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
    })();

    for (const [args, code] of [
      [deliveryArgs(leg, item, 41, daysAgo(5)), 'DELIVERY_EXCEEDS_IN_TRANSIT'],
      [deliveryArgs(leg, item, 0, daysAgo(5)), 'QTY_NOT_POSITIVE'],
      [deliveryArgs(leg, item, 5, tomorrow), 'DATE_IN_FUTURE'],
      [deliveryArgs(leg, item, 5, daysAgo(25)), 'DELIVERY_BEFORE_DEPARTURE'],
      [{ ...deliveryArgs(leg, item, 5, daysAgo(5)), legId: 'leg-1' }, 'NOT_FOUND'],
    ] as const) {
      expect(codeOf(await call('record_delivery', args)), JSON.stringify(args)).toBe(code);
    }
    expect((await shipmentOf(request, headers, cycle.id)).legs[0].deliveries).toHaveLength(0);
  });

  test('TC-MCP-DEL-04: a confirmation replayed after the delivery was recorded → CONFIRMATION_USED, recorded once', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle, leg, item } = await onTheWay(request, headers, mk);
    const args = deliveryArgs(leg, item, 15, daysAgo(5));
    const shown = await preview('record_delivery', args);
    expect((await commitWith('record_delivery', args, shown)).isError).toBeFalsy();

    expect(codeOf(await commitWith('record_delivery', args, shown))).toBe('CONFIRMATION_USED');
    expect((await shipmentOf(request, headers, cycle.id)).legs[0].deliveries).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════ verify_stock

test.describe('verify_stock', () => {
  /** The cycle with one delivery of `qty` recorded and the cycle in Egypt. */
  async function delivered(request: APIRequestContext, headers: any, mk: Mk, qty: number) {
    const run = await onTheWay(request, headers, mk);
    await officeDelivers(mk, run.leg, run.item, qty, daysAgo(5));
    await mk(`cycles/${run.cycle.id}/transition`, { status: 'ARRIVED_EGYPT' });
    const shipment = await shipmentOf(request, headers, run.cycle.id);
    const delivery = shipment.legs[0].deliveries[0];
    return { ...run, delivery, line: delivery.lines[0] };
  }

  test('TC-MCP-DEL-10: verify_stock with a delivery: preview shows the unit cost; confirm books it; replay → CONFIRMATION_USED', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle, product, delivery, line } = await delivered(request, headers, mk, 15);
    const args = { deliveryId: delivery.id, items: [{ deliveryLineId: line.id, receivedQty: 15 }] };

    const shown = await preview('verify_stock', args);
    expect(text(shown)).toContain(`${product.name}: 15 counted in (40 ordered), landed 35.0000 EGP/unit = 525.00 EGP`);
    expect(await batchesOf(request, headers, cycle.id)).toHaveLength(0);

    const commit = await commitWith('verify_stock', args, shown);
    expect(commit.isError, text(commit)).toBeFalsy();
    const batches = await batchesOf(request, headers, cycle.id);
    expect(batches).toHaveLength(1);
    expect(Number(batches[0].landedUnitCostEgp)).toBeCloseTo(35, 4);
    expect((await cycleOf(request, headers, cycle.id)).status).toBe('SELLING');

    expect(codeOf(await commitWith('verify_stock', args, shown))).toBe('CONFIRMATION_USED');
    expect(await batchesOf(request, headers, cycle.id)).toHaveLength(1);
  });

  test('TC-MCP-DEL-11: verify_stock on a second delivery while SELLING → works (it used to be CYCLE_NOT_IN_VERIFICATION)', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle, leg, item, delivery, line } = await delivered(request, headers, mk, 15);
    await mk('receipts/verify', {
      cycleId: cycle.id,
      deliveryId: delivery.id,
      items: [{ deliveryLineId: line.id, receivedQty: 15 }],
    });
    expect((await cycleOf(request, headers, cycle.id)).status).toBe('SELLING');

    // The second delivery, recorded and received through the assistant.
    const recordArgs = deliveryArgs(leg, item, 10, daysAgo(1));
    const recorded = await commitWith('record_delivery', recordArgs, await preview('record_delivery', recordArgs));
    expect(recorded.isError, text(recorded)).toBeFalsy();
    const second = recorded.structuredContent!.data;
    const args = {
      deliveryId: second.deliveryId,
      items: [{ deliveryLineId: second.lines[0].deliveryLineId, receivedQty: 10 }],
    };
    const shown = await preview('verify_stock', args);
    expect(text(shown)).toContain('stays SELLING');
    const commit = await commitWith('verify_stock', args, shown);
    expect(commit.isError, text(commit)).toBeFalsy();

    const batches = await batchesOf(request, headers, cycle.id);
    expect(batches).toHaveLength(2);
    // Same unit cost; each its own arrival (§2, §14).
    expect(batches.map((b: any) => Number(b.landedUnitCostEgp))).toEqual([35, 35]);
    expect(new Set(batches.map((b: any) => String(b.arrivedOn).slice(0, 10)))).toEqual(
      new Set([daysAgo(5), daysAgo(1)]),
    );
  });

  test('TC-MCP-DEL-12: verify_stock after the landed cost changed since the preview → PREVIEW_CHANGED', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const { cycle, leg, delivery, line } = await delivered(request, headers, mk, 15);
    const args = { deliveryId: delivery.id, items: [{ deliveryLineId: line.id, receivedQty: 15 }] };
    const shown = await preview('verify_stock', args);

    // The freight invoice is corrected before anything is received: 400 → 800.
    const put = await request.put(`${API}/shipping/legs/${leg.id}`, {
      headers,
      data: { costBasis: 'FLAT', amount: 800, currency: 'EGP', fxRateToEgp: 1 },
    });
    expect(put.ok(), await put.text()).toBeTruthy();

    expect(codeOf(await commitWith('verify_stock', args, shown))).toBe('PREVIEW_CHANGED');
    expect(await batchesOf(request, headers, cycle.id)).toHaveLength(0);
    // The new figure is what a fresh preview shows: (1,000 + 800) / 40.
    const again = await preview('verify_stock', args);
    expect(again.structuredContent?.data.lines[0].landedUnitCostEgp).toBe('45.0000');
  });
});

// ══════════════════════════════════════════════════════════ add_shipping_leg

test('TC-MCP-DEL-20: add_shipping_leg with an arrival date → the preview lists the units it will deliver', async ({
  request,
}) => {
  const { headers, mk } = await apiCtx(request);
  const tag = stamp();
  const product = await mk('products', { name: `Leg Arrival Part ${tag}`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `Leg Arrival Supplier ${tag}`, country: 'CN' });
  const cycle = await mk('cycles', { originType: 'CHINA', currency: 'EGP' });
  await mk(`cycles/${cycle.id}/transition`, { status: 'FUNDING' });
  await mk(`cycles/${cycle.id}/transition`, { status: 'PURCHASING' });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id,
    currency: 'EGP',
    fxRateToEgp: 1,
    orderedOn: today(),
    items: [{ productId: product.id, orderedQty: 40, unitPrice: 25 }],
  });
  const leg1 = await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1,
    origin: 'Guangzhou, CN',
    destination: 'Dubai, UAE',
    costBasis: 'FLAT',
    amount: 200,
    currency: 'EGP',
    fxRateToEgp: 1,
    departedOn: daysAgo(20),
  });
  const item = (await cycleOf(request, headers, cycle.id)).purchaseOrders[0].items[0];
  // 15 of the 40 reached the UAE; only those can travel on to Egypt.
  await officeDelivers(mk, leg1, item, 15, daysAgo(15));

  const args = {
    cycleId: cycle.id,
    sequence: 2,
    departedOn: daysAgo(10),
    arrivedOn: daysAgo(2),
    amount: 300,
  };
  const shown = await preview('add_shipping_leg', args);

  expect(text(shown)).toContain('recorded as one delivery of everything on the way on this leg');
  expect(text(shown)).toContain(`- ${product.name}: 15`);
  expect(shown.structuredContent?.data.delivers).toEqual([
    { purchaseOrderItemId: item.id, product: product.name, qty: '15' },
  ]);
  expect((await shipmentOf(request, headers, cycle.id)).legs).toHaveLength(1);

  const commit = await commitWith('add_shipping_leg', args, shown);
  expect(commit.isError, text(commit)).toBeFalsy();
  const leg2 = (await shipmentOf(request, headers, cycle.id)).legs[1];
  expect(leg2.deliveries).toHaveLength(1);
  expect(leg2.deliveries[0].lines.map((l: any) => l.qty)).toEqual([15]);
});

// ═════════════════════════════════════════════ what the assistant may not do

test('TC-MCP-DEL-30: there is no tool for marking goods lost (tools/list)', async () => {
  const { tools } = await client!.listTools();
  const names = tools.map((t) => t.name);

  expect(names).toEqual(expect.arrayContaining(['record_delivery', 'verify_stock', 'get_cycle']));
  expect(names.filter((n) => /los[st]|refund/i.test(n))).toEqual([]);
});

test('TC-MCP-DEL-31: an mcp token on the REST delivery endpoints → 403 WRONG_SURFACE, nothing written', async ({
  request,
}) => {
  const { headers, mk } = await apiCtx(request);
  const { cycle, leg, item } = await onTheWay(request, headers, mk);
  const bearer = { Authorization: `Bearer ${access}` };
  const line = [{ purchaseOrderItemId: item.id, qty: 5 }];

  for (const [method, path, data] of [
    ['post', `shipping/legs/${leg.id}/deliveries`, { arrivedOn: daysAgo(3), lines: line }],
    ['post', `shipping/legs/${leg.id}/losses`, { lines: line }],
    ['delete', `shipping/deliveries/${leg.id}`, undefined],
    ['delete', `shipping/losses/${leg.id}`, undefined],
    ['post', 'receipts/verify', { cycleId: cycle.id, deliveryId: leg.id, items: [] }],
  ] as const) {
    const res = await request[method](`${API}/${path}`, { headers: bearer, data });
    expect(res.status(), `${method} ${path}`).toBe(403);
    expect((await res.json()).error.code, `${method} ${path}`).toBe('WRONG_SURFACE');
  }
  const shipment = await shipmentOf(request, headers, cycle.id);
  expect(shipment.legs[0].deliveries).toHaveLength(0);
  expect(shipment.legs[0].lost).toBe(0);
});
