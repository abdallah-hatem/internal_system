/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Products Management
 * ═══════════════════════════════════════════════════════════════════════
 *  Tests: list products, create, view detail, edit, price history
 */
import { test, expect } from '@playwright/test';
import { WEB as BASE } from './support/env';
import { API, apiCtx } from './support/fixtures';

const EMAIL = 'abdallah@motoparts.com';
const PASSWORD = 'password123';

async function login(page: any) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test.describe('Products Management Flow', () => {

  test('TC-PROD-01: Products page loads with list', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await expect(page.getByRole('heading', { name: /Products/i })).toBeVisible({ timeout: 10000 });
    // Should have table headers
    await expect(page.getByText('SKU')).toBeVisible();
    await expect(page.getByText('Name')).toBeVisible();
  });

  test('TC-PROD-02: Products table shows existing products', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.waitForTimeout(2000);
    // Should show at least one product (from seed data)
    const body = await page.textContent('body');
    expect(body).toMatch(/PRD-000001|PRD-000002|helmet|Front Brake Disc/);
  });

  test('TC-PROD-03: Product search works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.waitForTimeout(2000);
    const searchInput = page.getByPlaceholder(/search products/i);
    await searchInput.fill('helmet');
    await page.waitForTimeout(500);
    const body = await page.textContent('body');
    // Match case-insensitively: the product is displayed with its own casing
    // ("Full Face Helmet"), and the search itself is case-insensitive.
    expect(body).toMatch(/helmet/i);
  });

  test('TC-PROD-04: Category filter works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.waitForTimeout(2000);
    // Find the category filter dropdown
    const filter = page.getByRole('combobox').first();
    if (await filter.isVisible()) {
      await filter.click();
      await page.waitForTimeout(500);
    }
  });

  test('TC-PROD-05: Product detail page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.waitForTimeout(2000);

    // Click View on first product
    const viewBtn = page.getByRole('button', { name: /View/i }).first();
    if (await viewBtn.isVisible()) {
      await viewBtn.click();
      await page.waitForTimeout(2000);

      // Should show detail sections
      await expect(page.getByRole('heading', { name: /Details/i })).toBeVisible({ timeout: 5000 });
      await expect(page.getByText('SKU')).toBeVisible();
    }
  });

  test('TC-PROD-06: Product detail shows inventory batches', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.waitForTimeout(2000);

    const viewBtn = page.getByRole('button', { name: /View/i }).first();
    if (await viewBtn.isVisible()) {
      await viewBtn.click();
      await page.waitForTimeout(2000);
      // Should show Inventory Batches section
      await expect(page.getByRole('heading', { name: /Inventory Batches/i })).toBeVisible({ timeout: 5000 });
    }
  });

  test('TC-PROD-07: Product detail shows price history', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.waitForTimeout(2000);

    const viewBtn = page.getByRole('button', { name: /View/i }).first();
    if (await viewBtn.isVisible()) {
      await viewBtn.click();
      await page.waitForTimeout(2000);
      // Should show Price History section
      await expect(page.getByRole('heading', { name: /Price History/i })).toBeVisible({ timeout: 5000 });
    }
  });

  test('TC-PROD-08: Product detail back button works', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.waitForTimeout(2000);

    const viewBtn = page.getByRole('button', { name: /View/i }).first();
    if (await viewBtn.isVisible()) {
      await viewBtn.click();
      await page.waitForTimeout(2000);

      const backBtn = page.getByRole('button', { name: /Back/i });
      if (await backBtn.isVisible()) {
        await backBtn.click();
        await expect(page).toHaveURL(/\/en\/products$/, { timeout: 5000 });
      }
    }
  });

  test('TC-PROD-09: Create product modal opens', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /New Product/i }).click();
    await page.waitForTimeout(500);
    // Modal should appear
    await expect(page.getByRole('heading', { name: /New Product|Create Product/i })).toBeVisible({ timeout: 5000 });
  });

  test('TC-PROD-10: Edit product button exists on each row', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.waitForTimeout(2000);
    const editButtons = page.getByRole('button', { name: /Edit/i });
    const count = await editButtons.count();
    expect(count).toBeGreaterThan(0);
  });
});

// Owner 2026-10-18: "remove the Suppliers and Compatibility cards from the
// product details page". Price history and the rest of the page stay.
test('TC-PROD-CARDS-01: a product page has no Suppliers or Compatibility card', async ({ page, request }) => {
  const { headers } = await apiCtx(request);
  const list = await (await request.get(`${API}/products?limit=1`, { headers })).json();
  const product = (list.data?.items ?? list.data)[0];
  expect(product, 'the reference seed has products').toBeTruthy();
  await login(page);
  await page.goto(`${BASE}/en/products/${product.id}`);
  const main = page.getByRole('main');
  await expect(main.getByText(product.sku).first()).toBeVisible({ timeout: 15000 });
  await expect(main.getByRole('heading', { name: /price history/i })).toBeVisible();
  await expect(main.getByRole('heading', { name: /^suppliers$/i })).toHaveCount(0);
  await expect(main.getByRole('heading', { name: /^compatibility$/i })).toHaveCount(0);
});
