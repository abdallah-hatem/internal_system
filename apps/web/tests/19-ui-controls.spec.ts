/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Shared UI controls
 * ═══════════════════════════════════════════════════════════════════════
 *  The searchable Select replaced native <select> on the long entity lists,
 *  and money is rendered through one component so Decimal values arriving as
 *  strings still format. Both are easy to regress silently.
 */
import { test, expect, Page } from '@playwright/test';

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

test.describe('Searchable select', () => {
  test('TC-UI-01: opening focuses the search box so you can type straight away', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settlements`);
    await page.locator('#cycle-select').click();

    const search = page.getByPlaceholder(/search/i).last();
    await expect(search).toBeFocused();
  });

  test('TC-UI-02: typing filters the list', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settlements`);
    await page.locator('#cycle-select').click();

    const before = await page.getByRole('option').count();
    expect(before).toBeGreaterThan(1);

    await page.getByPlaceholder(/search/i).last().fill('DEMO-001');
    await expect.poll(() => page.getByRole('option').count()).toBeLessThan(before);
    await expect(page.getByRole('option').first()).toContainText('CYC-DEMO-001');
  });

  test('TC-UI-03: a search matching nothing says so instead of showing an empty box', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settlements`);
    await page.locator('#cycle-select').click();
    await page.getByPlaceholder(/search/i).last().fill('zzzz-no-such-cycle');

    await expect(page.getByRole('option')).toHaveCount(0);
    await expect(page.getByText(/no matches/i)).toBeVisible();
  });

  test('TC-UI-04: arrow keys and Enter pick an option without the mouse', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settlements`);
    const trigger = page.locator('#cycle-select');
    await trigger.click();

    await page.getByPlaceholder(/search/i).last().fill('DEMO');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(trigger).toContainText('CYC-DEMO');
  });

  test('TC-UI-05: Escape closes the list and keeps the previous value', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settlements`);
    const trigger = page.locator('#cycle-select');

    await trigger.click();
    await page.getByPlaceholder(/search/i).last().fill('DEMO');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const chosen = (await trigger.textContent())?.trim();

    await trigger.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    expect((await trigger.textContent())?.trim()).toBe(chosen);
  });

  test('TC-UI-06: clicking outside closes the list', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settlements`);
    await page.locator('#cycle-select').click();
    await expect(page.getByRole('listbox')).toBeVisible();

    await page.locator('h1').first().click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
  });
});

test.describe('Money rendering', () => {
  test('TC-UI-07: amounts carry thousands separators and two decimals', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/sales`);

    // Decimal values arrive from the API as strings; calling toLocaleString on
    // a string returns it unchanged, which is how "199999800 EGP" reached the
    // page. Every amount must show grouped digits and exactly two decimals.
    const amounts = page.locator('text=/\\d[\\d,]*\\.\\d{2}\\s*EGP/');
    await expect.poll(() => amounts.count(), { timeout: 10000 }).toBeGreaterThan(0);

    const unformatted = page.locator('text=/\\b\\d{5,}\\s*EGP/');
    expect(await unformatted.count()).toBe(0);
  });

  test('TC-UI-08: Arabic keeps amounts left-to-right', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/sales`);

    // In an RTL paragraph a bidi-neutral run drifts; money must stay isolated
    // or "1,234.00 EGP" renders with the currency on the wrong side.
    const money = page.locator('[dir="ltr"]').first();
    await expect(money).toBeVisible();
  });
});
