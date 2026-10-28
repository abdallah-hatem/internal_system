/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Arabic search forgives spelling — the storefront (2026-10-15)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §3: أ إ آ count as ا, ة as ه, ى as ي; vowel marks and the
 *  tatweel are ignored. A shop types "خوذه" on its phone and finds the
 *  "خوذة"; it types a different word and finds nothing.
 *
 *  The office half is 99-arabic-search.spec.ts.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, apiCtx, stockedProduct } from './support/fixtures';

const stamp = () =>
  Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
/** Letters none of the rules touch, so only the word in front is under test. */
const arStamp = () =>
  Array.from({ length: 5 }, () => 'بتثجحخدذرزسشصضطظعغفقكلمن'[Math.floor(Math.random() * 25)]).join('');

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

/** A priced, stocked helmet whose Arabic name is spelled with ة, ى and أ, in a category of its own. */
async function helmet(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const label = `Search${stamp()}`;
  const tag = arStamp();
  const category = await mk('categories', { name: `${label} Helmets`, nameAr: `خُوذ ${tag}` });
  const { product } = await stockedProduct(request, headers, mk, `${label} Helmet`, 6, category.id);
  await request.put(`${API}/products/${product.id}`, { headers, data: { nameAr: `خوذة هوندى أصلية ${tag}` } });
  await mk(`products/${product.id}/prices`, { channel: 'B2C', currency: 'EGP', amount: 500 });
  await mk(`products/${product.id}/prices`, { channel: 'B2B', currency: 'EGP', amount: 400 });
  return { label, tag, category, product: product as { id: string; sku: string; name: string } };
}

const card = (page: Page, sku: string) => page.locator(`[data-sku="${sku}"]`);
const searchBox = (page: Page) => page.getByPlaceholder('ابحث بالاسم أو SKU أو الباركود');

test.describe('Arabic search — the storefront', () => {
  test('TC-SARS-01: the catalogue search finds "خوذة هوندى أصلية" typed as "خوذه هوندي اصليه"; a different word shows no card', async ({ page, request }) => {
    const { tag, product } = await helmet(request);

    // The count first: the unfiltered first page may already hold the card,
    // and only a search that has run shows it alone. The search is debounced,
    // so each step waits for a result the previous step could not show.
    const results = page.locator('[data-sku]');
    await page.goto('/ar');
    await searchBox(page).fill(`خوذه هوندي اصليه ${tag}`);
    await expect(results).toHaveCount(1);
    await expect(card(page, product.sku)).toBeVisible();

    // Spelling, not guessing: ح is not ه.
    await searchBox(page).fill(`خوذه حوندي ${tag}`);
    await expect(results).toHaveCount(0);

    // Marks and the tatweel typed by the shop are ignored as well.
    await searchBox(page).fill(`خُوذَة هـونـدى أَصْلـية ${tag}`);
    await expect(results).toHaveCount(1);
    await expect(card(page, product.sku)).toBeVisible();
  });

  test('TC-SARS-02: the category filter finds "خُوذ" typed without its damma; a different letter does not', async ({ page, request }) => {
    const { tag, category } = await helmet(request);
    // One letter apart, and one more besides — which also makes the list long
    // enough for the filter to offer its search box.
    const { mk } = await apiCtx(request);
    const near = await mk('categories', { name: `Near ${stamp()}`, nameAr: `حوذ ${tag}` });
    await mk('categories', { name: `Other ${stamp()}` });
    const option = (nameAr: string) => page.getByRole('option', { name: nameAr, exact: true });

    await page.goto('/ar');
    await page.getByRole('combobox').filter({ visible: true }).first().click();
    const find = page.locator('[cmdk-input]').filter({ visible: true });
    // On a touch screen the box is read-only until tapped (owner 2026-10-26), so tap it first, as a person does.
    await find.tap();
    await find.fill(`خوذ ${tag}`);
    await expect(option(category.nameAr)).toBeVisible();
    await expect(option(near.nameAr)).toHaveCount(0);
    await find.fill(`حوذ ${tag}`);
    await expect(option(near.nameAr)).toBeVisible();
    await expect(option(category.nameAr)).toHaveCount(0);
  });
});
