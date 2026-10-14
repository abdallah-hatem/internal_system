/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Arabic names for categories and products (owner, 2026-10-14)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §3 "Arabic names for categories and products". A category
 *  has an optional Arabic name; a product an optional Arabic name and
 *  description. On /ar the Arabic is shown when present and the English
 *  otherwise — never a blank. A search matches either language and the SKU.
 *
 *  Reached by clicking (CLAUDE.md §2): the login page, the menu, the row. The
 *  storefront half is 99-arabic-names-storefront.spec.ts; the assistant's
 *  matching is pinned in apps/api/src/modules/assistant (unit).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, apiCtx, owedOrder, stockedProduct } from './support/fixtures';
import { login, openNav, messages, type Locale } from './support/ui';

/** Letters only, so no figure in a name can match an assertion. */
const stamp = () =>
  Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
/** Arabic letters, so an Arabic name is unique to its test. */
const arStamp = () =>
  Array.from({ length: 5 }, () => 'بتثجحخدذرزسشصضطظعغفقكلمنهوي'[Math.floor(Math.random() * 28)]).join('');

async function openProducts(page: Page, locale: Locale = 'en') {
  const m = messages(locale);
  await openNav(page, m.nav.products);
  await expect(page.getByRole('main').getByRole('heading', { name: m.products.title, level: 1 })).toBeVisible();
}

async function searchProducts(page: Page, term: string, locale: Locale = 'en') {
  await page.getByRole('main').getByPlaceholder(messages(locale).products.search).fill(term);
}

/** The names on the visible product rows. */
const rowNames = (page: Page) =>
  page.getByRole('main').locator('table tbody tr td:nth-child(2)').filter({ visible: true });

async function productOf(request: APIRequestContext, headers: Record<string, string>, id: string) {
  return (await (await request.get(`${API}/products/${id}`, { headers })).json()).data;
}

async function refusal(res: { status(): number; json(): Promise<any> }) {
  const body = await res.json();
  return { status: res.status(), code: body?.error?.code, params: body?.error?.params };
}

test.describe('Arabic names — the office app', () => {
  test('TC-AR-01: a category made with an Arabic name through the + inside the product form is stored with it and selected', async ({ page, request }) => {
    const { headers } = await apiCtx(request);
    const m = messages('en');
    const label = `Visors ${stamp()}`;
    const arabic = `خوذ ${arStamp()}`;

    await login(page);
    await openProducts(page);
    await page.getByTestId('create-action').click();
    const productForm = page.locator('form:has(input[name="nameAr"])').first();
    await productForm.locator('input[name="name"]').fill(`${label} Part`);

    await page.locator('[data-quick-create="category"]').first().click();
    const dialog = page.locator('[data-quick-create-dialog="category"]');
    await expect(dialog).toBeVisible();
    const arInput = dialog.locator('input[name="nameAr"]');
    // Written right to left whatever the page's language, with a real example.
    await expect(arInput).toHaveAttribute('dir', 'rtl');
    await expect(arInput).toHaveAttribute('placeholder', m.placeholders.categoryNameAr);
    await dialog.locator('input[name="name"]').fill(label);
    await arInput.fill(`  ${arabic} `);
    await dialog.getByRole('button', { name: m.common.create, exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15000 });

    // Selected in the product form underneath, which kept what was typed.
    await expect(productForm.locator('[data-slot="select-value"]').first()).toHaveText(label);
    await expect(productForm.locator('input[name="name"]')).toHaveValue(`${label} Part`);

    const categories = (await (await request.get(`${API}/categories`, { headers })).json()).data as any[];
    const made = categories.find((c) => c.name === label);
    expect(made?.nameAr).toBe(arabic); // trimmed
  });

  test('TC-AR-02: the Arabic name shows on /ar and the English on /en — list, product page and category', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const label = `Pads ${stamp()}`;
    const arName = `تيل فرامل ${arStamp()}`;
    const catAr = `فرامل ${arStamp()}`;
    const category = await mk('categories', { name: `${label} Cat`, nameAr: catAr });
    const product = await mk('products', {
      name: `${label} Part`, nameAr: arName, categoryId: category.id, minStock: 0,
      descriptionAr: 'تيل أمامي لموتوسيكلات ١٥٠ سي سي',
    });

    for (const locale of ['ar', 'en'] as const) {
      await login(page, locale);
      await openProducts(page, locale);
      await searchProducts(page, label, locale);
      const shown = locale === 'ar' ? arName : product.name;
      await expect(rowNames(page)).toHaveText([shown]);
      await expect(page.getByRole('main').locator('table tbody tr').filter({ visible: true }).first())
        .toContainText(locale === 'ar' ? catAr : category.name);

      await page.getByRole('main').getByRole('link', { name: shown }).filter({ visible: true }).first().click();
      await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
      await expect(page.getByTestId('product-title')).toHaveText(shown);
      // Both names as stored, whichever the title shows.
      await expect(page.getByRole('main')).toContainText(arName);
      await expect(page.getByRole('main')).toContainText(product.name);
    }
    expect((await productOf(request, headers, product.id)).nameAr).toBe(arName);
  });

  test('TC-AR-03: a product with no Arabic name shows its English name on /ar — never a blank', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const label = `Chain ${stamp()}`;
    const product = await mk('products', { name: `${label} Part`, minStock: 0 });

    await login(page, 'ar');
    await openProducts(page, 'ar');
    await searchProducts(page, label, 'ar');
    await expect(rowNames(page)).toHaveText([product.name]);
    await page.getByRole('main').getByRole('link', { name: product.name }).filter({ visible: true }).first().click();
    await expect(page.getByTestId('product-title')).toHaveText(product.name);
  });

  test('TC-AR-04: searching "تيل" finds the brake pads in the products list and in the sale picker; an English-only product does not match', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const label = `Brake ${stamp()}`;
    const tag = arStamp();
    const { product: pads } = await stockedProduct(request, headers, mk, `${label} Pads`, 5);
    await request.put(`${API}/products/${pads.id}`, { headers, data: { nameAr: `تيل ${tag}` } });
    const { product: other } = await stockedProduct(request, headers, mk, `${label} Other`, 5);
    const m = messages('en');

    await login(page);
    await openProducts(page);
    // On /en the row reads in English, and an Arabic search still finds it.
    await searchProducts(page, `تيل ${tag}`);
    await expect(rowNames(page)).toHaveText([pads.name]);
    await searchProducts(page, label);
    await expect(rowNames(page)).toHaveCount(2);

    await openNav(page, m.nav.sales);
    await page.getByRole('button', { name: m.sales.create }).first().click();
    const form = page.getByTestId('sale-order-form');
    await expect(form).toBeVisible();
    await form.getByTestId('sale-line').first().getByRole('combobox').first().click();
    await page.locator('[cmdk-input]').filter({ visible: true }).fill(`تيل ${tag}`);
    await expect(page.getByRole('option', { name: new RegExp(pads.name) })).toBeVisible();
    await expect(page.getByRole('option', { name: new RegExp(other.name) })).toHaveCount(0);
  });

  test('TC-AR-05: editing a product twice keeps its Arabic name and description; emptying the Arabic name clears it', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const label = `Mirror ${stamp()}`;
    const arName = `مرآة ${arStamp()}`;
    const arDesc = 'مرآة جانبية يمين، تناسب هوندا وياماها.';
    const product = await mk('products', { name: `${label} Part`, nameAr: arName, descriptionAr: arDesc, minStock: 0 });

    await login(page);
    await openProducts(page);
    await searchProducts(page, label);

    const editRow = async () => {
      await page.getByRole('main').getByTestId('edit-action').filter({ visible: true }).first().click();
      const form = page.locator('form:has(input[name="nameAr"])');
      await expect(form).toBeVisible();
      return form;
    };
    const save = async (form: ReturnType<typeof page.locator>) => {
      await form.getByRole('button', { name: messages('en').common.save, exact: true }).click();
      await expect(form).toHaveCount(0, { timeout: 15000 });
    };

    // First visit: change something else.
    let form = await editRow();
    await expect(form.locator('input[name="nameAr"]')).toHaveValue(arName);
    await expect(form.locator('textarea[name="descriptionAr"]')).toHaveValue(arDesc);
    await form.locator('input[name="minStock"]').fill('3');
    await save(form);

    // Second visit: the Arabic is still there, and survives another save.
    form = await editRow();
    await expect(form.locator('input[name="nameAr"]')).toHaveValue(arName);
    await expect(form.locator('textarea[name="descriptionAr"]')).toHaveValue(arDesc);
    await form.locator('input[name="name"]').fill(`${label} Part v2`);
    await save(form);
    let stored = await productOf(request, headers, product.id);
    expect(stored).toMatchObject({ name: `${label} Part v2`, nameAr: arName, descriptionAr: arDesc });
    expect(Number(stored.minStock)).toBe(3);

    // Third visit: emptying the Arabic name clears it (stored as null, not "").
    form = await editRow();
    await form.locator('input[name="nameAr"]').fill('');
    await save(form);
    stored = await productOf(request, headers, product.id);
    expect(stored.nameAr).toBeNull();
    expect(stored.descriptionAr).toBe(arDesc);
  });

  test('TC-AR-06: the invoice shows the Arabic product name on /ar and the English on /en', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const label = `Invoice ${stamp()}`;
    const arName = `تيل فرامل ${arStamp()}`;
    const { product } = await stockedProduct(request, headers, mk, label, 10);
    await request.put(`${API}/products/${product.id}`, { headers, data: { nameAr: arName } });
    const shop = await mk('customers', { displayName: `${label} Shop`, type: 'B2B', phone: '+201000000124' });
    await owedOrder(mk, shop.id, product.id, 300);
    const order = await mk('sales/orders', {
      customerId: shop.id, channel: 'B2B', currency: 'EGP', confirm: true,
      items: [{ productId: product.id, quantity: 2, unitPrice: 150, discount: 0 }],
    });

    for (const locale of ['ar', 'en'] as const) {
      const m = messages(locale);
      await login(page, locale);
      await openNav(page, m.nav.sales);
      await page.getByPlaceholder(m.sales.search).fill(order.orderNo);
      await page.getByTestId('sale-row').filter({ hasText: order.orderNo }).locator('td').nth(6).click();
      await expect(page.getByRole('heading', { name: order.orderNo })).toBeVisible();
      await page.getByTestId('order-invoice').click();
      await expect(page).toHaveURL(/\/sales\/[0-9a-f-]{36}\/invoice$/, { timeout: 15000 });
      await expect(page.getByTestId('invoice-line-product')).toHaveText(locale === 'ar' ? arName : product.name);
    }
  });

  test('TC-AR-07: a category\'s Arabic name is unique ignoring case and space; too long is refused; nothing is stored either way', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const label = `Unique ${stamp()}`;
    const arabic = `خوذ ${arStamp()}`;
    const first = await mk('categories', { name: `${label} A`, nameAr: arabic });

    const dup = await request.post(`${API}/categories`, { headers, data: { name: `${label} B`, nameAr: `  ${arabic} ` } });
    expect(await refusal(dup)).toMatchObject({ status: 409, code: 'CATEGORY_NAME_AR_TAKEN', params: { category: `${label} A` } });
    const latin = await mk('categories', { name: `${label} C`, nameAr: `Kawetsh ${stamp()}` });
    const upper = await request.post(`${API}/categories`, { headers, data: { name: `${label} D`, nameAr: latin.nameAr.toUpperCase() } });
    expect((await refusal(upper)).code).toBe('CATEGORY_NAME_AR_TAKEN');

    // Renaming another category to it is refused; saving one's own is not.
    const renamed = await request.put(`${API}/categories/${latin.id}`, { headers, data: { nameAr: arabic } });
    expect((await refusal(renamed)).code).toBe('CATEGORY_NAME_AR_TAKEN');
    const own = await request.put(`${API}/categories/${first.id}`, { headers, data: { nameAr: arabic } });
    expect(own.ok(), await own.text()).toBeTruthy();

    const long = await request.post(`${API}/categories`, { headers, data: { name: `${label} E`, nameAr: 'ب'.repeat(201) } });
    expect(await refusal(long)).toMatchObject({ status: 400, code: 'NAME_AR_TOO_LONG', params: { max: 200 } });
    const longDesc = await request.post(`${API}/products`, { headers, data: { name: `${label} P`, descriptionAr: 'ب'.repeat(1001) } });
    expect(await refusal(longDesc)).toMatchObject({ status: 400, code: 'DESCRIPTION_AR_TOO_LONG' });
    const notText = await request.post(`${API}/products`, { headers, data: { name: `${label} Q`, nameAr: 42 } });
    expect((await refusal(notText)).code).toBe('VALIDATION_FAILED');

    const names = ((await (await request.get(`${API}/categories`, { headers })).json()).data as any[]).map((c) => c.name);
    expect(names.filter((n) => n.startsWith(label)).sort()).toEqual([`${label} A`, `${label} C`]);
    const products = (await (await request.get(`${API}/products?search=${encodeURIComponent(label)}`, { headers })).json()).data;
    expect(products).toHaveLength(0);
  });

  test('TC-AR-08: on /ar, a taken Arabic category name is refused in Arabic in the form, and the form keeps what was typed', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const label = `Taken ${stamp()}`;
    const arabic = `جنازير ${arStamp()}`;
    await mk('categories', { name: `${label} A`, nameAr: arabic });
    const m = messages('ar');

    await login(page, 'ar');
    await openNav(page, m.nav.categories);
    await page.getByTestId('create-action').click();
    const form = page.locator('form:has(input[name="nameAr"])');
    await form.locator('input[name="name"]').fill(`${label} B`);
    await form.locator('input[name="nameAr"]').fill(arabic);
    await form.getByRole('button', { name: m.common.create, exact: true }).click();

    const expected = m.errors.CATEGORY_NAME_AR_TAKEN.replace('{nameAr}', arabic).replace('{category}', `${label} A`);
    await expect(page.getByText(expected)).toBeVisible();
    await expect(form.locator('input[name="nameAr"]')).toHaveValue(arabic);
  });
});
