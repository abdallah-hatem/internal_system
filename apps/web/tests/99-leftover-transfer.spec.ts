/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: L5 — leftover stock moves to another cycle at its cost
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §8 (owner 2026-10-11). Cycle A finished selling with units
 *  on the shelf; a partner moves some or all of them to cycle B at exactly
 *  their landed cost. A makes no profit and no loss on them; B funds them.
 *
 *  Every flow reaches its screen through the menu (CLAUDE.md §2); cycles are
 *  built through the API the way the business builds them — an order, a leg,
 *  a receipt, a confirmed sale (§4). The rules' own tests:
 *  apps/api/src/modules/stock-transfers/stock-transfers.spec.ts,
 *  apps/api/src/common/stock-transfers.spec.ts, and the Vitest beside the
 *  dialog and the unsold-stock prompt. Money invariants: 34 (TC-INV-51..53).
 *
 *  `L5_SHOTS=1` also writes the review screenshots to .ui-audit/l5/.
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { psqlStdin } from './support/database';
import { DB_CONTAINER, DB_NAME } from './support/env';
import { API, apiCtx, PASSWORD, refusedCallers } from './support/fixtures';
import { leftoverWorld } from './support/leftovers';
import { BASE, login, messages, openView, type Locale } from './support/ui';

const INVESTOR_EMAIL = 'investor@motoparts.com';
const SHOTS = process.env.L5_SHOTS === '1';
const SHOT_DIR = '../../.ui-audit/l5';
type Headers = Record<string, string>;

/**
 * `next dev` draws its own badge in the bottom corner — the start corner, so
 * on the left in Arabic, over the phone bar's menu button. It is not part of
 * the app (a build has none) and must not be in a review screenshot.
 */
async function hideDevBadge(page: Page) {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

/** Menu → Cycles → search the code → the row → its details page. */
async function openCycle(page: Page, code: string, id: string, locale: Locale = 'en') {
  const phone = (page.viewportSize()?.width ?? 1440) < 768;
  if (phone) {
    await hideDevBadge(page);
    await page.locator('button:has(svg.lucide-menu)').filter({ visible: true }).first().click();
    await page.locator(`a[href="/${locale}/cycles"]`).filter({ visible: true }).first().click();
  } else {
    await page.locator(`aside a[href="/${locale}/cycles"]`).filter({ visible: true }).first().click();
  }
  await expect(page).toHaveURL(new RegExp(`/${locale}/cycles$`), { timeout: 15000 });
  const main = page.getByRole('main');
  await main.getByPlaceholder(messages(locale).cycles.search).fill(code);
  if (phone) await main.getByTestId('cycle-card').filter({ hasText: code }).first().click();
  else await main.getByTestId('cycle-row').filter({ hasText: code }).locator('td').first().click();
  await expect(page).toHaveURL(new RegExp(`/cycles/${id}/details$`), { timeout: 15000 });
  await expect(page.getByTestId('cycle-status')).toBeVisible();
}

const dialog = (page: Page, kind: string) => page.locator(`[data-shipment-dialog="${kind}"]`);

async function cards(page: Page) {
  const section = page.getByTestId('goods-location');
  await expect(section).toBeVisible();
  const out: Record<string, string> = {};
  for (const c of await section.getByTestId('location-card').all()) {
    out[(await c.getAttribute('data-place'))!] = (await c.getByTestId('location-value').innerText()).trim();
  }
  return out;
}

/** In the open Move leftovers dialog: the target, the reason, and how many of the one product. */
async function fillMove(page: Page, targetCode: string, qty: string | null, reason = 'End of season', locale: Locale = 'en') {
  const d = dialog(page, 'move-leftovers');
  await expect(d.getByTestId('move-qty').first()).toBeVisible();
  await d.getByRole('combobox').click();
  await page.getByRole('option', { name: new RegExp(targetCode) }).click();
  await d.getByTestId('move-reason').fill(reason);
  if (qty !== null) await d.getByTestId('move-qty').first().fill(qty);
  void locale;
}

async function batchesOf(request: APIRequestContext, headers: Headers, cycleId: string) {
  const r = await (await request.get(`${API}/cycles/${cycleId}`, { headers })).json();
  return ((r.data ?? r).inventoryBatches as any[]).map((b) => ({
    id: b.id, remaining: Number(b.remainingQty), received: Number(b.receivedQty), unit: Number(b.landedUnitCostEgp), from: b.transferredFromBatchId,
  }));
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
};

const en = messages('en');

test.describe('Moving leftovers from the cycle page', () => {
  test('TC-L5-01: a partner moves 20 of A’s 30 pads to B — A shows them moved, B shows them from A, at the same cost; B’s cost to fund rises by exactly 2,000', async ({ page, request }) => {
    const { headers, a, b } = await leftoverWorld(request, 'L5 Move');
    const fundBefore = (await (await request.get(`${API}/costing/cycles/${b.id}/landed-cost`, { headers })).json()).totals.toFundEgp;
    await login(page);
    await openCycle(page, a.code, a.id);
    expect(await cards(page)).toEqual({ inUae: '0', toEgypt: '0', inEgypt: '30', sold: '10' });

    await page.getByTestId('move-leftovers').click();
    const d = dialog(page, 'move-leftovers');
    // Every product starts at all of it.
    await expect(d.getByTestId('move-qty').first()).toHaveValue('30');
    await fillMove(page, b.code, '20');
    await expect(d.getByTestId('move-total')).toContainText('2,000.00');
    await d.getByRole('button', { name: en.transfers.move, exact: true }).click();
    await expect(d).toHaveCount(0);
    await expect(page.getByText(en.transfers.moved)).toBeVisible();

    // A: a place of its own, and still 40 in all; no reload.
    await expect.poll(() => cards(page)).toEqual({ inUae: '0', toEgypt: '0', inEgypt: '10', sold: '10', moved: '20' });
    const out = page.getByTestId('cycle-transfers').getByTestId('transfer-row');
    await expect(out).toHaveCount(1);
    await expect(out.first()).toHaveAttribute('data-direction', 'out');
    await expect(out.first()).toContainText(b.code);
    await expect(out.first().getByTestId('transfer-cost')).toContainText('2,000.00');
    await expect(out.first().getByTestId('transfer-undo')).toBeVisible();

    // B: from A, outside what B ordered.
    await openCycle(page, b.code, b.id);
    const from = page.getByTestId('location-from-cycle');
    await expect(from).toHaveCount(1);
    await expect(from).toHaveAttribute('data-cycle', a.code);
    await expect(from).toContainText('20');
    await expect(page.getByTestId('cycle-transfers').getByTestId('transfer-row')).toHaveAttribute('data-direction', 'in');

    // The server: the same cost, a link back, and B funds it.
    const aBatches = await batchesOf(request, headers, a.id);
    const bBatches = await batchesOf(request, headers, b.id);
    expect(aBatches.map((x) => [x.received, x.remaining])).toEqual([[40, 10]]);
    expect(bBatches).toEqual([expect.objectContaining({ received: 20, remaining: 20, unit: 100, from: aBatches[0].id })]);
    const costing = (await (await request.get(`${API}/costing/cycles/${b.id}/landed-cost`, { headers })).json()).totals;
    expect(Number(costing.toFundEgp) - Number(fundBefore)).toBe(2000);
    expect(costing.transferredInEgp).toBe('2000.00');
  });

  test('TC-L5-02: undo while untouched puts the pads back; after a sale in B undo is gone and the server refuses it', async ({ page, request }) => {
    const { headers, mk, a, b, pad, customer } = await leftoverWorld(request, 'L5 Undo');
    await mk(`cycles/${a.id}/transfers`, { toCycleId: b.id, reason: 'Wrong one', lines: [{ productId: pad.id, qty: 30 }] });
    await login(page);
    await openCycle(page, b.code, b.id);
    const row = page.getByTestId('cycle-transfers').getByTestId('transfer-row').first();
    await row.getByTestId('transfer-undo').click();
    const u = dialog(page, 'undo-transfer');
    await u.getByTestId('undo-reason').fill('Chose the wrong cycle');
    await u.getByRole('button', { name: en.transfers.undo, exact: true }).click();
    await expect(u).toHaveCount(0);
    await expect(row).toHaveAttribute('data-status', 'REVERSED');
    await expect(row.getByTestId('transfer-undone')).toBeVisible();
    await expect(page.getByTestId('location-from-cycle')).toHaveCount(0);
    expect((await batchesOf(request, headers, a.id)).map((x) => x.remaining)).toEqual([30]);
    expect(await batchesOf(request, headers, b.id)).toEqual([]);

    // Again — then one sells from B (A has nothing left, so FIFO draws the moved batch).
    const t = await mk(`cycles/${a.id}/transfers`, { toCycleId: b.id, reason: 'Right one', lines: [{ productId: pad.id, qty: 30 }] });
    const order = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: pad.id, quantity: 1, unitPrice: 200, discount: 0 }],
    });
    await mk(`sales/orders/${order.id}/confirm`, { version: order.version });

    await openCycle(page, a.code, a.id);
    const active = page.getByTestId('cycle-transfers').locator('[data-testid="transfer-row"][data-status="ACTIVE"]');
    await expect(active).toHaveCount(1);
    await expect(active.getByTestId('transfer-undo')).toHaveCount(0);
    await expect(active.getByTestId('transfer-permanent')).toContainText('permanent');
    const r = await request.post(`${API}/stock-transfers/${t.id}/undo`, { headers, data: { reason: 'try' } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error.code).toBe('TRANSFER_UNITS_SOLD');
  });
});

test.describe('The settlement’s unsold-stock refusal offers the move', () => {
  test('TC-L5-03: paying out A with 30 on the shelf is refused; Move leftovers in place, then paying out closes A with nothing written off', async ({ page, request }) => {
    const { headers, mk, a, b } = await leftoverWorld(request, 'L5 Settle');
    const draft = await mk(`settlements/calculate/${a.id}`, {});
    await mk(`settlements/${draft.id}/approve`, {});

    await login(page);
    await openView(page, 'settlements');
    const card = page.locator(`[data-testid="settlement-card"][data-cycle="${a.code}"]`);
    await card.getByRole('button', { name: en.settlementsPage.markPaid }).click();

    const prompt = dialog(page, 'unsold-stock');
    await expect(prompt.getByTestId('unsold-refusal')).toContainText('30');
    await prompt.getByTestId('unsold-move').click();
    await expect(prompt).toHaveCount(0);
    await fillMove(page, b.code, null);
    await dialog(page, 'move-leftovers').getByRole('button', { name: en.transfers.move, exact: true }).click();

    await expect(prompt.getByTestId('unsold-moved')).toBeVisible();
    await prompt.getByTestId('unsold-pay-again').click();
    await expect(prompt).toHaveCount(0);
    await expect(page.getByText(en.settlementsPage.paid)).toBeVisible();

    const aNow = (await (await request.get(`${API}/cycles/${a.id}`, { headers })).json()).data;
    expect(aNow.status).toBe('CLOSED');
    // Paid out: capital 4,000 and 1,000 profit — and no write-off anywhere.
    const ledger: any[] = (await (await request.get(`${API}/ledger?cycleId=${a.id}&limit=200`, { headers })).json()).data;
    const payout = ledger.filter((r) => r.category === 'settlement').reduce((s, r) => s + Number(r.amount), 0);
    // L7: the partner's share of any running costs waiting comes off what he
    // is handed, recorded beside it; together they are still 5,000.
    const share = ledger.filter((r) => r.category === 'running_cost_share').reduce((s, r) => s + Number(r.amount), 0);
    expect(Math.round((payout + share) * 100) / 100).toBe(5000);
    const pair = ledger.filter((r) => r.category === 'cycle_transfer');
    expect(pair.map((r) => [r.direction, Number(r.amount)])).toEqual([['INFLOW', 3000]]);
    // Paid out: the move is permanent.
    const list = (await (await request.get(`${API}/cycles/${a.id}/transfers`, { headers })).json()).data;
    expect(list.out[0].undo).toMatchObject({ allowed: false, code: 'TRANSFER_SOURCE_PAID' });
  });
});

test.describe('What is refused, and to whom', () => {
  test('TC-L5-04: too many, zero, to itself, to a closed cycle, from a cycle not selling, no reason, a future day, an unknown cycle — each a coded 4xx, nothing moved', async ({ request }) => {
    const { headers, a, b, pad } = await leftoverWorld(request, 'L5 Refuse');
    const post = (from: string, body: Record<string, unknown>) =>
      request.post(`${API}/cycles/${from}/transfers`, { headers, data: { toCycleId: b.id, reason: 'x', lines: [{ productId: pad.id, qty: 1 }], ...body } });
    const cases: Array<[string, Promise<any>, number, string]> = [
      ['too many', post(a.id, { lines: [{ productId: pad.id, qty: 31 }] }), 400, 'TRANSFER_MORE_THAN_ON_SHELF'],
      ['zero', post(a.id, { lines: [{ productId: pad.id, qty: 0 }] }), 400, 'TRANSFER_QTY_NOT_POSITIVE'],
      ['negative', post(a.id, { lines: [{ productId: pad.id, qty: -2 }] }), 400, 'TRANSFER_QTY_NOT_POSITIVE'],
      ['to itself', post(a.id, { toCycleId: a.id }), 400, 'TRANSFER_SAME_CYCLE'],
      ['from a cycle being planned', post(b.id, { toCycleId: a.id }), 400, 'TRANSFER_SOURCE_NOT_SELLING'],
      ['no reason', post(a.id, { reason: '  ' }), 400, 'TRANSFER_REASON_REQUIRED'],
      ['a future day', post(a.id, { movedOn: '2099-01-01' }), 400, 'DATE_IN_FUTURE'],
      ['an unknown cycle', post(a.id, { toCycleId: '00000000-0000-4000-8000-000000000000' }), 404, 'NOT_FOUND'],
    ];
    for (const [name, p, status, code] of cases) {
      const r = await p;
      expect(r.status(), `${name}: ${await r.text()}`).toBe(status);
      expect((await r.json()).error.code, name).toBe(code);
    }
    // To a closed cycle.
    const { mk } = await apiCtx(request);
    const c = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await mk(`cycles/${c.id}/transition`, { status: 'CANCELLED' });
    const closed = await post(a.id, { toCycleId: c.id });
    expect((await closed.json()).error.code).toBe('TRANSFER_TARGET_CLOSED');
    expect((await batchesOf(request, headers, a.id)).map((x) => x.remaining)).toEqual([30]);

    for (const caller of await refusedCallers(request, 'l5')) {
      const r = await request.post(`${API}/cycles/${a.id}/transfers`, {
        headers: caller.headers, data: { toCycleId: b.id, reason: 'x', lines: [{ productId: pad.id, qty: 1 }] },
      });
      expect(r.status(), caller.who).toBe(403);
      expect((await r.json()).error.code, caller.who).toBe(caller.code);
    }
  });

  test('TC-L5-05: the investor on both cycles reads the transfers and the cards, and is offered neither Move nor Undo', async ({ page, request }) => {
    const { mk, a, b, pad } = await leftoverWorld(request, 'L5 Investor', { investor: true });
    await mk(`cycles/${a.id}/transfers`, { toCycleId: b.id, reason: 'Season end', lines: [{ productId: pad.id, qty: 5 }] });
    await page.goto(`${BASE}/en/login`);
    await page.locator('input[type="email"]').fill(INVESTOR_EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/dashboard/, { timeout: 20000 });
    await openCycle(page, a.code, a.id);
    expect((await cards(page)).moved).toBe('5');
    await expect(page.getByTestId('transfer-row')).toHaveCount(1);
    await expect(page.getByTestId('move-leftovers')).toHaveCount(0);
    await expect(page.getByTestId('transfer-undo')).toHaveCount(0);
  });
});

test.describe('In Arabic', () => {
  test('TC-L5-06: the dialog, the cards and the transfers read in Arabic, right to left', async ({ page, request }) => {
    const ar = messages('ar');
    const { a, b } = await leftoverWorld(request, 'L5 Arabic');
    await login(page, 'ar');
    await openCycle(page, a.code, a.id, 'ar');
    await page.getByTestId('move-leftovers').click();
    const d = dialog(page, 'move-leftovers');
    await expect(d.getByRole('heading', { name: ar.transfers.moveTitle })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await fillMove(page, b.code, '12', 'نهاية الموسم', 'ar');
    await d.getByRole('button', { name: ar.transfers.move, exact: true }).click();
    await expect(d).toHaveCount(0);
    await expect(page.getByTestId('location-card').filter({ hasText: ar.goodsLocation.moved })).toContainText('12');
    await expect(page.getByTestId('cycle-transfers')).toContainText(ar.transfers.movedOut);
  });
});

/** `scripts/check-data.sh`'s table, check name → count (CLAUDE.md §7). */
function checkData(): Map<string, number> {
  let out: string;
  try {
    out = execFileSync('bash', [path.resolve(process.cwd(), '../../scripts/check-data.sh')], {
      encoding: 'utf8',
      env: { ...process.env, DB: DB_NAME, CONTAINER: DB_CONTAINER },
    });
  } catch (e) {
    // It exits 1 when any count is not zero; the table is still the answer.
    out = String((e as { stdout?: string }).stdout ?? '');
  }
  const rows = new Map<string, number>();
  for (const m of out.matchAll(/^\|\s*(.+?)\s*\|\s*(\d+)\s*\|$/gm)) rows.set(m[1], Number(m[2]));
  return rows;
}

test.describe('The data check knows about transfers (CLAUDE.md §7)', () => {
  test('TC-L5-07: with moves standing, undone and sold from, every transfer check is zero and a moved batch is not "from no delivery"; a re-priced moved batch is found', async ({ request }) => {
    const { headers, mk, a, b, pad, customer } = await leftoverWorld(request, 'L5 Check');
    // B has a leg of its own, so a moved batch sits on a cycle with legs.
    await mk(`cycles/${b.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt', costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
    });
    const undone = await mk(`cycles/${a.id}/transfers`, { toCycleId: b.id, reason: 'x', lines: [{ productId: pad.id, qty: 5 }] });
    await mk(`stock-transfers/${undone.id}/undo`, { reason: 'y' });
    await mk(`cycles/${a.id}/transfers`, { toCycleId: b.id, reason: 'z', lines: [{ productId: pad.id, qty: 30 }] });
    const order = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: pad.id, quantity: 2, unitPrice: 200, discount: 0 }],
    });
    await mk(`sales/orders/${order.id}/confirm`, { version: order.version });

    const rows = checkData();
    const transferChecks = [...rows.keys()].filter((k) => /transfer|moved stock|moved into/.test(k));
    expect(transferChecks.length).toBeGreaterThanOrEqual(6);
    for (const k of [...transferChecks, 'a batch on a cycle with legs that came from no delivery']) {
      expect(rows.get(k), k).toBe(0);
    }

    // Break one: the moved batch re-priced. The check must see it.
    const moved = ((await (await request.get(`${API}/cycles/${b.id}`, { headers })).json()).data.inventoryBatches as any[])[0];
    psqlStdin(`UPDATE inventory_batches SET landed_unit_cost_egp = landed_unit_cost_egp + 1 WHERE id = '${moved.id}';`);
    try {
      expect(checkData().get('moved stock re-priced (its batch cost differs from the source batch)')).toBe(1);
    } finally {
      psqlStdin(`UPDATE inventory_batches SET landed_unit_cost_egp = landed_unit_cost_egp - 1 WHERE id = '${moved.id}';`);
    }
  });
});

// ─── Review screenshots (L5_SHOTS=1) ─────────────────────────────────────

test.describe('Screenshots', () => {
  test.skip(!SHOTS, 'L5_SHOTS=1 to write them');
  for (const locale of ['en', 'ar'] as const) {
    for (const width of [1440, 390]) {
      test(`TC-L5-SHOT ${locale} ${width}`, async ({ page, request }) => {
        test.setTimeout(180_000);
        const m = messages(locale);
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const { headers, mk, a, b } = await leftoverWorld(request, `L5 Shot ${locale}${width}`);
        const tag = `${locale}-${width}`;
        await login(page, locale);
        await hideDevBadge(page);
        await openCycle(page, a.code, a.id, locale);
        await page.getByTestId('move-leftovers').click();
        await fillMove(page, b.code, '20', locale === 'ar' ? 'نهاية الموسم' : 'End of season', locale);
        await shot(page, `move-dialog-${tag}`);
        await dialog(page, 'move-leftovers').getByRole('button', { name: m.transfers.move, exact: true }).click();
        await expect(dialog(page, 'move-leftovers')).toHaveCount(0);
        await expect(page.getByTestId('location-card').filter({ hasText: m.goodsLocation.moved })).toBeVisible();
        // The "moved" toast has said its piece; it is not part of the page.
        await expect(page.getByText(m.transfers.moved, { exact: true })).toHaveCount(0, { timeout: 15000 });
        await shot(page, `cycle-a-goods-${tag}`);
        await page.getByTestId('cycle-transfers').scrollIntoViewIfNeeded();
        await shot(page, `cycle-a-transfers-${tag}`);
        await openCycle(page, b.code, b.id, locale);
        await expect(page.getByTestId('location-from-cycle')).toBeVisible();
        await shot(page, `cycle-b-from-${tag}`);
        await page.getByTestId('cycle-transfers').scrollIntoViewIfNeeded();
        await shot(page, `cycle-b-transfers-${tag}`);

        // The settlement fix, on A with its last 10 still there.
        const draft = await mk(`settlements/calculate/${a.id}`, {});
        await mk(`settlements/${draft.id}/approve`, {});
        if (width < 768) {
          await hideDevBadge(page);
          await page.locator('button:has(svg.lucide-menu)').filter({ visible: true }).first().click();
          await page.locator(`a[href="/${locale}/settlements"]`).filter({ visible: true }).first().click();
        } else {
          await page.locator(`aside a[href="/${locale}/settlements"]`).filter({ visible: true }).first().click();
        }
        await expect(page).toHaveURL(new RegExp(`/${locale}/settlements$`));
        await page.locator(`[data-testid="settlement-card"][data-cycle="${a.code}"]`).getByRole('button', { name: m.settlementsPage.markPaid }).click();
        await expect(dialog(page, 'unsold-stock').getByTestId('unsold-move')).toBeVisible();
        await shot(page, `settlement-fix-${tag}`);
        void headers;
      });
    }
  }
});

