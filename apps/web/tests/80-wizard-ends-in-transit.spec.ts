/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The cycle wizard ends at "in transit"; the list shows profit
 * ═══════════════════════════════════════════════════════════════════════
 *  F1b, spec 2026-10-10 (UX #5, #7; BUSINESS_LOGIC §1, §15).
 *
 *  The wizard's last step used to receive the stock, and refused unless every
 *  leg had already arrived — so a cycle set up the day it was ordered could
 *  not be finished at all. It now ends on the money, and finishing moves the
 *  cycle only as far as its dates allow:
 *
 *    no dates          → PURCHASING, the order still a DRAFT (§15)
 *    a departure       → IN_TRANSIT, which confirms the order
 *    an arrival date   → a delivery (B2), and Arrived — never Verification
 *
 *  Everything is reached by clicking (CLAUDE.md §2). A page.goto() between
 *  steps is a full load that wipes the client cache, which is where "the list
 *  still shows the old state" and "the form forgot what I typed" bugs live.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import en from '../src/i18n/locales/en.json';
import { apiCtx, API, EMAIL, PASSWORD, daysAgo, stockedProduct } from './support/fixtures';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';

async function login(page: Page, locale = 'en') {
  await page.goto(`${BASE}/${locale}/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 15000 });
}

const pickerFor = (page: Page, name: string) =>
  page.locator(`input[type="hidden"][name="${name}"]`).locator('..').getByRole('combobox');

async function choose(page: Page, name: string, label?: string) {
  await pickerFor(page, name).click();
  const options = page.getByRole('listbox').getByRole('option');
  await (label ? options.filter({ hasText: label }).first() : options.first()).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

/** Choose a date the way a person does: open the calendar and click the day. */
async function pickDate(page: Page, name: string, iso: string) {
  await page.locator(`[data-date-picker="${name}"]`).click();
  const grid = page.getByRole('grid');
  await grid.waitFor({ state: 'visible' });
  const targetMonth = iso.slice(0, 7);
  for (let i = 0; i < 36; i++) {
    const shown = await grid.locator('[data-day]:not([data-outside])').first().getAttribute('data-day');
    const shownMonth = (shown ?? '').slice(0, 7);
    if (shownMonth === targetMonth) break;
    await page.getByTestId(shownMonth < targetMonth ? 'calendar-next' : 'calendar-prev').click();
  }
  await grid.locator(`[data-day="${iso}"]:not([data-outside])`).click();
  await expect(page.locator(`input[type="hidden"][name="${name}"]`)).toHaveValue(iso);
}

/** Into the cycle list from the menu — a soft navigation, cache intact. */
async function openCycleList(page: Page) {
  await page.getByRole('link', { name: 'Import Cycles', exact: true }).first().click();
  await expect(page).toHaveURL(/\/cycles$/, { timeout: 15000 });
}

/**
 * Find a cycle in the list by its code and resume its setup.
 *
 * Clicking the row opens the cycle's details page (owner, 2026-10-11); the
 * wizard is reached by the row's own "Continue setup".
 */
async function openCycleFromList(page: Page, code: string) {
  await openCycleList(page);
  await page.getByPlaceholder(/search/i).fill(code);
  const row = page.locator('tr', { hasText: code });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.getByTestId('continue-setup').click();
  await expect(page).toHaveURL(/\/cycles\/[0-9a-f-]+$/, { timeout: 15000 });
}

async function cycleFromApi(request: APIRequestContext, headers: Record<string, string>, id: string) {
  const res = await request.get(`${API}/cycles/${id}`, { headers });
  const body = await res.json();
  return body.data ?? body;
}

/**
 * A China cycle with its order placed and both legs recorded, no dates yet —
 * the state the wizard is in when someone sets up a shipment that has not left.
 */
async function orderedChinaCycle(request: APIRequestContext, label: string) {
  const { mk, headers } = await apiCtx(request);
  const product = await mk('products', { name: `${label} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `${label} Supplier`, country: 'CN' });
  const provider = await mk('providers', { name: `${label} Freight` });
  const cycle = await mk('cycles', { originType: 'CHINA', currency: 'USD' });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(60),
    items: [{ productId: product.id, orderedQty: 40, unitPrice: 100 }],
  });
  for (const sequence of [1, 2]) {
    await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence,
      origin: sequence === 1 ? 'Guangzhou, CN' : 'Dubai, UAE',
      destination: sequence === 1 ? 'Dubai, UAE' : 'Cairo, Egypt',
      providerId: provider.id, provider: provider.name,
      costBasis: 'FLAT', amount: 500, currency: 'EGP', fxRateToEgp: 1,
    });
  }
  return { headers, cycle, product, supplier, provider };
}

test.describe('The wizard ends at ordered / in transit', () => {
  test('TC-F1B-01: finishing with no dates leaves the cycle in Purchasing with its order a draft', async ({
    page,
    request,
  }) => {
    // UX #5 and §15: the old step 4 refused here with "has not arrived".
    const { mk, headers } = await apiCtx(request);
    const stamp = Date.now();
    await mk('products', { name: `F1b Part ${stamp}`, minStock: 0 });
    await mk('suppliers', { name: `F1b Supplier ${stamp}`, country: 'AE' });
    await mk('providers', { name: `F1b Freight ${stamp}` });

    await login(page);
    await openCycleList(page);
    await page.getByRole('link', { name: /New Cycle/i }).click();

    // Step 1
    await choose(page, 'originType', 'UAE Direct');
    await choose(page, 'currency', 'AED');
    await page.getByRole('button', { name: /save & continue/i }).click();

    // Step 2 — the order date is already today, and there is already one row.
    await expect(pickerFor(page, 'supplierId')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('input[type="hidden"][name="orderedOn"]')).not.toHaveValue('');
    await expect(page.getByTestId('wizard-line-item')).toHaveCount(1);
    await choose(page, 'supplierId', `F1b Supplier ${stamp}`);
    await choose(page, 'currency', 'EGP');
    await page.locator('[role="combobox"]', { hasText: 'Select product' }).first().click();
    await page.getByRole('listbox').getByRole('option').filter({ hasText: `F1b Part ${stamp}` }).first().click();
    await page.locator('input[data-field="orderedQty"]').fill('40');
    await page.locator('input[data-field="unitPrice"]').fill('100');
    await page.getByRole('button', { name: /save & continue/i }).click();

    // Step 3 — no dates at all.
    await expect(page.getByTestId('wizard-leg-1')).toBeVisible({ timeout: 15000 });
    await choose(page, 'leg1_providerId', `F1b Freight ${stamp}`);
    await page.locator('[data-field="leg1_ratePerUnit"]').fill('5');
    await page.getByRole('button', { name: /save & continue/i }).click();

    // Step 4 — the money, then finish. No "Receive Inventory" anywhere.
    const finish = page.getByRole('button', { name: /^finish$/i });
    await expect(finish).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/receive inventory/i)).toHaveCount(0);
    await finish.click();

    // It opens the cycle's page, with no refusal on the way.
    await expect(page).toHaveURL(/\/cycles\/[0-9a-f-]+\/details/, { timeout: 15000 });
    await expect(page.getByText(/has not arrived/i)).toHaveCount(0);
    const cycleId = page.url().match(/cycles\/([0-9a-f-]+)\/details/)![1];

    const saved = await cycleFromApi(request, headers, cycleId);
    expect(saved.status).toBe('PURCHASING');
    expect(saved.purchaseOrders).toHaveLength(1);
    expect(saved.purchaseOrders[0].status).toBe('DRAFT');
    expect(saved.inventoryBatches).toHaveLength(0);

    // And the list says so without a reload.
    await openCycleList(page);
    await page.getByPlaceholder(/search/i).fill(saved.code);
    await expect(page.locator('tr', { hasText: saved.code })).toContainText('Purchasing');
  });

  test('TC-F1B-02: a departure date → In transit, and the order is confirmed', async ({
    page,
    request,
  }) => {
    const { headers, cycle } = await orderedChinaCycle(request, `Dep${Date.now()}`);

    await login(page);
    await openCycleFromList(page, cycle.code);
    await expect(page.getByRole('button', { name: /^finish$/i })).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: 'Shipping Leg' }).click();
    await expect(page.getByTestId('wizard-leg-1')).toBeVisible({ timeout: 15000 });
    await pickDate(page, 'leg1_departedOn', daysAgo(3));
    await page.getByRole('button', { name: /save & continue/i }).click();
    await page.getByRole('button', { name: /^finish$/i }).click();

    await expect(page).toHaveURL(new RegExp(`/cycles/${cycle.id}/details`), { timeout: 15000 });
    const saved = await cycleFromApi(request, headers, cycle.id);
    expect(saved.status).toBe('IN_TRANSIT');
    expect(saved.purchaseOrders[0].status).toBe('CONFIRMED');
  });

  test('TC-F1B-03: arrival dates walk to Arrived Egypt and stop — nothing is received', async ({
    page,
    request,
  }) => {
    // The PUT turns an arrival date into a delivery (B2); the walk follows the
    // gates as far as Arrived Egypt and never into Verification or Selling.
    const { headers, cycle } = await orderedChinaCycle(request, `Arr${Date.now()}`);

    await login(page);
    await openCycleFromList(page, cycle.code);
    await expect(page.getByRole('button', { name: /^finish$/i })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Shipping Leg' }).click();
    await expect(page.getByTestId('wizard-leg-2')).toBeVisible({ timeout: 15000 });

    await pickDate(page, 'leg1_departedOn', daysAgo(20));
    await pickDate(page, 'leg1_arrivedOn', daysAgo(12));
    await pickDate(page, 'leg2_departedOn', daysAgo(10));
    await pickDate(page, 'leg2_arrivedOn', daysAgo(2));
    await page.getByRole('button', { name: /save & continue/i }).click();
    await page.getByRole('button', { name: /^finish$/i }).click();

    await expect(page).toHaveURL(new RegExp(`/cycles/${cycle.id}/details`), { timeout: 15000 });
    const saved = await cycleFromApi(request, headers, cycle.id);
    expect(saved.status).toBe('ARRIVED_EGYPT');
    expect(saved.inventoryBatches).toHaveLength(0);
  });

  test('TC-F1B-04: finishing twice does not move the cycle further the second time', async ({
    page,
    request,
  }) => {
    const { headers, cycle } = await orderedChinaCycle(request, `Twice${Date.now()}`);

    await login(page);
    await openCycleFromList(page, cycle.code);
    await page.getByRole('button', { name: /^finish$/i }).click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${cycle.id}/details`), { timeout: 15000 });
    expect((await cycleFromApi(request, headers, cycle.id)).status).toBe('PURCHASING');

    // Back through the list's Continue setup, and finish again.
    await openCycleFromList(page, cycle.code);
    await page.getByRole('button', { name: /^finish$/i }).click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${cycle.id}/details`), { timeout: 15000 });
    const saved = await cycleFromApi(request, headers, cycle.id);
    expect(saved.status).toBe('PURCHASING');
    expect(saved.purchaseOrders[0].status).toBe('DRAFT');
  });

  test('TC-F1B-05: leave the wizard at step 3 and come back by clicking — what was typed is still there', async ({
    page,
    request,
  }) => {
    // The second visit. The leg form reads its starting values once, so a
    // tracking number typed and not saved used to be lost on the way out.
    const { mk } = await apiCtx(request);
    const stamp = Date.now();
    const product = await mk('products', { name: `Leave Part ${stamp}`, minStock: 0 });
    const supplier = await mk('suppliers', { name: `Leave Supplier ${stamp}`, country: 'AE' });
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(60),
      items: [{ productId: product.id, orderedQty: 10, unitPrice: 50 }],
    });

    await login(page);
    await openCycleFromList(page, cycle.code);
    const tracking = page.locator('input[name="leg1_trackingRef"]');
    await expect(tracking).toBeVisible({ timeout: 15000 });
    await tracking.fill(`TRK-${stamp}`);
    await pickDate(page, 'leg1_departedOn', daysAgo(4));

    // Out to the list, and back in by its Continue setup.
    await openCycleFromList(page, cycle.code);
    await expect(tracking).toHaveValue(`TRK-${stamp}`, { timeout: 15000 });
    await expect(page.locator('input[type="hidden"][name="leg1_departedOn"]')).toHaveValue(daysAgo(4));

    // And back a step and forward again.
    // exact: the wizard also has "Back to the cycle" now.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(tracking).toHaveValue(`TRK-${stamp}`);
  });

  test('TC-F1B-06: resuming a cycle with two orders shows both', async ({ page, request }) => {
    const { cycle, supplier } = await orderedChinaCycle(request, `Two${Date.now()}`);
    const { mk } = await apiCtx(request);
    const second = await mk('products', { name: `Second Part ${Date.now()}`, minStock: 0 });
    const po2 = await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(60),
      items: [{ productId: second.id, orderedQty: 5, unitPrice: 20 }],
    });

    await login(page);
    await openCycleFromList(page, cycle.code);
    await expect(page.getByRole('button', { name: /^finish$/i })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Purchase Order' }).click();

    const orders = page.getByTestId('wizard-saved-order');
    await expect(orders).toHaveCount(2);
    await expect(orders.filter({ hasText: po2.reference })).toContainText(second.name);
  });
});

test.describe('The cycle list', () => {
  test('TC-F1B-07: shows the profit and ROI the Analytics page reports, for that cycle', async ({
    page,
    request,
  }) => {
    // One definition (rule 11): the list reads the analytics figure, so the
    // two screens cannot disagree.
    const { mk, headers } = await apiCtx(request);
    const stamp = Date.now();
    const { product, cycle } = await stockedProduct(request, headers, mk, `Profit${stamp}`, 10);
    const customer = await mk('customers', { displayName: `Profit Shop ${stamp}`, type: 'B2B' });
    const order = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 4, unitPrice: 25, discount: 0 }],
    });
    await mk(`sales/orders/${order.id}/confirm`, { version: order.version });

    const figures = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers })).json()).data;
    const figure = figures.find((f: { cycleCode: string }) => f.cycleCode === cycle.code);
    expect(figure, 'the analytics figure covers the cycle').toBeTruthy();
    expect(figure.profit).not.toBe(0);

    await login(page);
    await openCycleList(page);
    await page.getByPlaceholder(/search/i).fill(cycle.code);
    const row = page.locator('tr', { hasText: cycle.code });
    const money = Number(figure.profit).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    await expect(row.getByTestId('cycle-profit')).toContainText(money);
    await expect(row.getByTestId('cycle-roi')).toContainText(`${figure.roiPct}%`);
  });

  test('TC-F1B-08: a cycle with nothing sold shows a dash, not a zero profit', async ({
    page,
    request,
  }) => {
    const { cycle } = await orderedChinaCycle(request, `Dash${Date.now()}`);
    await login(page);
    await openCycleList(page);
    await page.getByPlaceholder(/search/i).fill(cycle.code);
    const row = page.locator('tr', { hasText: cycle.code });
    await expect(row.getByTestId('cycle-profit')).toHaveText('—');
    await expect(row.getByTestId('cycle-roi')).toHaveText('—');
  });

  test('TC-F1B-09: in Arabic the first chip is "All", Continue setup is translated, statuses are words', async ({
    page,
  }) => {
    await login(page, 'ar');
    await page.getByRole('link', { name: 'دورات الاستيراد', exact: true }).first().click();
    await expect(page).toHaveURL(/\/ar\/cycles$/, { timeout: 15000 });
    await expect(page.getByRole('button', { name: /^الكل/ })).toBeVisible({ timeout: 15000 });

    const body = await page.locator('main').innerText();
    expect(body).not.toContain('Click to resume');
    expect(body).not.toContain(en.cycles.continueSetup);
    expect(body).not.toContain('Filter');
    // Status codes were shown as raw keys ("purchasing") before.
    expect(body).not.toMatch(/\b(planning|purchasing|inTransit|PURCHASING|IN_TRANSIT)\b/);
  });

  test('TC-F1B-10: a search that matches nothing says so', async ({ page }) => {
    await login(page);
    await openCycleList(page);
    await page.getByPlaceholder(/search/i).fill(`no-such-cycle-${Date.now()}`);
    // Since UF8 a search with no match shows the shared no-match state, with a way back.
    await expect(page.getByText(en.common.noMatch).first()).toBeVisible();
    await page.getByRole('button', { name: en.common.clearSearch }).click();
    await expect(page.getByPlaceholder(/search/i)).toHaveValue('');
  });
});
