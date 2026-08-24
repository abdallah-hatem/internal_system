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
 * Choose from a Select by its hidden input's name, by position.
 *
 * No picker is a native <select> any more — not even the short fixed enums —
 * so selectOption() applies nowhere. Use pickValueByName when the option
 * matters; this one is for "just take the first supplier".
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

/**
 * Choose a specific option from a Select, by the text on the option.
 *
 * Lists under four options no longer render a search box, so the panel is just
 * the options — clicking the one you want is the whole interaction.
 */
async function pickValueByName(page: Page, name: string, label: string | RegExp) {
  const trigger = page
    .locator(`input[type="hidden"][name="${name}"]`)
    .locator('..')
    .getByRole('combobox');
  await trigger.click();
  await page.getByRole('listbox').waitFor({ state: 'visible' });
  await page.getByRole('listbox').getByRole('option').filter({ hasText: label }).first().click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(trigger).toContainText(label);
}

/**
 * Choose a date from the DatePicker that replaced <input type="date">.
 *
 * The value now lives in a hidden input, so fill() no longer reaches it — the
 * date is chosen the way a person chooses it: open the popover, step to the
 * month, click the day.
 */
async function pickDate(page: Page, name: string, iso: string) {
  await page.locator(`[data-date-picker="${name}"]`).click();
  const grid = page.getByRole('grid');
  await grid.waitFor({ state: 'visible' });

  const targetMonth = iso.slice(0, 7);
  for (let i = 0; i < 36; i++) {
    // Days from the neighbouring months are marked, so the first unmarked cell
    // always belongs to the month on screen.
    const shown = await grid.locator('[data-day]:not([data-outside])').first().getAttribute('data-day');
    const shownMonth = (shown ?? '').slice(0, 7);
    if (shownMonth === targetMonth) break;
    await page.getByTestId(shownMonth < targetMonth ? 'calendar-next' : 'calendar-prev').click();
  }

  await grid.locator(`[data-day="${iso}"]:not([data-outside])`).click();
  await expect(page.locator(`input[type="hidden"][name="${name}"]`)).toHaveValue(iso);
}

test.describe('Shipment costing', () => {
  test('TC-COST-01: New leg form offers per piece, per weight and flat', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await page.getByRole('button', { name: /new shipping leg/i }).click();

    // Three options and no search box — the panel is short enough to read.
    const basis = page
      .locator('input[type="hidden"][name="costBasis"]')
      .locator('..')
      .getByRole('combobox');
    await expect(basis).toBeVisible({ timeout: 10000 });
    await basis.click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(3);
    // (the page's own search boxes don't count — this is the panel's)
    expect(await page.locator('[data-slot="command-input"]').count()).toBe(0);
    await page.keyboard.press('Escape');
    await expect(page.getByText(/cost per piece/i)).toBeVisible();
  });

  test('TC-COST-02: Per-piece total is rate x pieces', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await page.getByRole('button', { name: /new shipping leg/i }).click();

    await page.locator('input[data-field="ratePerUnit"]').fill('12.5');
    await page.locator('input[name="chargeablePieces"]').fill('340');

    const preview = page.locator('[data-testid^="leg-cost-preview"]');
    await expect(preview).toContainText('4,250.00 EGP');
  });

  test('TC-COST-03: Switching to weight asks for kilograms', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await page.getByRole('button', { name: /new shipping leg/i }).click();

    await pickValueByName(page, 'costBasis', /per weight/i);
    await expect(page.getByText(/cost per kg/i)).toBeVisible();
    await page.locator('input[data-field="ratePerUnit"]').fill('20');
    await page.locator('input[name="chargeableWeightKg"]').fill('250');
    await expect(page.locator('[data-testid^="leg-cost-preview"]')).toContainText('5,000.00 EGP');
  });

  test('TC-COST-04: A non-EGP leg converts at its FX rate', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await page.getByRole('button', { name: /new shipping leg/i }).click();

    await page.locator('input[data-field="ratePerUnit"]').fill('10');
    await page.locator('input[name="chargeablePieces"]').fill('100');
    await pickValueByName(page, 'currency', 'USD');
    await page.locator('input[name="fxRateToEgp"]').fill('48.5');

    // 10 x 100 USD at 48.5 = 48,500 EGP
    await expect(page.locator('[data-testid^="leg-cost-preview"]')).toContainText('48,500.00 EGP');
  });

  test('TC-COST-05: A China cycle wizard asks for both legs', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles/new`);

    await pickValueByName(page, 'originType', 'China');
    await pickValueByName(page, 'currency', 'USD');
    await page.getByRole('button', { name: /save & continue/i }).click();

    // Step 2 — minimal purchase order
    await expect(page.locator('input[type="hidden"][name="supplierId"]')).toBeAttached({ timeout: 10000 });
    await pickByName(page, 'supplierId');
    await pickValueByName(page, 'currency', 'USD');
    await page.locator('input[name="fxRateToEgp"]').fill('48.5');
    await pickDate(page, 'orderedOn', '2026-08-20');
    await page.getByRole('button', { name: /add item/i }).click();

    // The product picker is the line item's own searchable Select.
    // The line-item picker is controlled by value/onChange, so it has no name
    // to anchor on — locate it by the placeholder text on its trigger.
    const productTrigger = page.locator('[role="combobox"]', { hasText: 'Select product' }).last();
    await productTrigger.click();
    await page.getByRole('listbox').getByRole('option').first().click();

    // Qty is still a number input; the price is a MoneyInput, which renders
    // text so it can group digits as they are typed. Counting number inputs
    // positionally used to reach it and silently stopped.
    await page.locator('input[type="number"]').nth(1).fill('100'); // qty
    await page.locator('input[data-field="unitPrice"]').fill('5');
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
    await expect(leg1.locator('[data-field="leg1_ratePerUnit"]')).toBeVisible();
    // costBasis rides in a hidden input now, so it is attached, never visible.
    await expect(leg2.locator('input[type="hidden"][name="leg2_costBasis"]')).toBeAttached();

    // Step 2 ordered 100 pieces, so neither leg asks for that number again. It
    // stays editable — a forwarder billing by carton charges for fewer — but the
    // whole-order case is filled in.
    await expect(leg1.locator('[name="leg1_chargeablePieces"]')).toHaveValue('100');
    await expect(leg2.locator('[name="leg2_chargeablePieces"]')).toHaveValue('100');
    await expect(leg1.getByText(/prefilled from the 100 ordered/i)).toBeVisible();
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
