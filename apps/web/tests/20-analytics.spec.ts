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
import { WEB as BASE, API } from './support/env';

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
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
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

  test('TC-ANA-08: items in stock is every unit on the shelf, the sum the inventory page shows', async ({ request }) => {
    const t = await token(request);
    const h = { Authorization: `Bearer ${t}` };

    const dash = (await (await request.get(`${API}/analytics/dashboard`, { headers: h })).json()).data;
    const body = (await (await request.get(`${API}/inventory?limit=1000`, { headers: h })).json()) as {
      data?: { totalStock?: number | string }[];
    };
    const shelf = (body.data ?? []).reduce((s, p) => s + Number(p.totalStock ?? 0), 0);

    // Units, all products together — not how many products exist (owner, 2026-10-11).
    expect(dash.unitsInStock).toBeDefined();
    expect(Number(dash.unitsInStock)).toBeCloseTo(shelf, 3);
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
  test('TC-ANA-05: the profit and loss chart shows every bucket without scrolling sideways', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/analytics`);

    // The old Revenue by month strip scrolled, and its one bar with data sat
    // past the right edge. The chart that replaced it (2026-10-18) fits its
    // card, so the newest bucket is always in view.
    const chart = page.getByTestId('pnl-chart');
    await expect(chart).toBeVisible({ timeout: 10000 });
    expect(await chart.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });

  test('TC-ANA-06: columns have height, not just labels', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/analytics`);
    await expect(page.getByTestId('pnl-chart').locator('[data-bar]').first()).toBeAttached({ timeout: 10000 });

    // A percentage height inside an auto-height column collapses to nothing,
    // which once drew a chart as a row of labels with no bars at all.
    const tallest = await page
      .getByTestId('pnl-chart')
      .locator('[data-bar]')
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
