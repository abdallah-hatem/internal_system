/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: the assistant's receipt tools, over /mcp
 * ═══════════════════════════════════════════════════════════════════════
 *  Spec docs/specs/2026-09-19-mcp-assistant.md, "The receipt flow" and
 *  "Confirmation". BUSINESS_LOGIC §15 (an invoice is recorded once; a cycle
 *  past PURCHASING takes no orders) and §16 (nothing written without a
 *  confirmed preview; every change under the partner who signed in).
 *
 *  Driven the way Claude drives them: JSON-RPC `tools/call` on /mcp with an
 *  assistant token, a preview first and the same arguments again with its
 *  token. What was written is then read back through the office API, the way
 *  a partner would see it.
 *
 *  Every cycle, supplier and product is built through the office API as the
 *  office builds them (CLAUDE.md rule 4), with a per-run stamp so reruns do
 *  not collide on the supplier-name rule.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, apiCtx, daysAgo, today } from './support/fixtures';
import { assistantToken, partnerId } from './support/assistant-token';

const ROOT = API.replace(/\/api\/v1\/?$/, '');
const MCP = `${ROOT}/mcp`;
const stamp = () => Math.random().toString(36).slice(2, 8);

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

let nextId = 1;

async function callTool(
  request: APIRequestContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const res = await request.post(MCP, {
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Protocol-Version': '2025-06-18',
      Authorization: `Bearer ${token}`,
    },
    data: { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result as ToolResult;
}

/** Preview, then the same arguments with the token the preview returned. */
async function previewAndConfirm(
  request: APIRequestContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const preview = await callTool(request, token, name, args);
  expect(preview.structuredContent?.error, JSON.stringify(preview.structuredContent)).toBeUndefined();
  expect(preview.structuredContent?.status).toBe('preview');
  const commit = await callTool(request, token, name, {
    ...args,
    confirmationToken: preview.structuredContent!.confirmationToken,
  });
  return { preview, commit };
}

const codeOf = (r: ToolResult) => r.structuredContent?.error?.code;

async function list(request: APIRequestContext, headers: Record<string, string>, path: string): Promise<any[]> {
  const res = await request.get(`${API}/${path}`, { headers });
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  return json.data?.items ?? json.data ?? json;
}

/** A cycle still taking orders, an existing supplier and product, as the office makes them. */
async function world(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const tag = `${label} ${stamp()}`;
  const supplier = await mk('suppliers', { name: `${tag} Supplier`, country: 'CN' });
  const product = await mk('products', { name: `${tag} Part`, minStock: 0 });
  const cycle = await mk('cycles', { originType: 'CHINA', currency: 'CNY' });
  const token = await assistantToken(request);
  return { headers, mk, tag, supplier, product, cycle, token };
}

type World = Awaited<ReturnType<typeof world>>;

function newOrder(w: World, extra: Record<string, unknown> = {}) {
  return {
    cycleId: w.cycle.id,
    supplier: { new: { name: `${w.tag} Brake Works`, country: 'China' } },
    currency: 'CNY',
    fxRateToEgp: 7,
    orderedOn: daysAgo(2),
    supplierInvoiceRef: `INV-${w.tag}`,
    lines: [
      { product: { new: { name: `${w.tag} Rotor`, sku: `RT-${w.tag}` } }, quantity: 20, unitPrice: 30, discountPercent: 5 },
      { product: { new: { name: `${w.tag} Caliper` } }, quantity: 4, unitPrice: 55.5 },
    ],
    ...extra,
  };
}

async function snapshot(request: APIRequestContext, w: World) {
  return {
    suppliers: (await list(request, w.headers, `suppliers?search=${encodeURIComponent(w.tag)}`)).length,
    products: (await list(request, w.headers, `products?search=${encodeURIComponent(w.tag)}`)).length,
    orders: (await list(request, w.headers, `cycles/${w.cycle.id}/purchases`)).length,
  };
}

test.describe('create_purchase_order', () => {
  test('TC-MCP-RC-01: a preview writes nothing (§16)', async ({ request }) => {
    const w = await world(request, 'RC01');
    const before = await snapshot(request, w);

    const r = await callTool(request, w.token, 'create_purchase_order', newOrder(w));

    expect(r.structuredContent?.status).toBe('preview');
    expect(r.content[0].text).toContain('792.00 CNY = 5,544.00 EGP');
    expect(await snapshot(request, w)).toEqual(before);
  });

  test('TC-MCP-RC-02: confirmed with a new supplier and two new products → all created together', async ({
    request,
  }) => {
    const w = await world(request, 'RC02');

    const { commit } = await previewAndConfirm(request, w.token, 'create_purchase_order', newOrder(w));

    expect(commit.structuredContent?.status).toBe('committed');
    const orders = await list(request, w.headers, `cycles/${w.cycle.id}/purchases`);
    expect(orders).toHaveLength(1);
    expect(orders[0].supplier.name).toBe(`${w.tag} Brake Works`);
    expect(orders[0].supplierInvoiceRef).toBe(`INV-${w.tag}`.toUpperCase());
    expect(orders[0].items.map((i: any) => i.product.name)).toEqual([`${w.tag} Rotor`, `${w.tag} Caliper`]);
    expect(orders[0].items.map((i: any) => Number(i.lineTotal))).toEqual([570, 222]);
  });

  test('TC-MCP-RC-03: a line that fails at commit leaves no supplier or product behind', async ({ request }) => {
    const w = await world(request, 'RC03');
    const args = newOrder(w);
    const preview = await callTool(request, w.token, 'create_purchase_order', args);
    // Before the partner says yes, another conversation records a product
    // under the first line's SKU. The commit creates the supplier, then that
    // line fails.
    const clash = await callTool(request, w.token, 'create_product', { name: `${w.tag} Other`, sku: `RT-${w.tag}` });
    await callTool(request, w.token, 'create_product', {
      name: `${w.tag} Other`,
      sku: `RT-${w.tag}`,
      confirmationToken: clash.structuredContent!.confirmationToken,
    });
    const before = await snapshot(request, w);

    const r = await callTool(request, w.token, 'create_purchase_order', {
      ...args,
      confirmationToken: preview.structuredContent!.confirmationToken,
    });

    expect(codeOf(r)).toBe('PRODUCT_SKU_TAKEN');
    expect(await snapshot(request, w)).toEqual(before);
    expect(await list(request, w.headers, `suppliers?search=${encodeURIComponent(`${w.tag} Brake Works`)}`)).toHaveLength(0);
  });

  test('TC-MCP-RC-04: the invoice recorded by someone else between preview and commit → refused, nothing written (§15)', async ({
    request,
  }) => {
    const w = await world(request, 'RC04');
    const args = newOrder(w, { supplier: { id: w.supplier.id } });
    const preview = await callTool(request, w.token, 'create_purchase_order', args);

    await w.mk(`cycles/${w.cycle.id}/purchases`, {
      supplierId: w.supplier.id,
      currency: 'CNY',
      fxRateToEgp: 7,
      orderedOn: daysAgo(1),
      supplierInvoiceRef: ` inv-${w.tag} `,
      items: [{ productId: w.product.id, orderedQty: 1, unitPrice: 1 }],
    });
    const before = await snapshot(request, w);

    const r = await callTool(request, w.token, 'create_purchase_order', {
      ...args,
      confirmationToken: preview.structuredContent!.confirmationToken,
    });

    expect(codeOf(r)).toBe('DUPLICATE_SUPPLIER_INVOICE');
    expect(await snapshot(request, w)).toEqual(before);
  });

  test("TC-MCP-RC-05: a cycle past PURCHASING → the service's refusal", async ({ request }) => {
    const w = await world(request, 'RC05');
    // An order and a dated leg, so the cycle can honestly leave PURCHASING.
    await w.mk(`cycles/${w.cycle.id}/purchases`, {
      supplierId: w.supplier.id, currency: 'CNY', fxRateToEgp: 7, orderedOn: daysAgo(10),
      items: [{ productId: w.product.id, orderedQty: 1, unitPrice: 1 }],
    });
    await w.mk(`cycles/${w.cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Guangzhou, China', destination: 'Dubai, UAE', provider: `${w.tag} Freight`,
      costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1, departedOn: daysAgo(5),
    });
    for (const status of ['FUNDING', 'PURCHASING', 'IN_TRANSIT']) {
      await w.mk(`cycles/${w.cycle.id}/transition`, { status });
    }

    const r = await callTool(request, w.token, 'create_purchase_order', newOrder(w));

    expect(codeOf(r)).toBe('CYCLE_STATUS_BLOCKS_PO');
  });

  test('TC-MCP-RC-06: lines added to a draft; a confirmed order refuses them (§15)', async ({ request }) => {
    const w = await world(request, 'RC06');
    const draft = await w.mk(`cycles/${w.cycle.id}/purchases`, {
      supplierId: w.supplier.id, currency: 'CNY', fxRateToEgp: 7, orderedOn: daysAgo(3),
      items: [{ productId: w.product.id, orderedQty: 10, unitPrice: 5 }],
    });
    const add = {
      addToOrderId: draft.id,
      supplier: { id: w.supplier.id },
      currency: 'CNY',
      lines: [{ product: { id: w.product.id }, quantity: 2, unitPrice: 40 }],
    };

    const { commit } = await previewAndConfirm(request, w.token, 'create_purchase_order', add);
    expect(commit.structuredContent?.status).toBe('committed');
    const [order] = await list(request, w.headers, `cycles/${w.cycle.id}/purchases`);
    expect(order.items).toHaveLength(2);

    // Leaving PURCHASING confirms the draft (§15).
    await w.mk(`cycles/${w.cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Guangzhou, China', destination: 'Dubai, UAE', provider: `${w.tag} Freight`,
      costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1, departedOn: daysAgo(1),
    });
    for (const status of ['FUNDING', 'PURCHASING', 'IN_TRANSIT']) {
      await w.mk(`cycles/${w.cycle.id}/transition`, { status });
    }
    const late = await callTool(request, w.token, 'create_purchase_order', add);
    expect(codeOf(late)).toBe('PO_NOT_DRAFT');
  });

  test('TC-MCP-RC-07: money and dates that cannot be true are refused', async ({ request }) => {
    const w = await world(request, 'RC07');
    const line = (over: Record<string, unknown>) => ({
      lines: [{ product: { id: w.product.id }, quantity: 1, unitPrice: 10, ...over }],
    });
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ orderedOn: nextWeek }, 'DATE_IN_FUTURE'],
      [{ fxRateToEgp: 0 }, 'RATE_NOT_POSITIVE'],
      [{ fxRateToEgp: -7 }, 'RATE_NOT_POSITIVE'],
      [line({ discountPercent: 150 }), 'DISCOUNT_PERCENT_INVALID'],
      [line({ unitPrice: -1 }), 'PRICE_NEGATIVE'],
      [line({ quantity: 0 }), 'QTY_NOT_POSITIVE'],
      [line({ quantity: -2 }), 'QTY_NOT_POSITIVE'],
    ];
    for (const [over, code] of cases) {
      const r = await callTool(request, w.token, 'create_purchase_order', newOrder(w, over));
      expect(codeOf(r), JSON.stringify(over)).toBe(code);
    }
    expect((await snapshot(request, w)).orders).toBe(0);
  });

  test('TC-MCP-RC-08: a unit price of zero is accepted — free goods are real', async ({ request }) => {
    const w = await world(request, 'RC08');
    const { commit } = await previewAndConfirm(
      request,
      w.token,
      'create_purchase_order',
      newOrder(w, { lines: [{ product: { id: w.product.id }, quantity: 3, unitPrice: 0 }] }),
    );
    expect(commit.structuredContent?.status).toBe('committed');
  });

  test('TC-MCP-RC-09: the audit log names the signed-in partner (§16)', async ({ request }) => {
    const w = await world(request, 'RC09');
    const { commit } = await previewAndConfirm(request, w.token, 'create_purchase_order', newOrder(w));
    const orderId = commit.structuredContent!.data.orderId;

    const entries = await list(request, w.headers, `audit-logs?entityType=PurchaseOrder&entityId=${orderId}`);

    expect(entries).toHaveLength(1);
    expect(entries[0].actorUserId).toBe(await partnerId(request));
  });

  test('TC-MCP-RC-10: a changed line between preview and commit → CONFIRMATION_MISMATCH, nothing written', async ({
    request,
  }) => {
    const w = await world(request, 'RC10');
    const args = newOrder(w);
    const preview = await callTool(request, w.token, 'create_purchase_order', args);
    const changed = newOrder(w);
    (changed.lines[1] as any).quantity = 40;

    const r = await callTool(request, w.token, 'create_purchase_order', {
      ...changed,
      confirmationToken: preview.structuredContent!.confirmationToken,
    });

    expect(codeOf(r)).toBe('CONFIRMATION_MISMATCH');
    expect((await snapshot(request, w)).orders).toBe(0);
  });

  test('TC-MCP-RC-11: an id that belongs to nothing → a coded NOT_FOUND, never a 500', async ({ request }) => {
    const w = await world(request, 'RC11');
    const r = await callTool(
      request,
      w.token,
      'create_purchase_order',
      newOrder(w, { lines: [{ product: { id: '6f1c2b1e-0000-4000-8000-000000000000' }, quantity: 1, unitPrice: 1 }] }),
    );
    expect(r.structuredContent?.error).toMatchObject({ code: 'NOT_FOUND', params: { entity: 'product' } });
  });
});

test.describe('create_supplier and create_product', () => {
  test('TC-MCP-RC-12: a supplier name already on file, in any case → refused, naming it', async ({ request }) => {
    const w = await world(request, 'RC12');
    const r = await callTool(request, w.token, 'create_supplier', {
      name: `${w.tag} SUPPLIER co., ltd.`.toLowerCase(),
      country: 'CN',
    });
    expect(codeOf(r)).toBe('SUPPLIER_NAME_TAKEN');
    expect(r.structuredContent?.error?.params).toEqual({ name: w.supplier.name });
  });

  test('TC-MCP-RC-13: a SKU already on file → refused', async ({ request }) => {
    const w = await world(request, 'RC13');
    const r = await callTool(request, w.token, 'create_product', {
      name: `${w.tag} Copy`,
      sku: w.product.sku.toLowerCase(),
    });
    expect(codeOf(r)).toBe('PRODUCT_SKU_TAKEN');
  });
});

test.describe('match_receipt', () => {
  test('TC-MCP-RC-14: a receipt already recorded is asked about, and nothing is written', async ({ request }) => {
    const w = await world(request, 'RC14');
    await w.mk(`cycles/${w.cycle.id}/purchases`, {
      supplierId: w.supplier.id, currency: 'CNY', fxRateToEgp: 7, orderedOn: today(),
      supplierInvoiceRef: `M-${w.tag}`,
      items: [{ productId: w.product.id, orderedQty: 1, unitPrice: 1 }],
    });
    const before = await snapshot(request, w);

    const r = await callTool(request, w.token, 'match_receipt', {
      supplierName: w.supplier.name,
      invoiceNumber: `m-${w.tag}`,
      date: today(),
      currency: 'CNY',
      lines: [{ description: w.product.name, sku: w.product.sku, quantity: 1, unitPrice: 1 }],
    });

    const kinds = r.structuredContent!.data.questions.map((q: any) => q.kind);
    expect(kinds).toContain('DUPLICATE_INVOICE');
    expect(r.structuredContent!.data.findings.cycles.open.map((c: any) => c.id)).toContain(w.cycle.id);
    expect(await snapshot(request, w)).toEqual(before);
  });
});
