/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: A dashboard you can act from (UX #8)
 * ═══════════════════════════════════════════════════════════════════════
 *  The tiles were dead figures: seeing 3 low-stock alerts meant opening
 *  Inventory and hunting for them. Each tile now opens its list, filtered the
 *  way the tile is labelled, and three quick actions open the existing create
 *  forms on arrival (`?new=1`) — the forms are not copied onto the dashboard.
 *
 *  Everything is reached by clicking: a page.goto() between steps is a full
 *  load, which would wipe the client cache and the soft navigation the
 *  `?new=1` handling lives on.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { apiCtx, giveStock, owedOrder, stockedProduct, EMAIL, PASSWORD, API } from './support/fixtures';
import { WEB as BASE } from './support/env';

const PHONE = { width: 390, height: 844 };

async function login(page: Page, email = EMAIL, password = PASSWORD) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(email);
  await page.getByPlaceholder('StrongPassword@123').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

const tile = (page: Page, key: string) => page.getByTestId(`tile-${key}`);

/** A product under its minimum: minimum 50, five on hand. */
async function lowProduct(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const product = await mk('products', { name: `${label} Low Part`, minStock: 50 });
  await giveStock(request, headers, mk, product.id, label, 5);
  return product;
}

test.describe('Dashboard tiles open their lists', () => {
  test('TC-DASH-01: Low stock opens inventory showing only products under their minimum', async ({
    page,
    request,
  }) => {
    const stamp = Date.now();
    const low = await lowProduct(request, `Dash ${stamp}`);
    // Plenty on hand and no meaningful minimum: must not be listed.
    const { headers, mk } = await apiCtx(request);
    const { product: fine } = await stockedProduct(request, headers, mk, `Dash Fine ${stamp}`, 100);

    await login(page);
    await tile(page, 'lowStockAlerts').click();
    await expect(page).toHaveURL(/\/en\/inventory\?stock=low/);
    await expect(page.getByTestId('low-stock-chip')).toBeVisible();

    await page.getByPlaceholder(/search/i).fill(`${stamp}`);
    await expect(page.getByText(low.name).first()).toBeVisible();
    await expect(page.getByText(fine.name)).toHaveCount(0);

    // "Show all" brings the rest back without leaving the page.
    await page.getByRole('button', { name: 'Show all' }).click();
    await expect(page).toHaveURL(/\/en\/inventory$/);
    await expect(page.getByText(fine.name).first()).toBeVisible();
  });

  test('TC-DASH-02: Receivables opens customers with the largest balance first', async ({
    page,
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const stamp = Date.now();
    const { product } = await stockedProduct(request, headers, mk, `Dash Recv ${stamp}`, 20);
    const small = await mk('customers', { displayName: `Dash Small ${stamp}`, type: 'B2B' });
    const big = await mk('customers', { displayName: `Dash Big ${stamp}`, type: 'B2B' });
    await owedOrder(mk, small.id, product.id, 100);
    await owedOrder(mk, big.id, product.id, 900);

    await login(page);
    await tile(page, 'receivables').click();
    await expect(page).toHaveURL(/\/en\/customers\?sort=balance/);
    await expect(page.getByTestId('balance-sort-chip')).toBeVisible();

    // Narrowed to this test's two shops: the bigger debt is above the smaller.
    await page.getByPlaceholder(/search/i).fill(`${stamp}`);
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(big.displayName);
    await expect(rows.nth(1)).toContainText(small.displayName);
  });

  for (const [key, path] of [
    ['revenue', '/en/sales'],
    ['collected', '/en/payments'],
    ['expenses', '/en/ledger'],
    ['activeCycles', '/en/cycles'],
    ['inventoryValue', '/en/inventory'],
    ['netProfit', '/en/analytics'],
  ] as const) {
    test(`TC-DASH-03 ${key}: the tile opens ${path}`, async ({ page }) => {
      await login(page);
      await tile(page, key).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    });
  }

  test('TC-DASH-04: on a phone the tiles sit two to a row, each a full tap target', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page);
    const a = await tile(page, 'revenue').boundingBox();
    const b = await tile(page, 'collected').boundingBox();
    expect(a && b).toBeTruthy();
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(2); // same row
    expect(a!.height).toBeGreaterThanOrEqual(44);
    expect(page.viewportSize()!.width).toBeGreaterThanOrEqual(
      await page.evaluate(() => document.documentElement.scrollWidth),
    );
  });
});

test.describe('Quick actions open the existing forms', () => {
  test('TC-DASH-05: New sale opens the sale form on the sales page', async ({ page }) => {
    await login(page);
    await page.getByTestId('quick-action-newSale').click();
    await expect(page.getByRole('heading', { name: 'New Order', exact: true })).toBeVisible();
    // The parameter is used once: the URL no longer carries it.
    await expect(page).toHaveURL(/\/en\/sales$/);
  });

  test('TC-DASH-06: closing the form and reloading does not reopen it', async ({ page }) => {
    await login(page);
    await page.getByTestId('quick-action-newSale').click();
    const heading = page.getByRole('heading', { name: 'New Order', exact: true });
    await expect(heading).toBeVisible();
    // Exact: the status filter's "Cancelled" chip also matches "Cancel" and
    // sits first in the DOM, under the modal (the form is portalled after it).
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    // The page drops ?new=1 with a router.replace after it opens the form.
    // Reloading before that lands reloads ?new=1 itself, and the form opens
    // again — which a test can do within milliseconds and a person cannot
    // (flaked once in a full group-4 run, I1, 2026-10-11).
    await expect(page).toHaveURL(/\/en\/sales$/);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sales Orders' })).toBeVisible();
    await expect(heading).toHaveCount(0);
  });

  test('TC-DASH-07: the second time — back to the dashboard and New sale again opens it again', async ({
    page,
  }) => {
    await login(page);
    await page.getByTestId('quick-action-newSale').click();
    await expect(page.getByRole('heading', { name: 'New Order', exact: true })).toBeVisible();
    // Exact: the status filter's "Cancelled" chip also matches "Cancel" and
    // sits first in the DOM, under the modal (the form is portalled after it).
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('link', { name: 'Dashboard', exact: true }).first().click();
    await page.getByTestId('quick-action-newSale').click();
    await expect(page.getByRole('heading', { name: 'New Order', exact: true })).toBeVisible();
  });

  test('TC-DASH-08: Record payment opens the payment form', async ({ page }) => {
    await login(page);
    await page.getByTestId('quick-action-recordPayment').click();
    await expect(page.getByRole('heading', { name: 'Record Payment', level: 2 })).toBeVisible();
    await expect(page).toHaveURL(/\/en\/payments$/);
  });

  test('TC-DASH-09: New cycle opens the cycle wizard', async ({ page }) => {
    await login(page);
    await page.getByTestId('quick-action-newCycle').click();
    await expect(page).toHaveURL(/\/en\/cycles\/new$/);
  });
});

test.describe('Roles', () => {
  test('TC-DASH-10: a temporary investor sees no quick actions and no activity panel', async ({
    page,
    request,
  }) => {
    const { headers } = await apiCtx(request);
    const stamp = Date.now();
    const email = `dash-investor-${stamp}@motoparts.com`;
    const made = await request.post(`${API}/auth/register`, {
      headers,
      data: { email, password: 'password123', displayName: `Dash Investor ${stamp}`, role: 'TEMP_INVESTOR' },
    });
    expect(made.ok(), await made.text()).toBeTruthy();

    await login(page, email, 'password123');
    // R1 (owner's decision 2026-10-10): an investor sees only their own cycles,
    // so the business-wide tiles are replaced by "Your cycles" — no tile at all.
    await expect(page.getByTestId('your-cycles')).toBeVisible();
    await expect(page.locator('[data-testid^="tile-"]')).toHaveCount(0);
    await expect(page.getByTestId('quick-action-newSale')).toHaveCount(0);
    await expect(page.getByTestId('quick-action-recordPayment')).toHaveCount(0);
    await expect(page.getByTestId('quick-action-newCycle')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Recent activity' })).toHaveCount(0);
    // A list the API refuses them is not a link.
    await expect(page.locator('a[data-testid="tile-revenue"]')).toHaveCount(0);
  });
});
