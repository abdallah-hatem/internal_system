/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: a switched-off product in the storefront (owner, 2026-10-14)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §3 and §12. A switched-off product is still sold from what
 *  is on the shelf — only buying more stops. So a shop still finds it, and can
 *  still ask for it, while stock remains; once the shelf is empty it leaves the
 *  catalogue and its page is gone. (An active product with nothing on the
 *  shelf stays listed as out of stock, as before — it will be bought again.)
 *
 *  Runs in the storefront project (the file name ends `storefront.spec.ts`).
 *  The office half is 99-product-deactivate.spec.ts.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, apiCtx, stockedProduct, SHOP_OWNER_EMAIL, PASSWORD } from './support/fixtures';

/** Letters only, so no figure in a name can match an assertion (as spec 54). */
const stamp = () =>
  Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');

const tab = (page: Page, key: 'catalogue' | 'requests' | 'imports' | 'account') => page.locator(`[data-tab="${key}"]`);

test.beforeEach(async ({ page }) => {
  // The dev overlay sits over the bottom bar on a phone (spec 54).
  await page.addInitScript(() => {
    const hide = () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal { display: none !important }';
      document.head.appendChild(style);
    };
    if (document.head) hide();
    else document.addEventListener('DOMContentLoaded', hide);
  });
});

/** A priced product; with `qty` > 0 that many are genuinely received. */
async function aProduct(request: APIRequestContext, label: string, qty: number) {
  const { headers, mk } = await apiCtx(request);
  const product =
    qty > 0
      ? (await stockedProduct(request, headers, mk, label, qty)).product
      : await mk('products', { name: `${label} Part`, minStock: 0 });
  await mk(`products/${product.id}/prices`, { channel: 'B2C', currency: 'EGP', amount: 500 });
  await mk(`products/${product.id}/prices`, { channel: 'B2B', currency: 'EGP', amount: 400 });
  return { headers, id: product.id as string, sku: product.sku as string, name: product.name as string };
}

async function switchOff(request: APIRequestContext, headers: Record<string, string>, id: string) {
  const res = await request.put(`${API}/products/${id}/status`, { headers, data: { status: 'INACTIVE' } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test.describe('A switched-off product in the storefront', () => {
  test('TC-SDEACT-01: listed while it has stock, gone once it has none — and an active product with none is still listed', async ({ page, request }) => {
    const label = `Dormant${stamp()}`;
    const offWithStock = await aProduct(request, `${label} Shelf`, 4);
    const offEmpty = await aProduct(request, `${label} Empty`, 0);
    const onEmpty = await aProduct(request, `${label} Fresh`, 0);
    await switchOff(request, offWithStock.headers, offWithStock.id);
    await switchOff(request, offEmpty.headers, offEmpty.id);

    await page.goto('/en');
    await page.getByPlaceholder('Search by name, SKU or barcode').fill(label);
    await expect(page.locator(`[data-sku="${offWithStock.sku}"]`)).toBeVisible();
    await expect(page.locator(`[data-sku="${onEmpty.sku}"]`)).toBeVisible();
    await expect(page.locator(`[data-sku="${offEmpty.sku}"]`)).toHaveCount(0);
    await expect(page.locator('[data-sku]')).toHaveCount(2);

    // The catalogue's own answer, which every screen of the store reads.
    const listed = await (await request.get(`${API}/portal/catalogue?search=${encodeURIComponent(label)}`)).json();
    expect(listed.data.items.map((p: { sku: string }) => p.sku).sort()).toEqual([offWithStock.sku, onEmpty.sku].sort());
    expect((await request.get(`${API}/portal/catalogue/${encodeURIComponent(offEmpty.sku)}`)).status()).toBe(404);
    expect((await request.get(`${API}/portal/catalogue/${encodeURIComponent(offWithStock.sku)}`)).ok()).toBeTruthy();
  });

  test('TC-SDEACT-02: a basket holding it when it was switched off still sends, while the stock is there', async ({ page, request }) => {
    const label = `Withdrawn${stamp()}`;
    const mine = await aProduct(request, label, 5);

    await page.goto('/ar');
    await tab(page, 'account').click();
    await page.getByRole('link', { name: 'تسجيل الدخول', exact: true }).click();
    await page.getByLabel('البريد الإلكتروني').fill(SHOP_OWNER_EMAIL);
    await page.getByLabel('كلمة المرور', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'تسجيل الدخول', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'المنتجات' })).toBeVisible();

    await page.getByPlaceholder('ابحث بالاسم أو SKU أو الباركود').fill(label);
    await page.locator(`[data-sku="${mine.sku}"]`).click();
    await page.getByRole('button', { name: /أضف إلى الطلب/ }).click();

    // The partner switches it off while it sits in the basket.
    await switchOff(request, mine.headers, mine.id);

    await tab(page, 'requests').click();
    const sheet = page.getByRole('dialog');
    // The notifications banner can slide in on the first visit and move the
    // launcher as it is clicked; open the sheet until it is open.
    await expect(async () => {
      if (!(await sheet.isVisible())) await page.getByRole('button', { name: /طلبك/ }).click();
      await expect(sheet.getByRole('button', { name: 'إرسال الطلب' })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15000 });
    await sheet.getByRole('button', { name: 'إرسال الطلب' }).click();

    await expect(sheet.locator('.font-mono')).toHaveText(/^REQ-\d{4}-\d{4}$/);
    await expect(sheet.locator('p[role="alert"]')).toHaveCount(0);
  });
});
