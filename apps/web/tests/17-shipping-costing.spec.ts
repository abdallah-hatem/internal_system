/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Shipment costing and landed cost
 * ═══════════════════════════════════════════════════════════════════════
 *  Covers the two route shapes (China→UAE→Egypt and UAE→Egypt), per-piece
 *  and per-weight charging, and shipping reaching landed unit cost.
 */
import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:3000';
const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

async function token(request: any) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return (await auth.json()).data.accessToken;
}


/**
 * Choose from a searchable Select by its hidden input's name.
 *
 * The entity pickers are no longer native <select>, so selectOption() does not
 * apply to them. Short fixed enums (origin type, currency) are still native and
 * keep using selectOption.
 */
async function pickByName(page: Page, name: string, index = 0) {
  // The trigger sits beside the hidden input that carries the value; the panel
  // itself is portaled to document.body by Radix.
  const trigger = page
    .locator(`input[type="hidden"][name="${name}"]`)
    .locator('..')
    .getByRole('combobox');
  await trigger.click();
  await page.getByRole('listbox').waitFor({ state: 'visible' });
  await page.getByRole('listbox').getByRole('option').nth(index).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

test.describe('Shipment costing', () => {
  test('TC-COST-01: New leg form offers per piece, per weight and flat', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await page.getByRole('button', { name: /new shipping leg/i }).click();

    const basis = page.locator('select[name="costBasis"]');
    await expect(basis).toBeVisible({ timeout: 10000 });
    await expect(basis.locator('option')).toHaveCount(3);
    await expect(page.getByText(/cost per piece/i)).toBeVisible();
  });

  test('TC-COST-02: Per-piece total is rate x pieces', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await page.getByRole('button', { name: /new shipping leg/i }).click();

    await page.locator('input[name="ratePerUnit"]').fill('12.5');
    await page.locator('input[name="chargeablePieces"]').fill('340');

    const preview = page.locator('[data-testid^="leg-cost-preview"]');
    await expect(preview).toContainText('4,250.00 EGP');
  });

  test('TC-COST-03: Switching to weight asks for kilograms', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await page.getByRole('button', { name: /new shipping leg/i }).click();

    await page.locator('select[name="costBasis"]').selectOption('PER_WEIGHT');
    await expect(page.getByText(/cost per kg/i)).toBeVisible();
    await page.locator('input[name="ratePerUnit"]').fill('20');
    await page.locator('input[name="chargeableWeightKg"]').fill('250');
    await expect(page.locator('[data-testid^="leg-cost-preview"]')).toContainText('5,000.00 EGP');
  });

  test('TC-COST-04: A non-EGP leg converts at its FX rate', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await page.getByRole('button', { name: /new shipping leg/i }).click();

    await page.locator('input[name="ratePerUnit"]').fill('10');
    await page.locator('input[name="chargeablePieces"]').fill('100');
    await page.locator('select[name="currency"]').selectOption('USD');
    await page.locator('input[name="fxRateToEgp"]').fill('48.5');

    // 10 x 100 USD at 48.5 = 48,500 EGP
    await expect(page.locator('[data-testid^="leg-cost-preview"]')).toContainText('48,500.00 EGP');
  });

  test('TC-COST-05: A China cycle wizard asks for both legs', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles/new`);

    await page.locator('select[name="originType"]').selectOption('CHINA');
    await page.locator('select[name="currency"]').selectOption('USD');
    await page.getByRole('button', { name: /save & continue/i }).click();

    // Step 2 — minimal purchase order
    await expect(page.locator('input[type="hidden"][name="supplierId"]')).toBeAttached({ timeout: 10000 });
    await pickByName(page, 'supplierId');
    await page.locator('select[name="currency"]').selectOption('USD');
    await page.locator('input[name="fxRateToEgp"]').fill('48.5');
    await page.locator('input[name="orderedOn"]').fill('2026-08-20');
    await page.getByRole('button', { name: /add item/i }).click();

    // The product picker is the line item's own searchable Select.
    // The line-item picker is controlled by value/onChange, so it has no name
    // to anchor on — locate it by the placeholder text on its trigger.
    const productTrigger = page.locator('[role="combobox"]', { hasText: 'Select product' }).last();
    await productTrigger.click();
    await page.getByRole('listbox').getByRole('option').first().click();

    const numbers = page.locator('input[type="number"]');
    await numbers.nth(1).fill('100');
    await numbers.nth(2).fill('5');
    await page.getByRole('button', { name: /save & continue/i }).click();

    // Step 3 — both legs present
    const leg1 = page.getByTestId('wizard-leg-1');
    const leg2 = page.getByTestId('wizard-leg-2');
    await expect(leg1).toBeVisible({ timeout: 15000 });
    await expect(leg2).toBeVisible();
    // Exact names: the cost block heading ('China to UAE cost') also matches a
    // loose pattern, which would be ambiguous.
    await expect(leg1.getByRole('heading', { name: 'China to UAE', exact: true })).toBeVisible();
    await expect(leg2.getByRole('heading', { name: 'UAE to Egypt', exact: true })).toBeVisible();
    // Each leg carries its own independent cost block.
    await expect(leg1.locator('[name="leg1_ratePerUnit"]')).toBeVisible();
    await expect(leg2.locator('[name="leg2_costBasis"]')).toBeVisible();
  });

  test('TC-COST-06: API — shipping is spread across the items it moved', async ({ request }) => {
    const t = await token(request);
    const headers = { Authorization: `Bearer ${t}` };

    const cycles = await request.get(`${API}/cycles?limit=200`, { headers });
    const list = (await cycles.json()).data;

    // Find a cycle that has both purchased items and a costed leg.
    for (const c of list) {
      const res = await request.get(`${API}/costing/cycles/${c.id}/landed-cost`, { headers });
      if (!res.ok()) continue;
      const body = await res.json();
      if (!body.items?.length) continue;
      if (Number(body.totals.shippingEgp) <= 0) continue;

      // Every leg's cost must be fully allocated, to the cent.
      const allocated = body.items.reduce(
        (s: number, i: any) => s + Number(i.shippingCostEgp),
        0,
      );
      expect(Math.abs(allocated - Number(body.totals.shippingEgp))).toBeLessThan(0.02);

      // Landed cost = goods + allocated shipping, per unit.
      for (const i of body.items) {
        const total = Number(i.goodsCostEgp) + Number(i.shippingCostEgp);
        expect(Math.abs(total - Number(i.totalLandedCostEgp))).toBeLessThan(0.02);
        if (Number(i.qty) > 0) {
          const perUnit = total / Number(i.qty);
          expect(Math.abs(perUnit - Number(i.landedUnitCostEgp))).toBeLessThan(0.01);
        }
      }
      return;
    }
    test.skip(true, 'No cycle with both purchased items and shipping cost');
  });

  test('TC-COST-07: API — a China cycle rejects a third leg', async ({ request }) => {
    const t = await token(request);
    const headers = { Authorization: `Bearer ${t}` };

    const cycles = await request.get(`${API}/cycles?limit=200`, { headers });
    const china = (await cycles.json()).data.find((c: any) => c.originType === 'CHINA');
    test.skip(!china, 'No China cycle available');

    const res = await request.post(`${API}/cycles/${china.id}/shipping-legs`, {
      headers,
      data: {
        sequence: 3,
        origin: 'Nowhere',
        destination: 'Elsewhere',
        provider: 'X',
        costBasis: 'FLAT',
        amount: 1,
      },
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/at most two shipping legs/i);
  });

  test('TC-COST-08: API — per-piece shipping requires a rate and a count', async ({ request }) => {
    const t = await token(request);
    const headers = { Authorization: `Bearer ${t}` };

    // A fresh cycle, so the leg-sequence rule cannot mask the costing rule.
    const created = await request.post(`${API}/cycles`, {
      headers,
      data: { originType: 'UAE_DIRECT', currency: 'AED' },
    });
    expect(created.ok()).toBeTruthy();
    const cycle = (await created.json()).data;

    const res = await request.post(`${API}/cycles/${cycle.id}/shipping-legs`, {
      headers,
      data: {
        sequence: 1,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        provider: 'X',
        costBasis: 'PER_PIECE',
        ratePerUnit: 10,
        // chargeablePieces deliberately omitted
      },
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/chargeablePieces/i);
  });
});
