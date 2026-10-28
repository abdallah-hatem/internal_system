/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: What made a profit and loss bar (owner 2026-10-28)
 * ═══════════════════════════════════════════════════════════════════════
 *  Clicking a bar of Analytics' profit and loss opens its breakdown: the
 *  bar's own figures, by order, expense and repayment, each row a link.
 *  BUSINESS_LOGIC §12 "What made a bar". Written 2026-10-28, NOT run (owner:
 *  e2e not for now); the database suite is
 *  apps/api/src/modules/analytics/profit-breakdown.db.spec.ts.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { WEB as BASE, API } from './support/env';

const EMAIL = 'abdallah@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

async function token(request: APIRequestContext) {
  const auth = await request.post(`${API}/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
  return (await auth.json()).data.accessToken;
}

test.describe('What made a bar', () => {
  test('TC-PNLBD-01: clicking a bar with sales opens its breakdown, whose net profit is the bar’s', async ({ page, request }) => {
    const h = { Authorization: `Bearer ${await token(request)}` };
    const pnl = (await (await request.get(`${API}/analytics/profit-and-loss`, { headers: h })).json()).data;
    const bar = [...pnl.buckets].reverse().find((b: { salesEgp: number }) => b.salesEgp !== 0);
    test.skip(!bar, 'nothing sold yet');

    await login(page);
    // Reached the way a person does: the menu, then All time.
    await page.getByRole('link', { name: 'Analytics' }).first().click();
    await page.getByTestId('pnl-period').getByRole('button', { name: 'All time' }).click();
    const chart = page.getByTestId('pnl-chart');
    await chart.locator(`[data-bucket="${bar.key}"]`).click();
    const popup = page.getByTestId('pnl-breakdown');
    await expect(popup).toBeVisible();
    await expect(popup.getByTestId('pnl-breakdown-totals')).toBeVisible();
    const net = popup.getByTestId('pnl-breakdown-totals').locator('[data-line="net"] dd');
    const shown = Number((await net.innerText()).replace(/[^\d.-]/g, ''));
    expect(shown).toBeCloseTo(bar.netProfitEgp, 2);
    await expect(popup.getByTestId('pnl-breakdown-orders')).toBeVisible();
  });

  test('TC-PNLBD-02: an order row opens that order on Sales', async ({ page, request }) => {
    const h = { Authorization: `Bearer ${await token(request)}` };
    const pnl = (await (await request.get(`${API}/analytics/profit-and-loss`, { headers: h })).json()).data;
    const bar = [...pnl.buckets].reverse().find((b: { salesEgp: number }) => b.salesEgp !== 0);
    test.skip(!bar, 'nothing sold yet');

    await login(page);
    await page.goto(`${BASE}/en/analytics?period=all`);
    await page.getByTestId('pnl-chart').locator(`[data-bucket="${bar.key}"]`).click();
    const row = page.getByTestId('pnl-breakdown-orders').locator('li[data-order]').first();
    const orderNo = await row.getByRole('link').first().innerText();
    await row.getByRole('link').first().click();
    await expect(page).toHaveURL(/\/sales\?order=/);
    await expect(page.getByRole('dialog')).toContainText(orderNo);
  });

  test('TC-PNLBD-03: a quiet day says so', async ({ page }) => {
    await login(page);
    // A custom range long before anything was recorded: one quiet day.
    await page.goto(`${BASE}/en/analytics?period=custom&from=2001-03-14&to=2001-03-14`);
    await page.getByTestId('pnl-chart').locator('[data-bucket="2001-03-14"]').click();
    await expect(page.getByTestId('pnl-breakdown-empty')).toHaveText('Nothing was recorded in this period.');
  });
});
