/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Arabic names in the storefront (owner, 2026-10-14)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §3 "Arabic names for categories and products". The store
 *  opens in Arabic for everyone (§13): a product shows its Arabic name and
 *  description when someone entered them, its English ones otherwise — never
 *  a blank card. A search matches either language and the SKU.
 *
 *  The office half is 99-arabic-names.spec.ts.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, apiCtx, stockedProduct, SHOP_OWNER_EMAIL, PASSWORD } from './support/fixtures';

/** Letters only, so no figure in a name can match an assertion (as spec 54). */
const stamp = () =>
  Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
const arStamp = () =>
  Array.from({ length: 5 }, () => 'بتثجحخدذرزسشصضطظعغفقكلمنهوي'[Math.floor(Math.random() * 28)]).join('');

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

/** Two priced, stocked products in a category of their own; one has Arabic names. */
async function catalogue(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const label = `Arabic${stamp()}`;
  const tag = arStamp();
  const category = await mk('categories', { name: `${label} Brakes`, nameAr: `فرامل ${tag}` });
  const priced = async (name: string, extra: Record<string, unknown>) => {
    const { product } = await stockedProduct(request, headers, mk, name, 6, category.id);
    await request.put(`${API}/products/${product.id}`, { headers, data: extra });
    await mk(`products/${product.id}/prices`, { channel: 'B2C', currency: 'EGP', amount: 500 });
    await mk(`products/${product.id}/prices`, { channel: 'B2B', currency: 'EGP', amount: 400 });
    return product as { id: string; sku: string; name: string };
  };
  const pads = await priced(`${label} Pads`, {
    nameAr: `تيل فرامل ${tag}`,
    description: 'Front brake pads for 150cc bikes.',
    descriptionAr: `تيل أمامي لموتوسيكلات ١٥٠ سي سي ${tag}`,
  });
  const chain = await priced(`${label} Chain`, {});
  return { label, tag, category, pads, chain };
}

const card = (page: Page, sku: string) => page.locator(`[data-sku="${sku}"]`);

test.describe('Arabic names — the storefront', () => {
  test('TC-SAR-01: on /ar a card shows the Arabic name and category; a product with none shows its English name; /en shows English', async ({ page, request }) => {
    const { label, tag, pads, chain } = await catalogue(request);

    await page.goto('/ar');
    await page.getByPlaceholder('ابحث بالاسم أو SKU أو الباركود').fill(label);
    await expect(card(page, pads.sku)).toContainText(`تيل فرامل ${tag}`);
    await expect(card(page, pads.sku)).toContainText(`فرامل ${tag}`);
    await expect(card(page, pads.sku)).not.toContainText(pads.name);
    // No Arabic name: the English, never a blank card.
    await expect(card(page, chain.sku).locator('h3')).toHaveText(chain.name);

    await page.goto('/en');
    await page.getByPlaceholder('Search by name, SKU or barcode').fill(label);
    await expect(card(page, pads.sku).locator('h3')).toHaveText(pads.name);
    await expect(card(page, pads.sku)).toContainText(`${label} Brakes`);
  });

  test('TC-SAR-02: searching "تيل" finds the brake pads and not the chain; the category filter finds the Arabic name too', async ({ page, request }) => {
    const { tag, pads, chain, category } = await catalogue(request);

    await page.goto('/ar');
    await page.getByPlaceholder('ابحث بالاسم أو SKU أو الباركود').fill(`تيل فرامل ${tag}`);
    await expect(card(page, pads.sku)).toBeVisible();
    await expect(card(page, chain.sku)).toHaveCount(0);
    await expect(page.locator('[data-sku]')).toHaveCount(1);

    // The category filter: on /en, typing the Arabic name still finds it.
    await page.goto('/en');
    await page.getByRole('combobox').filter({ visible: true }).first().click();
    // On a touch screen the box is read-only until tapped (owner 2026-10-26), so tap it first, as a person does.
    const find = page.getByPlaceholder('Find a category by name');
    await find.tap();
    await find.fill(`فرامل ${tag}`);
    await expect(page.getByRole('option', { name: category.name })).toBeVisible();

    const res = await (await request.get(`${API}/portal/catalogue?search=${encodeURIComponent(`تيل فرامل ${tag}`)}`)).json();
    expect(res.data.items.map((p: { sku: string }) => p.sku)).toEqual([pads.sku]);
  });

  test('TC-SAR-03: the product page, the basket and the sent request all show the Arabic name and description', async ({ page, request }) => {
    const { label, tag, pads } = await catalogue(request);

    await page.goto('/ar');
    await tab(page, 'account').click();
    await page.getByRole('link', { name: 'تسجيل الدخول', exact: true }).click();
    await page.getByLabel('البريد الإلكتروني').fill(SHOP_OWNER_EMAIL);
    await page.getByLabel('كلمة المرور', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'تسجيل الدخول', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'المنتجات' })).toBeVisible();

    await page.getByPlaceholder('ابحث بالاسم أو SKU أو الباركود').fill(label);
    await card(page, pads.sku).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`تيل فرامل ${tag}`);
    await expect(page.getByText(`تيل أمامي لموتوسيكلات ١٥٠ سي سي ${tag}`)).toBeVisible();
    await expect(page.getByText('Front brake pads for 150cc bikes.')).toHaveCount(0);
    await page.getByRole('button', { name: /أضف إلى الطلب/ }).click();

    await tab(page, 'requests').click();
    const sheet = page.getByRole('dialog');
    await expect(async () => {
      if (!(await sheet.isVisible())) await page.getByRole('button', { name: /طلبك/ }).click();
      await expect(sheet.getByRole('button', { name: 'إرسال الطلب' })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15000 });
    await expect(sheet).toContainText(`تيل فرامل ${tag}`);
    await sheet.getByRole('button', { name: 'إرسال الطلب' }).click();
    const ref = sheet.locator('.font-mono');
    await expect(ref).toHaveText(/^REQ-\d{4}-\d{4}$/);

    // The request's own page lists the line by its Arabic name.
    const reference = (await ref.textContent())!.trim();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await tab(page, 'requests').click();
    await page.getByRole('link').filter({ hasText: reference }).first().click();
    await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('main')).toContainText(`تيل فرامل ${tag}`);
    await expect(page.getByRole('main')).not.toContainText(pads.name);

    const res = await request.post(`${API}/auth/portal/login`, { data: { email: SHOP_OWNER_EMAIL, password: PASSWORD } });
    const shop = { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
    const mine = (await (await request.get(`${API}/portal/requests`, { headers: shop })).json()).data;
    const list = (Array.isArray(mine) ? mine : mine.items ?? mine.data) as { items: { productId: string; nameAr?: string }[] }[];
    const line = list.flatMap((r) => r.items ?? []).find((i) => i.productId === pads.id);
    expect(line?.nameAr).toBe(`تيل فرامل ${tag}`);
  });
});
