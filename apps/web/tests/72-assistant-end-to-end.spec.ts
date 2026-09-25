/* eslint-disable @typescript-eslint/no-explicit-any -- API and MCP responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: the whole connector path, end to end over HTTP
 * ═══════════════════════════════════════════════════════════════════════
 *  Plan docs/plans/2026-09-19-mcp-assistant.md, T10. BUSINESS_LOGIC §15 (an
 *  invoice is recorded once) and §16 (partners only; nothing written without a
 *  confirmed preview; access valid nowhere but the assistant's tools; every
 *  change under the partner who signed in).
 *
 *  Nothing is faked. The partner signs Claude in the way claude.ai does —
 *  dynamic client registration, the sign-in page, a code with PKCE, the token
 *  exchange — and the MCP SDK's own client connects over Streamable HTTP with
 *  the access token that came out of it. No hand-signed token appears in the
 *  main path. A realistic receipt is matched, its questions are answered, the
 *  order is previewed and confirmed, and what was written is read back through
 *  the office API with an ordinary internal login.
 *
 *  The cycle, supplier and products the receipt refers to are built through
 *  the office API as the office builds them (CLAUDE.md rule 4), each named with
 *  a per-run tag so reruns never collide on the supplier-name or SKU rules.
 *
 *  The main path is serial: each step leaves the state the next one reads, the
 *  way a single conversation with Claude would.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { API, EMAIL, PASSWORD, apiCtx, daysAgo } from './support/fixtures';
import { partnerId } from './support/assistant-token';
import { ROOT, codeFor, redeem, claimsOf } from './support/oauth-flow';

const MCP = `${ROOT}/mcp`;
const CHALLENGE = /^Bearer resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource"$/;

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

/** The tools a partner's Claude is given: reading, the receipt path, the cycle path. */
const EXPECTED_TOOLS = [
  // read
  'find_suppliers', 'find_products', 'list_cycles', 'get_cycle', 'get_stock',
  'list_sales', 'get_customer', 'list_payments', 'get_dashboard', 'get_fx_rates',
  // receipt
  'match_receipt', 'create_purchase_order', 'create_supplier', 'create_product',
  // cycle
  'create_cycle', 'add_shipping_leg', 'transition_cycle', 'verify_stock',
];

/** The intake path, receipt to sellable stock — the only things it may change (§16). */
const WRITE_TOOLS = [
  'create_purchase_order', 'create_supplier', 'create_product',
  'create_cycle', 'add_shipping_leg', 'transition_cycle', 'verify_stock',
];

/**
 * A tool whose name would write what §16 keeps in the office app. The read
 * tools `list_sales` and `list_payments` are allowed by name; anything that
 * records, changes or removes those records is not.
 */
const FORBIDDEN_WRITE =
  /^(create|record|add|update|edit|set|delete|remove|cancel|approve|reverse|refund|allocate|settle|close|pay)_.*(sale|payment|instal|settle|ledger|return|refund|plan)/;

// ════════════════════════════════════════════════════════════ the conversation

test.describe.serial('A partner connects Claude and records a receipt through it', () => {
  // Carried from step to step, as one conversation carries it.
  let access = '';
  let client: Client | undefined;
  let headers: Record<string, string> = {};
  let tag = '';
  let cycle: any;
  let supplier: any;
  let skuProduct: any;
  let nameProduct: any;
  let receipt: Record<string, any> = {};
  let analysis: any;
  let newProductId = '';
  let orderArgs: Record<string, unknown> = {};
  let committedToken = '';
  let orderId = '';

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    expect(client, 'the MCP client is connected').toBeTruthy();
    return (await client!.callTool({ name, arguments: args })) as ToolResult;
  };

  /** Every purchase order on this run's cycle, as the office sees them. */
  const ordersOnCycle = async (request: APIRequestContext): Promise<any[]> => {
    const res = await request.get(`${API}/cycles/${cycle.id}/purchases`, { headers });
    expect(res.ok(), await res.text()).toBeTruthy();
    const json = await res.json();
    return json.data?.items ?? json.data ?? json;
  };

  test.afterAll(async () => {
    await client?.close();
  });

  test('the office already knows the supplier, two of the products and an open cycle', async ({ request }) => {
    const ctx = await apiCtx(request);
    headers = ctx.headers;
    tag = `E2E${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    supplier = await ctx.mk('suppliers', { name: `${tag} Guangzhou Moto Parts`, country: 'CN' });
    skuProduct = await ctx.mk('products', { name: `${tag} Rear Sprocket 45T`, minStock: 0 });
    nameProduct = await ctx.mk('products', { name: `${tag} Chain Kit 428H`, minStock: 0 });
    // A new China cycle, moved into PURCHASING the way the office moves it.
    cycle = await ctx.mk('cycles', { originType: 'CHINA', currency: 'CNY' });
    for (const status of ['FUNDING', 'PURCHASING']) {
      await ctx.mk(`cycles/${cycle.id}/transition`, { status });
    }
    expect(skuProduct.sku, 'the office gives every product a SKU').toBeTruthy();
  });

  test('OAuth as claude.ai does it: register → sign in → code with PKCE → token', async ({ request }) => {
    // Dynamic registration, then the partner's own login on the sign-in page.
    const c = await codeFor(request, EMAIL, PASSWORD);
    const res = await redeem(request, c);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.token_type).toMatch(/^bearer$/i);
    expect(res.body.refresh_token).toBeTruthy();
    access = res.body.access_token;
    const claims = claimsOf(access);
    expect(claims.aud).toBe('mcp');
    expect(claims.sub).toBe(await partnerId(request));
  });

  test('the MCP SDK client connects over Streamable HTTP with that token and lists the tools', async () => {
    client = new Client({ name: 'claude-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(MCP), {
        requestInit: { headers: { Authorization: `Bearer ${access}` } },
      }),
    );
    expect(client.getServerVersion()?.name).toBe('motoparts');

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(names.filter((n) => FORBIDDEN_WRITE.test(n))).toEqual([]);
    // Only the intake path writes; every other tool declares that it only reads.
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(!WRITE_TOOLS.includes(t.name));
    }
  });

  test('match_receipt on a realistic receipt asks exactly what is left open', async ({ request }) => {
    const before = (await ordersOnCycle(request)).length;
    // As Claude would read it off the paper: the supplier's name in capitals
    // with a hyphen and the legal form, the invoice number in lower case with
    // stray spaces, one line carrying the printed code of a product on file,
    // one named as the product is, one the office has never seen, and a
    // shipping charge below the subtotal.
    receipt = {
      supplierName: `${tag}  GUANGZHOU-MOTO PARTS Co., Ltd.`,
      invoiceNumber: `  gz-${tag.toLowerCase()}-0917 `,
      date: daysAgo(3),
      currency: 'cny',
      lines: [
        { description: 'Sprocket rear 45 teeth', sku: ` ${skuProduct.sku.toLowerCase()} `, quantity: 40, unitPrice: 12.5 },
        { description: `${tag.toLowerCase()} chain kit 428h`, quantity: 10, unitPrice: '86.40', discountPercent: 5 },
        { description: `${tag} Throttle Cable Assembly`, sku: `TC-${tag}`, quantity: 25, unitPrice: 9.8 },
      ],
      charges: [{ kind: 'shipping', label: 'Freight to Guangzhou port', amount: 120 }],
      // 500.00 + 820.80 + 245.00
      statedSubtotal: '1565.80',
      statedTotal: '1685.80',
    };

    const r = await call('match_receipt', receipt);

    expect(r.isError).toBeFalsy();
    analysis = r.structuredContent!.data;
    expect(analysis.supplier).toMatchObject({ status: 'matched', match: { id: supplier.id } });
    expect(analysis.lines.map((l: any) => l.status)).toEqual(['matched', 'matched', 'unknown']);
    expect(analysis.lines[0].match).toMatchObject({ id: skuProduct.id, via: 'sku' });
    expect(analysis.lines[1].match).toMatchObject({ id: nameProduct.id, via: 'name' });
    expect(analysis.lines.map((l: any) => l.lineTotal)).toEqual(['500.00', '820.80', '245.00']);
    expect(analysis.findings.invoiceNumber).toBe(`GZ-${tag}-0917`);
    expect(analysis.findings.totals).toMatchObject({ computedSubtotal: '1565.80', difference: '0.00' });
    expect(analysis.findings.cycles.open.map((c: any) => c.id)).toContain(cycle.id);

    const ids: string[] = analysis.questions.map((q: any) => q.id);
    const blocking: string[] = analysis.questions.filter((q: any) => q.blocking).map((q: any) => q.id);
    // Which cycle depends on what else is open in the database; that it is
    // asked is certain. Everything else is fixed by this receipt.
    expect(ids.filter((id) => id === 'CYCLE_WHICH' || id === 'CYCLE_CONFIRM')).toHaveLength(1);
    expect(blocking.filter((id) => id !== 'CYCLE_WHICH')).toEqual(['LINE_NEW_OR_EXISTING:3']);
    expect(ids).toEqual(expect.arrayContaining(['FX_RATE_CONFIRM', 'CHARGES_WHERE', 'LINE_NEW_OR_EXISTING:3']));
    for (const absent of ['SUPPLIER_NEW', 'SUPPLIER_WHICH', 'DUPLICATE_INVOICE', 'TOTALS_MISMATCH', 'ADD_OR_SEPARATE']) {
      expect(ids, absent).not.toContain(absent);
    }
    expect((await ordersOnCycle(request)).length).toBe(before);
  });

  test('the unknown line becomes a product: previewed, then confirmed', async ({ request }) => {
    const args = { name: `${tag} Throttle Cable Assembly`, sku: `TC-${tag}` };
    const search = async () => {
      const res = await request.get(`${API}/products?search=${encodeURIComponent(`TC-${tag}`)}`, { headers });
      const json = await res.json();
      return (json.data?.items ?? json.data ?? json) as any[];
    };

    const preview = await call('create_product', args);
    expect(preview.structuredContent?.status).toBe('preview');
    expect(await search()).toHaveLength(0);

    const commit = await call('create_product', {
      ...args,
      confirmationToken: preview.structuredContent!.confirmationToken,
    });
    expect(commit.structuredContent?.status, JSON.stringify(commit.structuredContent)).toBe('committed');
    const found = await search();
    expect(found).toHaveLength(1);
    expect(found[0].sku).toBe(`TC-${tag}`);
    newProductId = found[0].id;
  });

  test('create_purchase_order: the preview writes nothing, the confirmation commits', async ({ request }) => {
    // The answers: this run's cycle, the rate on file, charges left off.
    orderArgs = {
      cycleId: cycle.id,
      supplier: { id: supplier.id },
      currency: 'CNY',
      fxRateToEgp: Number(analysis.findings.fx.rate),
      orderedOn: receipt.date,
      supplierInvoiceRef: receipt.invoiceNumber,
      lines: [
        { product: { id: skuProduct.id }, quantity: 40, unitPrice: 12.5 },
        { product: { id: nameProduct.id }, quantity: 10, unitPrice: 86.4, discountPercent: 5 },
        { product: { id: newProductId }, quantity: 25, unitPrice: 9.8 },
      ],
    };

    const preview = await call('create_purchase_order', orderArgs);
    expect(preview.structuredContent?.status, JSON.stringify(preview.structuredContent)).toBe('preview');
    expect(preview.structuredContent!.data.linesTotal).toBe('1565.80');
    // Read back as the office would, with an ordinary internal login.
    expect(await ordersOnCycle(request)).toHaveLength(0);

    committedToken = preview.structuredContent!.confirmationToken!;
    const commit = await call('create_purchase_order', { ...orderArgs, confirmationToken: committedToken });
    expect(commit.structuredContent?.status, JSON.stringify(commit.structuredContent)).toBe('committed');
    orderId = commit.structuredContent!.data.orderId;
    expect(await ordersOnCycle(request)).toHaveLength(1);
  });

  test('the office API shows the order as the receipt describes it, under the partner who signed in', async ({
    request,
  }) => {
    const [order] = await ordersOnCycle(request);

    expect(order.id).toBe(orderId);
    expect(order.supplierId).toBe(supplier.id);
    expect(order.currency).toBe('CNY');
    expect(order.supplierInvoiceRef).toBe(`GZ-${tag}-0917`);
    expect(order.status).toBe('DRAFT');
    const byProduct = (a: { product: string }, b: { product: string }) => a.product.localeCompare(b.product);
    expect(
      order.items
        .map((i: any) => ({
          product: i.productId as string,
          qty: Number(i.orderedQty),
          price: Number(i.unitPrice),
          discount: Number(i.discount),
          total: Number(i.lineTotal),
        }))
        .sort(byProduct),
    ).toEqual(
      [
        { product: skuProduct.id, qty: 40, price: 12.5, discount: 0, total: 500 },
        { product: nameProduct.id, qty: 10, price: 86.4, discount: 5, total: 820.8 },
        { product: newProductId, qty: 25, price: 9.8, discount: 0, total: 245 },
      ].sort(byProduct),
    );

    const res = await request.get(`${API}/audit-logs?entityType=PurchaseOrder&entityId=${orderId}`, { headers });
    const json = await res.json();
    const entries: any[] = json.data?.items ?? json.data ?? json;
    expect(entries).toHaveLength(1);
    expect(entries[0].actorUserId).toBe(await partnerId(request));
  });

  test('the same OAuth access token opens no office route: 403 WRONG_SURFACE', async ({ request }) => {
    const bearer = { Authorization: `Bearer ${access}` };
    const routes: Array<['get' | 'post', string]> = [
      ['get', '/payments'],
      ['post', '/payments'],
      ['get', '/sales/orders'],
      ['post', '/sales/orders'],
      ['get', '/settlements'],
      ['get', '/ledger'],
      ['post', '/ledger'],
      // The very order it just wrote, through the office's door.
      ['get', `/purchases/${orderId}`],
    ];
    for (const [method, path] of routes) {
      const res = await request[method](`${API}${path}`, {
        headers: bearer,
        ...(method === 'post' ? { data: {} } : {}),
      });
      expect(res.status(), `${method.toUpperCase()} ${path}`).toBe(403);
      expect((await res.json()).error.code, path).toBe('WRONG_SURFACE');
    }
  });

  // ─────────────────────────────────────────────────────────── break it

  test('replaying the confirmation token after commit → CONFIRMATION_USED, still one order', async ({ request }) => {
    const r = await call('create_purchase_order', { ...orderArgs, confirmationToken: committedToken });

    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe('CONFIRMATION_USED');
    expect(await ordersOnCycle(request)).toHaveLength(1);
  });

  test('the same receipt sent again → DUPLICATE_INVOICE asked, DUPLICATE_SUPPLIER_INVOICE refused, still one order', async ({
    request,
  }) => {
    // The same photo, sent by a partner not sure it went through — the number
    // read a little differently again.
    const again = await call('match_receipt', { ...receipt, invoiceNumber: `GZ-${tag}-0917` });
    const questions: any[] = again.structuredContent!.data.questions;
    const dup = questions.find((q) => q.id === 'DUPLICATE_INVOICE');
    expect(dup, JSON.stringify(questions.map((q) => q.id))).toBeTruthy();
    expect(dup.blocking).toBe(true);
    expect(again.structuredContent!.data.blocked).toBe(true);

    const r = await call('create_purchase_order', { ...orderArgs, supplierInvoiceRef: ` gz-${tag.toLowerCase()}-0917` });
    expect(codeOf(r)).toBe('DUPLICATE_SUPPLIER_INVOICE');
    expect(r.structuredContent?.confirmationToken).toBeUndefined();
    expect(await ordersOnCycle(request)).toHaveLength(1);
  });

  test('a confirmation token used with a changed quantity → CONFIRMATION_MISMATCH, nothing written', async ({
    request,
  }) => {
    // A second, genuine receipt from the same supplier, previewed...
    const second = {
      ...orderArgs,
      supplierInvoiceRef: `GZ-${tag}-0918`,
      lines: [{ product: { id: skuProduct.id }, quantity: 12, unitPrice: 12.5 }],
    };
    const preview = await call('create_purchase_order', second);
    expect(preview.structuredContent?.status, JSON.stringify(preview.structuredContent)).toBe('preview');

    // ...and "yes" said to 12 but sent with 120.
    const r = await call('create_purchase_order', {
      ...second,
      lines: [{ product: { id: skuProduct.id }, quantity: 120, unitPrice: 12.5 }],
      confirmationToken: preview.structuredContent!.confirmationToken,
    });

    expect(codeOf(r)).toBe('CONFIRMATION_MISMATCH');
    const orders = await ordersOnCycle(request);
    expect(orders).toHaveLength(1);
    expect(orders[0].items).toHaveLength(3);
  });
});

// ══════════════════════════════════════════════════════ the door, broken

test.describe('Breaking the way in', () => {
  test('the authorization code used twice → the second exchange is refused', async ({ request }) => {
    const c = await codeFor(request, EMAIL, PASSWORD);
    const first = await redeem(request, c);
    expect(first.status).toBe(200);

    const second = await redeem(request, c);

    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
    expect(second.body.access_token).toBeUndefined();
  });

  test('no bearer or a garbage bearer on /mcp → 401 with WWW-Authenticate pointing at resource metadata', async ({
    request,
  }) => {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0.0' } },
    };
    const cases: Array<[string, Record<string, string>, string]> = [
      ['no bearer', {}, 'AUTH_REQUIRED'],
      ['garbage bearer', { Authorization: 'Bearer not.a.token' }, 'SESSION_INVALID'],
    ];
    for (const [label, auth, code] of cases) {
      const res = await request.post(MCP, {
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...auth },
        data: initialize,
      });
      expect(res.status(), label).toBe(401);
      const challenge = res.headers()['www-authenticate'];
      expect(challenge, label).toMatch(CHALLENGE);
      expect(challenge).toContain(`${ROOT}/.well-known/oauth-protected-resource`);
      expect((await res.json()).error.code, label).toBe(code);
    }

    // And the SDK's client, given nothing to sign in with, does not get in.
    const stranger = new Client({ name: 'claude-e2e-stranger', version: '1.0.0' });
    await expect(stranger.connect(new StreamableHTTPClientTransport(new URL(MCP)))).rejects.toThrow();
  });
});
