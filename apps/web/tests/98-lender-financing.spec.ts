/**
 * L1 — a purchase paid by a friend, repaid in pounds (BUSINESS_LOGIC §18).
 *
 * Clicked through the way a person does it (CLAUDE.md rule 2): the menu to the
 * cycle, "Paid by a friend" with a friend made by the `+`, his page, three
 * repayments at three rates — the dirham up, down, and the last one paying
 * it off exactly — one reversed, and the settlement refused while he is owed.
 *
 * The cycle is built the business's way (rule 4): an order in dirhams, a leg
 * that left and arrived, every unit received, so the only thing standing
 * between it and settlement is the friend.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, apiCtx, daysAgo, refusedCallers } from './support/fixtures';
import { login, messages, type Locale } from './support/ui';

const SHOTS = process.env.L1_SHOTS === '1';
const SHOT_DIR = '../../.ui-audit/l1';
const en = messages('en');

/**
 * 100 parts at 300 AED on one order at 13.00 — 30,000 AED, 390,000 EGP — and
 * 13,000 EGP of freight, which the partners pay. All received.
 */
async function dirhamCycle(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const product = await mk('products', { name: `${label} ${stamp} Exhaust`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `${label} ${stamp} Dubai Trading`, country: 'AE' });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
  const po = await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'AED', fxRateToEgp: 13, orderedOn: daysAgo(30),
    items: [{ productId: product.id, orderedQty: 100, unitPrice: 300 }],
  });
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    costBasis: 'FLAT', amount: 13000, currency: 'EGP', fxRateToEgp: 1,
    departedOn: daysAgo(20), arrivedOn: daysAgo(10),
  });
  for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
    await mk(`cycles/${cycle.id}/transition`, { status });
  }
  const full = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
  const item = (full.data ?? full).purchaseOrders[0].items[0];
  await mk('receipts/verify', {
    cycleId: cycle.id,
    items: [{ purchaseOrderItemId: item.id, productId: product.id, receivedQty: 100 }],
  });
  return { headers, mk, cycle, po, stamp };
}

async function openCycle(page: Page, code: string, id: string, locale: Locale = 'en') {
  await page.locator(`aside a[href="/${locale}/cycles"]`).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/cycles$`), { timeout: 15000 });
  const main = page.getByRole('main');
  await main.getByPlaceholder(messages(locale).cycles.search).fill(code);
  await main.getByTestId('cycle-row').filter({ hasText: code }).locator('td').first().click();
  await expect(page).toHaveURL(new RegExp(`/cycles/${id}/details$`), { timeout: 15000 });
  await expect(page.getByTestId('cycle-status')).toBeVisible();
}

/** Record a repayment from the lender page: date today, the rate typed over the prefilled one. */
async function repay(page: Page, card: ReturnType<Page['getByTestId']>, rate: string, pounds: string | 'all') {
  await card.getByTestId('record-repayment').click();
  const dialog = page.getByTestId('record-repayment-dialog');
  await expect(dialog).toBeVisible();
  // No money account is asked (§18, owner 2026-10-11).
  await expect(dialog.locator('[data-date-picker], input, [role="combobox"]').filter({ hasText: /account/i })).toHaveCount(0);
  await expect(dialog.getByText(/account/i)).toHaveCount(0);
  const rateField = dialog.locator('#repayment-rate');
  // Select-on-focus: a click selects what is there, so typing replaces it.
  await rateField.click();
  await page.keyboard.type(rate);
  await expect(rateField).toHaveValue(rate);
  if (pounds === 'all') {
    await expect(dialog.getByTestId('settling-hint')).toBeVisible();
    await dialog.getByTestId('pay-all').click();
  } else {
    await dialog.locator('#repayment-amount').click();
    await page.keyboard.type(pounds);
  }
  await dialog.getByRole('button', { name: en.lenders.recordRepayment, exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 10000 });
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
};

test.describe('A purchase paid by a friend, repaid in pounds', () => {
  test('TC-L1-01: financed from the cycle page, three repayments at three rates end at exactly zero, one reversed, the settlement waits for him', async ({ page, request }) => {
    test.setTimeout(150_000);
    const { headers, cycle, stamp } = await dirhamCycle(request, 'L1');
    const friend = `Friend ${stamp}`;

    await login(page);
    await openCycle(page, cycle.code, cycle.id);

    // ── Paid by a friend, with the friend made by the `+` ──────────────
    const panel = page.getByTestId('paid-by-friend');
    await expect(panel).toContainText(en.lenders.noneYetCycle);
    await panel.getByTestId('add-financing').click();
    const form = panel.getByTestId('financing-form');
    await form.locator('[data-quick-create="lender"]').click();
    const quick = page.locator('[data-quick-create-dialog="lender"]');
    await quick.locator('input[name="name"]').fill(friend);
    await quick.getByRole('button', { name: messages('en').common.create, exact: true }).click();
    await expect(quick).toBeHidden();
    // Created and selected, the half-filled form underneath untouched.
    await expect(form.locator('input[type="hidden"][name="lenderId"]')).not.toHaveValue('');
    await form.locator('#financing-amount').click();
    await page.keyboard.type('30000');
    await form.getByRole('button', { name: en.lenders.save, exact: true }).click();
    await expect(form).toBeHidden({ timeout: 10000 });
    const line = panel.getByTestId('financing-line');
    await expect(line).toContainText(friend);
    await expect(line).toContainText('30,000.00 AED');
    await shot(page, 'cycle-paid-by-friend-1440-en');

    // Partners fund only what the friend did not — the freight (§18). "Split
    // equally" asks them for 13,000, not the 403,000 the cycle cost.
    const costing = await (await request.get(`${API}/costing/cycles/${cycle.id}/landed-cost`, { headers })).json();
    expect(costing.totals.landedEgp).toBe('403000.00');
    expect(costing.totals.lenderFinancedEgp).toBe('390000.00');
    expect(costing.totals.toFundEgp).toBe('13000.00');
    await page.getByRole('main').getByRole('button', { name: en.cycles.splitEqually, exact: true }).click();
    await expect(page.getByText('Split equally — 13,000 EGP')).toBeVisible();
    const after = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const funded = ((after.data ?? after).participants as { contributionAmount: string }[])
      .reduce((s, p) => s + Number(p.contributionAmount), 0);
    expect(funded).toBeCloseTo(13000, 2);

    // ── His page ───────────────────────────────────────────────────────
    await line.getByRole('link', { name: friend }).click();
    await expect(page).toHaveURL(/\/lenders\/[0-9a-f-]{36}$/, { timeout: 15000 });
    const card = page.getByTestId('financing-card');
    await expect(card.getByTestId('financing-owed')).toHaveText('30,000.00 AED');

    // The rate starts as today's (13.85 on the exchange-rate page).
    await card.getByTestId('record-repayment').click();
    const dialog = page.getByTestId('record-repayment-dialog');
    await expect(dialog.locator('#repayment-rate')).toHaveValue('13.85');
    await shot(page, 'record-repayment-1440-en');
    await dialog.getByRole('button', { name: messages('en').common.cancel, exact: true }).click();

    // 1 — the dirham up: 137,000 at 13.7 clears 10,000.00
    await repay(page, card, '13.7', '137000');
    await expect(card.getByTestId('financing-owed')).toHaveText('20,000.00 AED');
    // 2 — the dirham down: 125,555.55 at 12.5555 clears 10,000.04 (rounded down)
    await repay(page, card, '12.5555', '125555.55');
    await expect(card.getByTestId('financing-owed')).toHaveText('9,999.96 AED');
    // 3 — "Pay it all" at 13.4321: 134,320.46 and not a piastre more
    await repay(page, card, '13.4321', 'all');
    await expect(card.getByTestId('financing-owed')).toHaveText('0.00 AED');
    // Pounds paid less his 390,000 at the order rate, exactly.
    await expect(card.getByTestId('financing-exchange-diff')).toContainText('6,876.01 EGP');
    await expect(card.getByTestId('record-repayment')).toHaveCount(0);
    await shot(page, 'lender-page-1440-en');

    // ── Reverse the second; it is owed again, and only once ────────────
    await card.getByTestId('repayment-row').nth(1).getByTestId('reverse-repayment').click();
    const rev = page.getByTestId('reverse-repayment-dialog');
    await rev.locator('#lender-reason').fill('Paid to the wrong account');
    await rev.getByRole('button', { name: en.lenders.reverse, exact: true }).click();
    await expect(rev).toBeHidden({ timeout: 10000 });
    await expect(card.getByTestId('financing-owed')).toHaveText('10,000.04 AED');
    await expect(card.getByTestId('repayment-row').nth(1).getByTestId('reverse-repayment')).toHaveCount(0);

    // ── The settlement waits for him ───────────────────────────────────
    await page.locator('aside a[href="/en/settlements"]').filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/en\/settlements$/, { timeout: 15000 });
    await page.locator('#cycle-select').click();
    const list = page.getByRole('listbox');
    const search = list.locator('[cmdk-input]');
    if (await search.count()) await search.fill(cycle.code);
    await list.getByRole('option', { name: new RegExp(cycle.code) }).first().click();
    await calculate(page);
    const settlement = page.locator(`[data-testid="settlement-card"][data-cycle="${cycle.code}"]`);
    const notice = settlement.getByTestId('lender-debt-notice');
    await expect(notice).toContainText(friend);
    await expect(notice).toContainText('10,000.04 AED');
    await settlement.getByRole('button', { name: en.settlementsPage.approve, exact: true }).click();
    await expect(page.getByText(`Cycle ${cycle.code} cannot be settled while it still owes: ${friend} 10,000.04 AED`)).toBeVisible();
    await shot(page, 'settlement-refused-1440-en');
    expect(await statusOf(request, headers, cycle.id)).toBe('SELLING');

    // Paid off — from his page, reached through the notice — it settles.
    await notice.getByRole('link', { name: friend }).click();
    await expect(page).toHaveURL(/\/lenders\/[0-9a-f-]{36}$/, { timeout: 15000 });
    await repay(page, page.getByTestId('financing-card'), '13', 'all');
    await expect(page.getByTestId('financing-card').getByTestId('financing-owed')).toHaveText('0.00 AED');
    await page.locator('aside a[href="/en/settlements"]').filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/en\/settlements$/, { timeout: 15000 });
    await page.locator('#cycle-select').click();
    const again = page.getByRole('listbox');
    if (await again.locator('[cmdk-input]').count()) await again.locator('[cmdk-input]').fill(cycle.code);
    await again.getByRole('option', { name: new RegExp(cycle.code) }).first().click();
    await calculate(page);
    await expect(settlement.getByRole('button', { name: en.settlementsPage.approve, exact: true })).toBeVisible();
    await expect(settlement.getByTestId('lender-debt-notice')).toHaveCount(0);
    await settlement.getByRole('button', { name: en.settlementsPage.approve, exact: true }).click();
    await expect.poll(() => statusOf(request, headers, cycle.id), { timeout: 10000 }).toBe('SETTLEMENT');
  });

  test('TC-L1-02: a role that may not move money is refused, and a partner is not', async ({ request }) => {
    const { headers, mk, po, stamp } = await dirhamCycle(request, 'L1R');
    const lender = await mk('lenders', { name: `Friend R ${stamp}` });

    for (const caller of await refusedCallers(request, 'l1')) {
      const writes: [string, Record<string, unknown>][] = [
        ['lenders', { name: 'Not allowed' }],
        [`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 100 }],
      ];
      for (const [path, data] of writes) {
        const res = await request.post(`${API}/${path}`, { headers: caller.headers, data });
        expect(res.status(), `${caller.who} ${path}`).toBe(403);
        expect((await res.json()).error.code, `${caller.who} ${path}`).toBe(caller.code);
      }
    }
    // The partner may — both directions of the guard (rule 12).
    const f = await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 100 });
    for (const caller of await refusedCallers(request, 'l1b')) {
      const res = await request.post(`${API}/lender-financings/${f.id}/repayments`, {
        headers: caller.headers, data: { amountEgp: 100, rateToEgp: 13 },
      });
      expect(res.status(), caller.who).toBe(403);
      expect((await res.json()).error.code, caller.who).toBe(caller.code);
    }
    const ok = await mk(`lender-financings/${f.id}/repayments`, { amountEgp: 100, rateToEgp: 13 });
    expect(ok.owed).toBe('92.31');
  });
});

/**
 * Calculate, and wait for the list to come back with the new draft: a
 * recalculation replaces the draft, so the card on screen until then is one
 * that no longer exists.
 */
async function calculate(page: Page) {
  const listed = page.waitForResponse(
    (r) => r.request().method() === 'GET' && /\/settlements(\?|$)/.test(new URL(r.url()).pathname + new URL(r.url()).search),
  );
  const calculated = page.waitForResponse((r) => r.url().includes('/settlements/calculate/'));
  await page.getByRole('button', { name: en.settlementsPage.calculate, exact: true }).click();
  expect((await calculated).ok()).toBeTruthy();
  await listed;
}

async function statusOf(request: APIRequestContext, headers: Record<string, string>, id: string) {
  const r = await (await request.get(`${API}/cycles/${id}`, { headers })).json();
  return (r.data ?? r).status as string;
}
