/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Analytics
 * ═══════════════════════════════════════════════════════════════════════
 *  Regressions for an Analytics page that read as empty: draft orders were
 *  counted, the month series disagreed with the dashboard, cycle comparison
 *  was restricted to closed cycles, and the one bar with data was scrolled
 *  out of view.
 */
import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:3000';
const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function token(request: any) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return (await auth.json()).data.accessToken;
}

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test.describe('Analytics figures', () => {
  test('TC-ANA-01: monthly revenue sums to the dashboard total', async ({ request }) => {
    const t = await token(request);
    const h = { Authorization: `Bearer ${t}` };

    const dash = (await (await request.get(`${API}/analytics/dashboard`, { headers: h })).json()).data;
    const months = (await (await request.get(`${API}/analytics/revenue-by-month`, { headers: h })).json()).data;

    const summed = months.reduce((s: number, m: any) => s + Number(m.revenue), 0);
    // These read from the same sales but once used different status filters,
    // so a partially paid order counted on one page and not the other.
    expect(summed).toBeCloseTo(Number(dash.totalRevenue), 2);
  });

  test('TC-ANA-02: draft orders are excluded from top products', async ({ request }) => {
    const t = await token(request);
    const h = { Authorization: `Bearer ${t}` };

    const before = (await (await request.get(`${API}/analytics/top-products`, { headers: h })).json()).data;
    const target = before[0];
    test.skip(!target, 'no products with sales');

    // A draft is a quote that has reserved nothing; counting it once reported
    // three million units sold.
    //
    // The quantity used to be 500,000, chosen to be conspicuous in the totals.
    // e67dbdc made an order for more stock than exists refuse outright, so the
    // draft was never created and this sat red — testing the refusal by
    // accident instead of the thing it is named after. A small quantity still
    // moves the figure if drafts are counted, and is a draft that can exist.
    const draft = await request.post(`${API}/sales/orders`, {
      headers: h,
      data: {
        customerId: '00000000-0000-4000-8000-000000000050',
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: target.productId, quantity: 1, unitPrice: 1 }],
      },
    });
    expect(draft.ok(), `draft create: ${await draft.text()}`).toBeTruthy();

    const after = (await (await request.get(`${API}/analytics/top-products`, { headers: h })).json()).data;
    const same = after.find((p: any) => p.productId === target.productId);
    expect(same.totalQuantitySold).toBe(target.totalQuantitySold);
  });

  test('TC-ANA-03: cycle profitability reports cycles that are still running', async ({ request }) => {
    const t = await token(request);
    const h = { Authorization: `Bearer ${t}` };

    const cycles = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers: h })).json()).data;
    // Restricting this to CLOSED cycles made the comparison permanently empty.
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles.some((c: any) => c.status !== 'CLOSED')).toBeTruthy();

    for (const c of cycles) {
      // Profit is revenue less the cost of what sold, plus anything a supplier
      // gave back — a refund recovers cost without re-pricing any batch.
      expect(Number(c.profit)).toBeCloseTo(
        Number(c.totalRevenue) - Number(c.totalCost) + Number(c.supplierRefundsEgp ?? 0),
        2,
      );
    }
  });

  test('TC-ANA-04: cycle revenue and cost reconcile with the dashboard', async ({ request }) => {
    const t = await token(request);
    const h = { Authorization: `Bearer ${t}` };

    const dash = (await (await request.get(`${API}/analytics/dashboard`, { headers: h })).json()).data;
    const cycles = (await (await request.get(`${API}/analytics/cycle-profitability`, { headers: h })).json()).data;

    const revenue = cycles.reduce((s: number, c: any) => s + Number(c.totalRevenue), 0);
    const cogs = cycles.reduce((s: number, c: any) => s + Number(c.totalCost), 0);

    expect(revenue).toBeCloseTo(Number(dash.totalRevenue), 2);
    expect(cogs).toBeCloseTo(Number(dash.totalCogs), 2);
  });
});

test.describe('Analytics page', () => {
  test('TC-ANA-05: the month with revenue is scrolled into view', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/analytics`);

    const strip = page.locator('div.overflow-x-auto').first();
    await expect(strip).toBeVisible({ timeout: 10000 });

    // The series runs oldest first, so without scrolling to the end the only
    // months with data sit past the right edge and the page reads as empty.
    await expect
      .poll(async () => strip.evaluate((el) => el.scrollLeft + el.clientWidth >= el.scrollWidth - 4), {
        timeout: 10000,
      })
      .toBe(true);
  });

  test('TC-ANA-06: bars have height, not just labels', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/analytics`);
    await expect(page.locator('div.overflow-x-auto').first()).toBeVisible({ timeout: 10000 });

    // A percentage height inside an auto-height column collapses to nothing,
    // which drew the chart as a row of labels with no bars at all.
    const tallest = await page
      .locator('.bg-primary-500')
      .evaluateAll((els) => Math.max(0, ...els.map((e) => (e as HTMLElement).getBoundingClientRect().height)));
    expect(tallest).toBeGreaterThan(20);
  });

  test('TC-ANA-07: products show money, not only unit counts', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/analytics`);

    const products = page.locator('section', { hasText: 'Top Products' });
    await expect(products).toBeVisible({ timeout: 10000 });
    await expect(products.getByText(/EGP/).first()).toBeVisible();
    await expect(products.getByText(/%/).first()).toBeVisible();
  });
});
