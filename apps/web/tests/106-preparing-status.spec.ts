/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Preparing — the order confirmed, nothing left yet
 * ═══════════════════════════════════════════════════════════════════════
 *  Owner, 2026-10-27 (BUSINESS_LOGIC §1): "it now should be in preparation
 *  (a new status its where the website or factory prepares your order, then
 *  next its in transit to uae)". Set by hand from the cycle page (Purchasing →
 *  Preparing confirms the order), passed through by itself on the first
 *  departure, and returned to when the shipment's last departure is undone.
 *
 *  Written, not run (owner 2026-10-25: unit and database tests only for now).
 *  The same rules against Postgres: apps/api/src/modules/cycles/preparing-status.db.spec.ts;
 *  every status map covering it: apps/web/src/lib/cycle-statuses.test.ts.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, apiCtx, daysAgo } from './support/fixtures';
import { login, messages } from './support/ui';

const en = messages('en');
const ar = messages('ar');

/** A China cycle in Purchasing with 40 pads on a draft order and two legs, nothing departed. */
async function purchasingCycle(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const pad = await mk('products', { name: `Prep ${stamp} Brake pad`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `Prep ${stamp} Supplier`, country: 'CN' });
  const cycle = await mk('cycles', { originType: 'CHINA', currency: 'EGP' });
  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(25),
    items: [{ productId: pad.id, orderedQty: 40, unitPrice: 100 }],
  });
  for (const status of ['FUNDING', 'PURCHASING']) await mk(`cycles/${cycle.id}/transition`, { status });
  const legs = [];
  for (const [i, [origin, destination]] of [
    ['Guangzhou, CN', 'Dubai, UAE'],
    ['Dubai, UAE', 'Cairo, Egypt'],
  ].entries()) {
    legs.push(
      await mk(`cycles/${cycle.id}/shipping-legs`, {
        sequence: i + 1, origin, destination, costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
      }),
    );
  }
  return { headers, cycle, legs };
}

async function cycleNow(request: APIRequestContext, headers: Record<string, string>, id: string) {
  const r = await (await request.get(`${API}/cycles/${id}`, { headers })).json();
  return (r.data ?? r) as { status: string; purchaseOrders: Array<{ status: string }> };
}

/** Menu → Cycles → search the code → the row → its details page. */
async function openCycle(page: Page, code: string, id: string) {
  await page.locator('aside a[href="/en/cycles"]').filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/en\/cycles$/, { timeout: 15000 });
  const main = page.getByRole('main');
  await main.getByPlaceholder(en.cycles.search).fill(code);
  await main.getByTestId('cycle-row').filter({ hasText: code }).locator('td').first().click();
  await expect(page).toHaveURL(new RegExp(`/cycles/${id}/details$`), { timeout: 15000 });
}

const legOf = (page: Page, legId: string) => page.locator(`[data-testid="shipment-leg"][data-leg-id="${legId}"]`);
const dialog = (page: Page, kind: string) => page.locator(`[data-shipment-dialog="${kind}"]`);

test.describe('Preparing — the cycle page', () => {
  test('TC-PREP-01: Change status from Purchasing offers Preparing and no shortcut; choosing it confirms the order and the badge says Preparing', async ({ page, request }) => {
    const { headers, cycle } = await purchasingCycle(request);
    await login(page);
    await openCycle(page, cycle.code, cycle.id);
    await page.getByTestId('change-status').click();
    const status = page.getByTestId('change-status-dialog');
    await expect(status.locator('[data-status="PREPARING"]')).toBeVisible();
    await expect(status.locator('[data-status="IN_TRANSIT"]')).toHaveCount(0);
    await expect(status.locator('[data-status="ARRIVED_UAE"]')).toHaveCount(0);
    await status.locator('[data-status="PREPARING"]').click();
    await expect(page.getByTestId('cycle-status')).toHaveText(en.codes.cycleStatus.PREPARING);
    const now = await cycleNow(request, headers, cycle.id);
    expect(now.status).toBe('PREPARING');
    expect(now.purchaseOrders.map((p) => p.status)).toEqual(['CONFIRMED']);

    // The second visit offers Preparing's moves: on, back, or cancel.
    await page.getByTestId('change-status').click();
    for (const s of ['IN_TRANSIT', 'PURCHASING', 'CANCELLED']) {
      await expect(status.locator(`[data-status="${s}"]`)).toBeVisible();
    }
    await expect(status.locator('[data-status="PREPARING"]')).toHaveCount(0);
  });

  test('TC-PREP-02: the first departure moves Preparing on to In transit; undoing it brings the cycle back to Preparing, and the dialog says so first', async ({ page, request }) => {
    const { headers, cycle, legs } = await purchasingCycle(request);
    await request.post(`${API}/cycles/${cycle.id}/transition`, { headers, data: { status: 'PREPARING' } });
    await login(page);
    await openCycle(page, cycle.code, cycle.id);

    await legOf(page, legs[0].id).getByTestId('record-departure').click();
    await dialog(page, 'record-departure').getByRole('button', { name: en.shipment.recordDeparture, exact: true }).click();
    await expect(page.getByText(`${en.shipment.departureRecorded} — cycle is now ${en.codes.cycleStatus.IN_TRANSIT}`)).toBeVisible();
    await expect(page.getByTestId('cycle-status')).toHaveText(en.codes.cycleStatus.IN_TRANSIT);

    await legOf(page, legs[0].id).getByTestId('undo-departure').click();
    await expect(dialog(page, 'undo-departure')).toContainText(en.shipment.undoDepartureToPreparing);
    await dialog(page, 'undo-departure').getByRole('button', { name: en.shipment.undoDeparture, exact: true }).click();
    await expect(page.getByText(`${en.shipment.departureUndone} — cycle is now ${en.codes.cycleStatus.PREPARING}`)).toBeVisible();
    await expect(page.getByTestId('cycle-status')).toHaveText(en.codes.cycleStatus.PREPARING);
    expect((await cycleNow(request, headers, cycle.id)).status).toBe('PREPARING');
  });
});

test.describe('Preparing — the cycles list', () => {
  test('TC-PREP-03: a Preparing chip filters the list, in English and in Arabic', async ({ page, request }) => {
    const { headers, cycle } = await purchasingCycle(request);
    await request.post(`${API}/cycles/${cycle.id}/transition`, { headers, data: { status: 'PREPARING' } });
    for (const [locale, m] of [['en', en], ['ar', ar]] as const) {
      await login(page, locale);
      await page.locator(`aside a[href="/${locale}/cycles"]`).filter({ visible: true }).first().click();
      const main = page.getByRole('main');
      await main.getByRole('button', { name: new RegExp(`^${m.codes.cycleStatus.PREPARING} \\(`) }).click();
      await main.getByPlaceholder(m.cycles.search).fill(cycle.code);
      await expect(main.getByTestId('cycle-row').filter({ hasText: cycle.code })).toContainText(m.codes.cycleStatus.PREPARING);
    }
  });
});
