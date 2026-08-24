/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Legs point at their provider, and the dashboard adds up
 * ═══════════════════════════════════════════════════════════════════════
 *  Two things that were quietly wrong and looked fine.
 *
 *  Every shipping-leg picker in the app carried the provider's NAME, so
 *  `providerId` was null on every leg the UI ever created. The leg still showed
 *  the right name, so nothing looked broken — but a provider's shipments could
 *  not be found from the provider, and the delete guard counts through exactly
 *  that relation. It reported every provider as unused, however many legs were
 *  riding on it, and deleting one left those legs naming a record that no longer
 *  existed.
 *
 *  And the dashboard subtracted operating expenses from net profit without ever
 *  showing them, so Revenue − COGS did not equal Net Profit and nothing on the
 *  page accounted for the gap.
 */
import { test, expect, Page } from '@playwright/test';
import { apiCtx, API, daysAgo, today } from './support/fixtures';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

const num = (v: any) => Number(v ?? 0);
const stamp = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

const pickerFor = (page: Page, name: string) =>
  page.locator(`input[type="hidden"][name="${name}"]`).locator('..').getByRole('combobox');

test.describe('Shipping legs and their provider', () => {
  test('TC-LINK-01: a leg made through the wizard points at the provider record', async ({
    page,
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const tag = stamp();
    const provider = await mk('providers', { name: `Linked Freight ${tag}` });
    const supplier = await mk('suppliers', { name: `Linked Supplier ${tag}`, country: 'AE' });
    const product = await mk('products', { name: `Linked Part ${tag}`, minStock: 0 });

    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: today(),
      items: [{ productId: product.id, orderedQty: 5, unitPrice: 10 }],
    });

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}`);

    // Step 3 carries the provider picker.
    await expect(pickerFor(page, 'leg1_providerId')).toBeVisible({ timeout: 20000 });
    await pickerFor(page, 'leg1_providerId').click();
    await page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: provider.name })
      .first()
      .click();

    // The form carries the id, not the name. That is the whole fix: the name
    // alone left the leg unlinked while still displaying correctly.
    await expect(page.locator('input[type="hidden"][name="leg1_providerId"]')).toHaveValue(
      provider.id,
    );
  });

  test('TC-LINK-02: the API stores the link, and the name alongside it', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const tag = stamp();
    const provider = await mk('providers', { name: `Stored Freight ${tag}` });
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

    await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
      providerId: provider.id, provider: provider.name,
      costBasis: 'FLAT', amount: 100, currency: 'EGP', fxRateToEgp: 1,
      departedOn: daysAgo(10), arrivedOn: daysAgo(2),
    });

    const detail = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const leg = (detail.data ?? detail).shippingLegs[0];

    expect(leg.providerId).toBe(provider.id);
    // The name is kept too — it is what the tables render, and it has to
    // survive the provider being renamed or removed.
    expect(leg.provider).toBe(provider.name);
  });

  test('TC-LINK-03: a provider carrying shipments cannot be deleted', async ({
    request,
  }) => {
    // The consequence of the bug, stated directly. With providerId null the
    // guard counted zero and let the provider go, leaving legs naming a record
    // that no longer existed.
    const { headers, mk } = await apiCtx(request);
    const tag = stamp();
    const provider = await mk('providers', { name: `Busy Freight ${tag}` });
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

    await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
      providerId: provider.id, provider: provider.name,
      costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
    });

    const deleted = await request.delete(`${API}/providers/${provider.id}`, { headers });
    expect(deleted.status()).toBe(400);
    expect((await deleted.json()).error.code).toBe('PROVIDER_IN_USE');
  });

  test('TC-LINK-04: an unused provider can still be deleted', async ({ request }) => {
    // The other direction. A guard that refuses everything is not a guard —
    // the provider created by mistake still has to be removable.
    const { headers, mk } = await apiCtx(request);
    const provider = await mk('providers', { name: `Idle Freight ${stamp()}` });

    const deleted = await request.delete(`${API}/providers/${provider.id}`, { headers });
    expect(deleted.ok(), `delete: ${await deleted.text()}`).toBeTruthy();
  });
});

test.describe('The dashboard adds up', () => {
  test('TC-DASH-01: revenue less cost less expenses is the profit shown', async ({
    request,
  }) => {
    const { headers } = await apiCtx(request);
    const body = await (
      await request.get(`${API}/analytics/dashboard`, { headers })
    ).json();
    const d = body.data ?? body;

    expect(num(d.netProfit)).toBeCloseTo(
      num(d.totalRevenue) - num(d.totalCogs) - num(d.totalExpenses),
      2,
    );
  });

  test('TC-DASH-02: every figure the profit depends on is on the page', async ({
    page,
    request,
  }) => {
    // Net profit subtracted expenses and the card was never rendered, so the
    // arithmetic could not be followed and the difference looked like an error.
    const { headers } = await apiCtx(request);
    const d = (await (await request.get(`${API}/analytics/dashboard`, { headers })).json()).data;

    await login(page);
    const main = page.locator('main').first();
    await expect(main).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Net Profit')).toBeVisible({ timeout: 15000 });

    const text = await main.innerText();
    for (const label of ['Revenue', 'Cost of Goods Sold', 'Expenses', 'Net Profit']) {
      expect(text).toContain(label);
    }

    // And the expenses card shows the figure the profit was computed from,
    // rather than a label with something else under it.
    const shown = (n: number) =>
      n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(text).toContain(shown(num(d.totalExpenses)));
  });
});
