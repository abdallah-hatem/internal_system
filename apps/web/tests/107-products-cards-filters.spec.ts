/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The Products tab's cards follow its filters
 * ═══════════════════════════════════════════════════════════════════════
 *  Owner 2026-10-28: "in products tab above the table we need cards that
 *  responds to filter, so when filter by category, it shows number of products
 *  in that category, and total number of units as well".
 *
 *  The cards read GET /products/summary with the table's own search, category
 *  and status; the server counts the whole filtered set (never the page on
 *  screen). Each test filters to a category nothing else is in, so other
 *  suites' products cannot move its figures.
 *
 *  Written 2026-10-28, NOT RUN (owner: no e2e for now).
 */
import { test, expect, type Page } from '@playwright/test';
import { API, apiCtx, refusedCallers, stockedProduct } from './support/fixtures';
import { login, messages, openView } from './support/ui';

const en = messages('en');
const stamp = Date.now();

const cards = (page: Page) => page.getByRole('main').getByTestId('products-summary').getByTestId('summary-card');

async function cardsSay(page: Page, products: number, units: number) {
  const shown = cards(page);
  await expect(shown).toHaveCount(2, { timeout: 15000 });
  await expect(shown.nth(0)).toContainText(new Intl.NumberFormat('en-US').format(products));
  await expect(shown.nth(1)).toContainText(new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(units));
}

test.describe('Products cards follow the filters', () => {
  test('TC-PCARDS-01: a category of 12 products over two pages — the cards count all 12 and their units, on either page', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const category = await mk('categories', { name: `PCards ${stamp}` });
    // 1 + 2 + … + 12 = 78 units; the first page of 10 alone would be 55.
    for (let i = 1; i <= 12; i++) {
      await stockedProduct(request, headers, mk, `PCards${stamp}-${i}`, i, category.id);
    }

    await login(page);
    await openView(page, 'products');
    await page.goto(page.url().replace(/\?.*$/, '') + `?category=${category.id}`);
    await cardsSay(page, 12, 78);
    await page.getByRole('button', { name: en.pagination.next }).click();
    await expect(page.getByRole('main').getByTestId('product-on-hand')).toHaveCount(2, { timeout: 15000 });
    await cardsSay(page, 12, 78);
  });

  test('TC-PCARDS-02: search and status — the cards follow each, and an empty result says 0', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const category = await mk('categories', { name: `PCards search ${stamp}` });
    await stockedProduct(request, headers, mk, `Helmet${stamp}`, 4, category.id);
    const { product: off } = await stockedProduct(request, headers, mk, `Visor${stamp}`, 6, category.id);
    const res = await request.put(`${API}/products/${off.id}/status`, { headers, data: { status: 'INACTIVE' } });
    expect(res.ok(), await res.text()).toBeTruthy();

    await login(page);
    await openView(page, 'products');
    await page.goto(page.url().replace(/\?.*$/, '') + `?category=${category.id}`);
    // Opens on Active: the inactive visor is not counted.
    await cardsSay(page, 1, 4);
    const pills = page.getByRole('main').getByTestId('status-filter');
    await pills.getByRole('button', { name: en.products.filterAll }).click();
    await cardsSay(page, 2, 10);
    await pills.getByRole('button', { name: en.products.inactive }).click();
    await cardsSay(page, 1, 6);

    await pills.getByRole('button', { name: en.products.filterAll }).click();
    const search = page.getByRole('main').getByRole('textbox', { name: en.products.search });
    await search.fill(`Helmet${stamp}`);
    await cardsSay(page, 1, 4);
    await search.fill(`nothing-${stamp}`);
    await cardsSay(page, 0, 0);
  });

  test('TC-PCARDS-03: the second visit — after another filter, back shows that filter’s own figures, never the last ones', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const a = await mk('categories', { name: `PCards A ${stamp}` });
    const b = await mk('categories', { name: `PCards B ${stamp}` });
    await stockedProduct(request, headers, mk, `PCardsA${stamp}`, 7, a.id);
    await stockedProduct(request, headers, mk, `PCardsB1${stamp}`, 2, b.id);
    await stockedProduct(request, headers, mk, `PCardsB2${stamp}`, 3, b.id);

    await login(page);
    await openView(page, 'products');
    const base = page.url().replace(/\?.*$/, '');
    await page.goto(`${base}?category=${a.id}`);
    await cardsSay(page, 1, 7);
    await page.goto(`${base}?category=${b.id}`);
    await cardsSay(page, 2, 5);
    await page.goBack();
    await cardsSay(page, 1, 7);
  });

  test('TC-PCARDS-04: the summary is refused to anyone but the partners and support', async ({ request }) => {
    for (const { who, headers, code } of await refusedCallers(request, `PCards${stamp}`)) {
      const res = await request.get(`${API}/products/summary`, { headers });
      expect(res.status(), who).toBe(403);
      expect((await res.json()).error?.code, who).toBe(code);
    }
  });
});
