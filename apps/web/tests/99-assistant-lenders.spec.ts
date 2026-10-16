/* eslint-disable @typescript-eslint/no-explicit-any -- API and MCP responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: the assistant and a friend who paid a supplier (L2, item 2)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §16 (what the assistant may do) and §18 (a purchase paid
 *  by a friend, repaid in pounds at the day's rate).
 *
 *  As 96 does it: the partner signs Claude in through the real OAuth flow and
 *  the MCP SDK's own client calls the lender tools over Streamable HTTP. The
 *  order is real — a dirham order on a cycle built the business's way
 *  (CLAUDE.md rule 4) — and what the assistant wrote is read back through the
 *  office's own endpoints and, once, on the friend's page reached by clicking.
 *
 *  Unit tests for the same cases: apps/api/src/modules/assistant/tools/lenders.spec.ts.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { API, EMAIL, PASSWORD, apiCtx, daysAgo } from './support/fixtures';
import { ROOT, codeFor, redeem } from './support/oauth-flow';
import { login, messages, openNav } from './support/ui';

const MCP = `${ROOT}/mcp`;
const en = messages('en');

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
  client = new Client({ name: 'claude-e2e-lenders', version: '1.0.0' });
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
const confirm = (name: string, args: Record<string, unknown>, shown: ToolResult) =>
  tool(name, { ...args, confirmationToken: shown.structuredContent!.confirmationToken });

/**
 * 100 parts at 300 AED on one order at 13.00 — 30,000 AED, 390,000 EGP — and
 * 13,000 EGP of freight. The cycle is still buying, as a friend's payment is
 * usually recorded while the goods are on order.
 */
async function dirhamOrder(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const s = stamp();
  const product = await mk('products', { name: `${label} ${s} Exhaust`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `${label} ${s} Dubai Trading`, country: 'AE' });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
  const po = await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'AED', fxRateToEgp: 13, orderedOn: daysAgo(30),
    items: [{ productId: product.id, orderedQty: 100, unitPrice: 300 }],
  });
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    costBasis: 'FLAT', amount: 13000, currency: 'EGP', fxRateToEgp: 1,
  });
  return { headers, mk, cycle, po, s };
}

async function todaysAed(request: APIRequestContext, headers: Record<string, string>) {
  const rates = (await (await request.get(`${API}/currency-rates`, { headers })).json()).data as any[];
  return Number(rates.find((r) => r.code === 'AED').rateToEgp);
}

test.describe('The assistant and a friend who paid a supplier (§16, §18 — L2)', () => {
  test('TC-AL-01: "<friend> paid 30,000 AED for <PO>" — a new friend is asked, then added only on yes; the preview shows what partners fund; his page shows it', async ({
    page,
    request,
  }) => {
    const { headers, cycle, po, s } = await dirhamOrder(request, 'AL01');
    const friend = `Mahmoud AL ${s}`;
    const args = { lender: friend, order: po.reference, amount: 30000, currency: 'AED' };

    // Unknown: a question, nothing to confirm.
    const asked = await tool('record_lender_financing', args);
    expect(asked.structuredContent?.status, text(asked)).toBe('needs_answers');
    expect(asked.structuredContent?.confirmationToken).toBeUndefined();
    expect(asked.structuredContent?.data.questions[0].id).toBe('LENDER_NEW');

    const withNew = { ...args, newLender: true };
    const shown = await tool('record_lender_financing', withNew);
    expect(shown.structuredContent?.status, text(shown)).toBe('preview');
    expect(shown.structuredContent?.data).toMatchObject({
      lender: { id: null, name: friend, isNew: true },
      amount: '30000.00',
      amountEgp: '390000.00',
      partnersFundBeforeEgp: '403000.00',
      partnersFundAfterEgp: '13000.00',
    });
    expect(text(shown)).toContain('Partners fund 403,000.00 EGP of the cycle before this, 13,000.00 EGP after.');
    // Nothing written by the preview: no friend of that name, nothing financed.
    const lenders = (await (await request.get(`${API}/lenders`, { headers })).json()).data as any[];
    expect(lenders.find((l) => l.name === friend)).toBeUndefined();
    expect((await (await request.get(`${API}/purchases/${po.id}/financings`, { headers })).json()).data.financedEgp).toBe('0.00');

    // A changed amount is not what was agreed.
    expect(codeOf(await confirm('record_lender_financing', { ...withNew, amount: 20000 }, shown))).toBe('CONFIRMATION_MISMATCH');

    const done = await confirm('record_lender_financing', withNew, shown);
    expect(done.structuredContent?.status, text(done)).toBe('committed');
    const onOrder = (await (await request.get(`${API}/purchases/${po.id}/financings`, { headers })).json()).data;
    // Told in pounds (§18, 2026-10-16): 30,000 AED at the order's 13.
    expect(onOrder.financedEgp).toBe('390000.00');
    expect(onOrder.financings[0].lender.name).toBe(friend);
    const costing = (await (await request.get(`${API}/costing/cycles/${cycle.id}/landed-cost`, { headers })).json());
    expect(costing.totals.toFundEgp).toBe('13000.00');

    // What a partner sees afterwards, reached the way he reaches it.
    await login(page);
    await openNav(page, en.nav.lenders);
    await expect(page).toHaveURL(/\/en\/lenders$/, { timeout: 15000 });
    const main = page.getByRole('main');
    await main.getByRole('link', { name: friend, exact: true }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/lenders\/[0-9a-f-]{36}$/, { timeout: 15000 });
    await expect(page.getByTestId('financing-card').getByTestId('financing-owed')).toHaveText('30,000.00 AED');
  });

  test("TC-AL-02: \"paid him 50,000 pounds today\" — today's rate, said so; clears, still owed and exchange difference; then \"pay him off\" ends at exactly zero; too much is refused", async ({
    request,
  }) => {
    const { headers, mk, po, s } = await dirhamOrder(request, 'AL02');
    const lender = await mk('lenders', { name: `Sami AL ${s}` });
    await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 30000, paidOn: daysAgo(20) });
    const rate = await todaysAed(request, headers);

    // No account is asked, stored or shown: money accounts were removed (owner 2026-10-14).
    const args = { lender: lender.name, amountEgp: 50000 };
    const shown = await tool('record_lender_repayment', args);
    expect(shown.structuredContent?.status, text(shown)).toBe('preview');
    const cleared = Math.floor((50000 / rate) * 100) / 100;
    expect(shown.structuredContent?.data).toMatchObject({
      rateToEgp: rate.toFixed(4),
      rateFrom: 'today',
      cleared: cleared.toFixed(2),
      owedBefore: '30000.00',
      owedAfter: (30000 - cleared).toFixed(2),
      exchangeDiffEgp: (50000 - Math.round(cleared * 13 * 100) / 100).toFixed(2),
    });
    expect(text(shown)).toContain("today's rate on the exchange-rate page");
    expect(shown.structuredContent?.data).not.toHaveProperty('account');
    expect(text(shown)).not.toMatch(/account/i);
    const before = (await (await request.get(`${API}/lenders/${lender.id}`, { headers })).json()).data;
    expect(before.financings[0].repayments).toHaveLength(0);

    // Too much: refused with the settling figure; no token.
    const tooMuch = await tool('record_lender_repayment', { ...args, amountEgp: 10_000_000 });
    expect(codeOf(tooMuch)).toBe('LENDER_REPAYMENT_EXCEEDS_OWED');
    expect(tooMuch.structuredContent?.confirmationToken).toBeUndefined();
    // A day that has not come.
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(codeOf(await tool('record_lender_repayment', { ...args, paidOn: tomorrow }))).toBe('DATE_IN_FUTURE');

    const done = await confirm('record_lender_repayment', args, shown);
    expect(done.structuredContent?.status, text(done)).toBe('committed');
    const after = (await (await request.get(`${API}/lenders/${lender.id}`, { headers })).json()).data.financings[0];
    expect(after.owed).toBe((30000 - cleared).toFixed(2));
    expect(after.repayments[0]).toMatchObject({ amountEgp: '50000.00', rateToEgp: rate.toFixed(4) });
    expect(after.repayments[0]).not.toHaveProperty('account');

    // "Pay him off" at a rate he gives: the exact settling figure, owed ends at zero.
    const off = { lender: lender.name, payOff: true, rateToEgp: 13.5 };
    const quote = (await (await request.get(`${API}/lender-financings/${after.id}/quote?rateToEgp=13.5`, { headers })).json()).data;
    const offShown = await tool('record_lender_repayment', off);
    expect(offShown.structuredContent?.data).toMatchObject({ amountEgp: quote.settlingEgp, rateFrom: 'given', owedAfter: '0.00' });
    expect((await confirm('record_lender_repayment', off, offShown)).structuredContent?.status).toBe('committed');
    const paidOff = (await (await request.get(`${API}/lenders/${lender.id}`, { headers })).json()).data.financings[0];
    expect(paidOff.owed).toBe('0.00');
    // Nothing is owed now: a further repayment is refused.
    expect(codeOf(await tool('record_lender_repayment', args))).toBe('LENDER_NOT_OWED');
  });

  test("TC-AL-03: list_lenders and get_lender say what the office says — in his currency and in pounds at today's rate", async ({ request }) => {
    const { headers, mk, po, s } = await dirhamOrder(request, 'AL03');
    const lender = await mk('lenders', { name: `Karim AL ${s}` });
    await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 12000 });
    const rate = await todaysAed(request, headers);

    const office = ((await (await request.get(`${API}/lenders`, { headers })).json()).data as any[]).find((l) => l.id === lender.id);
    const listed = ((await tool('list_lenders', {})).structuredContent?.data as any[]).find((l) => l.lenderId === lender.id);
    expect(listed.owed).toEqual([
      { currency: 'AED', owed: office.owed[0].owed, rateToEgp: rate.toFixed(4), owedEgp: (12000 * rate).toFixed(2) },
    ]);

    const one = await tool('get_lender', { lender: lender.name });
    expect(one.isError, text(one)).toBeFalsy();
    expect(one.structuredContent?.data.financings[0]).toMatchObject({ order: po.reference, paid: '12000.00', owed: '12000.00' });
  });

  test('TC-AL-04: a currency with no rate, zero, more than the order, and an order that does not exist are refused with a code; nothing recorded', async ({ request }) => {
    const { headers, po, s } = await dirhamOrder(request, 'AL04');
    const base = { lender: `Nobody AL ${s}`, newLender: true, order: po.reference };
    // His own currency is allowed (§18, 2026-10-16); one with no rate on file is not.
    expect(codeOf(await tool('record_lender_financing', { ...base, amount: 100, currency: 'GBP' }))).toBe('NO_RATE_RECORDED');
    expect(codeOf(await tool('record_lender_financing', { ...base, amount: 0 }))).toBe('AMOUNT_NOT_POSITIVE');
    expect(codeOf(await tool('record_lender_financing', { ...base, amount: 30000.01 }))).toBe('FINANCING_EXCEEDS_ORDER');
    expect(codeOf(await tool('record_lender_financing', { ...base, amount: 5, order: 'PO-1999-0000' }))).toBe('NOT_FOUND');
    expect((await (await request.get(`${API}/purchases/${po.id}/financings`, { headers })).json()).data.financedEgp).toBe('0.00');
    const lenders = (await (await request.get(`${API}/lenders`, { headers })).json()).data as any[];
    expect(lenders.find((l) => l.name === base.lender)).toBeUndefined();
  });
});
