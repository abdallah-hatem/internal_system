/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The purchase order step keeps what has been entered
 * ═══════════════════════════════════════════════════════════════════════
 *  The form carried a remount key built from the supplier and the currency, so
 *  choosing a currency rebuilt the whole form — and the supplier, which was an
 *  uncontrolled field holding a value not yet in state, came back empty.
 *
 *  Introduced by the FX prefill: giving the currency picker an onChange was
 *  what made the key change mid-edit. Nothing had moved that state before.
 */
import { test, expect, Page } from '@playwright/test';
import { apiCtx, API } from './support/fixtures';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

const pickerFor = (page: Page, name: string) =>
  page.locator(`input[type="hidden"][name="${name}"]`).locator('..').getByRole('combobox');

async function choose(page: Page, name: string, index = 0) {
  await pickerFor(page, name).click();
  await page.getByRole('listbox').getByRole('option').nth(index).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

/** A cycle sitting on the purchase order step. */
async function cycleAtStep2(page: Page, request: any) {
  const { mk } = await apiCtx(request);
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
  await login(page);
  await page.goto(`${BASE}/en/cycles/${cycle.id}`);
  await expect(pickerFor(page, 'supplierId')).toBeVisible({ timeout: 15000 });
  return cycle;
}

test.describe('Purchase order step', () => {
  test('TC-WIZ-01: choosing a currency does not clear the supplier', async ({ page, request }) => {
    await cycleAtStep2(page, request);

    await choose(page, 'supplierId', 0);
    const chosen = await page.locator('input[type="hidden"][name="supplierId"]').inputValue();
    expect(chosen).not.toBe('');

    await choose(page, 'currency', 1);

    // The supplier is still the one that was picked.
    expect(await page.locator('input[type="hidden"][name="supplierId"]').inputValue()).toBe(chosen);
  });

  test('TC-WIZ-02: choosing a supplier does not clear the currency', async ({ page, request }) => {
    // The key contained both, so it cut the other way too.
    await cycleAtStep2(page, request);

    await choose(page, 'currency', 2);
    const currency = await page.locator('input[type="hidden"][name="currency"]').inputValue();
    expect(currency).not.toBe('');

    await choose(page, 'supplierId', 0);
    expect(await page.locator('input[type="hidden"][name="currency"]').inputValue()).toBe(currency);
  });

  test('TC-WIZ-03: the FX rate still fills in when the currency changes', async ({
    page,
    request,
  }) => {
    // The prefill is what introduced the bug, so it has to survive the fix.
    const { headers } = await apiCtx(request);
    const rates = (await (await request.get(`${API}/currency-rates/map`, { headers })).json()).data;

    await cycleAtStep2(page, request);
    await choose(page, 'supplierId', 0);

    await pickerFor(page, 'currency').click();
    await page.getByRole('listbox').getByRole('option').filter({ hasText: 'USD' }).first().click();

    await expect(page.locator('input[name="fxRateToEgp"]')).toHaveValue(
      Number(rates.USD).toFixed(4),
    );
  });
});
