/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Arabic search forgives spelling (owner, 2026-10-15)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §3 "Arabic names", 2026-10-15: أ إ آ count as ا, ة as ه,
 *  ى as ي, and the vowel marks and the tatweel are ignored — in every search
 *  of the office and the storefront. Spelling only: a different letter is a
 *  different word.
 *
 *  Reached by clicking (CLAUDE.md §2): login, the menu, the search box or the
 *  picker, as a partner would. The storefront half is
 *  99-arabic-search-storefront.spec.ts. The rule itself is pinned in unit
 *  tests in all three apps over apps/api/src/common/arabic-search-cases.json;
 *  TC-ARS-06 below runs that same table through Postgres.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { API, apiCtx, stockedProduct } from './support/fixtures';
import { psqlQuery } from './support/database';
import { login, openNav, messages } from './support/ui';
import cases from '../../api/src/common/arabic-search-cases.json';

/** Letters only, so no figure in a name can match an assertion. */
const stamp = () =>
  Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
/**
 * Arabic letters none of the rules touch (no ة ى أ إ آ ؤ ئ), so the tag reads
 * the same folded or not and only the word in front of it is under test.
 */
const arStamp = () =>
  Array.from({ length: 5 }, () => 'بتثجحخدذرزسشصضطظعغفقكلمن'[Math.floor(Math.random() * 25)]).join('');

const m = messages('en');

async function openProducts(page: Page) {
  await openNav(page, m.nav.products);
  await expect(page.getByRole('main').getByRole('heading', { name: m.products.title, level: 1 })).toBeVisible();
}

const searchProducts = (page: Page, term: string) =>
  page.getByRole('main').getByPlaceholder(m.products.search).fill(term);

/** The names on the visible product rows. */
const rowNames = (page: Page) =>
  page.getByRole('main').locator('table tbody tr td:nth-child(2)').filter({ visible: true });

/** One SQL string literal: Postgres doubles a quote inside one. */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

test.describe('Arabic search — the office', () => {
  test('TC-ARS-01: the Products search finds "خوذة هوندى" typed as "خوذه هوندي", and "إطار" as "اطار"; a different letter finds nothing', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const tag = arStamp();
    const helmet = await mk('products', { name: `Helmet ${stamp()}`, nameAr: `خوذة هوندى ${tag}`, minStock: 0 });
    const tyre = await mk('products', { name: `Tyre ${stamp()}`, nameAr: `إطار أمامي ${tag}`, minStock: 0 });

    await login(page);
    await openProducts(page);

    await searchProducts(page, `خوذه هوندي ${tag}`);
    await expect(rowNames(page)).toHaveText([helmet.name]);
    await searchProducts(page, `اطار امامى ${tag}`);
    await expect(rowNames(page)).toHaveText([tyre.name]);
    // Harakat and the tatweel typed into the search are ignored too.
    await searchProducts(page, `خُوذَة هـونـدي ${tag}`);
    await expect(rowNames(page)).toHaveText([helmet.name]);

    // Not a typo search: ح is not ه, ت is not ة.
    await searchProducts(page, `حوذه هوندي ${tag}`);
    await expect(rowNames(page)).toHaveCount(0);
    await searchProducts(page, `خوذت ${tag}`);
    await expect(rowNames(page)).toHaveCount(0);
  });

  test('TC-ARS-02: a sale line\'s product picker finds "إطار أمامى" typed as "اطار امامي"; another word does not', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const label = `Tyre ${stamp()}`;
    const tag = arStamp();
    const { product: tyre } = await stockedProduct(request, headers, mk, label, 5);
    await request.put(`${API}/products/${tyre.id}`, { headers, data: { nameAr: `إطار أمامى ${tag}` } });
    // A second tyre, so the negative search below has something it should
    // find — and the picker is long enough to offer a search box at all.
    const { product: rear } = await stockedProduct(request, headers, mk, `Rear ${stamp()}`, 5);
    await request.put(`${API}/products/${rear.id}`, { headers, data: { nameAr: `إطار خلفى ${tag}` } });
    await mk('products', { name: `Spacer ${stamp()}`, minStock: 0 });

    await login(page);
    await openNav(page, m.nav.sales);
    await page.getByRole('button', { name: m.sales.create }).first().click();
    const form = page.getByTestId('sale-order-form');
    await expect(form).toBeVisible();
    await form.getByTestId('sale-line').first().getByRole('combobox').first().click();
    const search = page.locator('[cmdk-input]').filter({ visible: true });

    await search.fill(`اطار امامي ${tag}`);
    await expect(page.getByRole('option', { name: new RegExp(tyre.name) })).toBeVisible();
    await search.fill(`إطَار أمـامي ${tag}`);
    await expect(page.getByRole('option', { name: new RegExp(tyre.name) })).toBeVisible();
    await expect(page.getByRole('option', { name: new RegExp(rear.name) })).toHaveCount(0);

    // Another word: the rear tyre, not the front one.
    await search.fill(`اطار خلفي ${tag}`);
    await expect(page.getByRole('option', { name: new RegExp(rear.name) })).toBeVisible();
    await expect(page.getByRole('option', { name: new RegExp(tyre.name) })).toHaveCount(0);
  });

  test('TC-ARS-03: the Categories search finds "تَيْل فـرامل" typed plainly, and "خوذة" as "خوذه"; a different letter finds nothing', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const tag = arStamp();
    const pads = await mk('categories', { name: `Pads ${stamp()}`, nameAr: `تَيْل فـرامل ${tag}` });
    const helmets = await mk('categories', { name: `Helmets ${stamp()}`, nameAr: `خوذة ${tag}` });

    await login(page);
    await openNav(page, m.nav.categories);
    const main = page.getByRole('main');
    const box = main.getByPlaceholder(m.categories.search);

    await box.fill(`تيل فرامل ${tag}`);
    await expect(main.getByText(pads.name, { exact: true })).toBeVisible();
    await expect(main.getByText(helmets.name, { exact: true })).toHaveCount(0);

    await box.fill(`خوذه ${tag}`);
    await expect(main.getByText(helmets.name, { exact: true })).toBeVisible();
    await expect(main.getByText(pads.name, { exact: true })).toHaveCount(0);

    await box.fill(`تيل فرامح ${tag}`);
    await expect(main.getByText(pads.name, { exact: true })).toHaveCount(0);
  });

  test('TC-ARS-04: the API search follows the name — edited, the old spelling stops finding it and the new one starts; cleared, nothing Arabic finds it', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const tag = arStamp();
    const product = await mk('products', { name: `Mirror ${stamp()}`, nameAr: `مِرْآة ${tag}`, minStock: 0 });
    const found = async (search: string) =>
      ((await (await request.get(`${API}/products?search=${encodeURIComponent(search)}&limit=100`, { headers })).json())
        .data as any[]).map((p) => p.id);

    expect(await found(`مراه ${tag}`)).toEqual([product.id]);
    expect(await found(`مرأة ${tag}`)).toEqual([product.id]);

    // The second visit: edit the Arabic name.
    await request.put(`${API}/products/${product.id}`, { headers, data: { nameAr: `هوندى ${tag}` } });
    expect(await found(`مراه ${tag}`)).toEqual([]);
    expect(await found(`هوندي ${tag}`)).toEqual([product.id]);
    // An edit that does not send the Arabic name leaves it — and its search — alone.
    await request.put(`${API}/products/${product.id}`, { headers, data: { minStock: 2 } });
    expect(await found(`هوندي ${tag}`)).toEqual([product.id]);

    // Cleared: nothing Arabic finds it.
    await request.put(`${API}/products/${product.id}`, { headers, data: { nameAr: '' } });
    expect(await found(`هوندي ${tag}`)).toEqual([]);
  });

  test('TC-ARS-05: the search key is bookkeeping — no product response carries it', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const tag = arStamp();
    const made = await mk('products', { name: `Visor ${stamp()}`, nameAr: `خوذة ${tag}`, minStock: 0 });
    expect(made).not.toHaveProperty('nameArSearch');

    const one = (await (await request.get(`${API}/products/${made.id}`, { headers })).json()).data;
    const list = (await (await request.get(`${API}/products?search=${encodeURIComponent(`خوذه ${tag}`)}`, { headers })).json()).data;
    const updated = (await (await request.put(`${API}/products/${made.id}`, { headers, data: { nameAr: `خوذه ${tag}` } })).json()).data;
    const store = (await (await request.get(`${API}/portal/catalogue?search=${encodeURIComponent(`خوذه ${tag}`)}`)).json()).data;

    expect(one.nameAr).toBe(`خوذة ${tag}`);
    expect(one).not.toHaveProperty('nameArSearch');
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('nameArSearch');
    expect(updated).not.toHaveProperty('nameArSearch');
    for (const item of store.items) expect(item).not.toHaveProperty('nameArSearch');
    expect(JSON.stringify([made, one, list, updated, store])).not.toContain('name_ar_search');
  });

  test('TC-ARS-06: Postgres and the API fold alike — the shared table through arabic_search_key(), keys written by the API match it, and the migration\'s backfill gives the same key', () => {
    // 1. The SQL function over the same table the three apps' unit tests use.
    for (const [text, key] of cases.keys as [string, string][]) {
      expect(psqlQuery(`SELECT '[' || arabic_search_key(${lit(text)}) || ']';`), JSON.stringify(text)).toBe(`[${key}]`);
    }
    for (const [a, b] of cases.same as [string, string][]) {
      expect(psqlQuery(`SELECT arabic_search_key(${lit(a)}) = arabic_search_key(${lit(b)});`), `${a} ~ ${b}`).toBe('t');
    }
    for (const [a, b] of cases.different as [string, string][]) {
      expect(psqlQuery(`SELECT arabic_search_key(${lit(a)}) = arabic_search_key(${lit(b)});`), `${a} ≁ ${b}`).toBe('f');
    }
  });

  test('TC-ARS-07: a product written before the column existed is found after the backfill, with the key the API would have written', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const tag = arStamp();
    const names = (cases.keys as [string, string][]).map(([text]) => text).filter((t) => /[؀-ۿ]/.test(t));
    const made: any[] = [];
    for (const nameAr of names) {
      made.push(await mk('products', { name: `Backfill ${stamp()}`, nameAr: `${nameAr} ${tag}`, minStock: 0 }));
    }
    const ids = made.map((p) => lit(p.id)).join(',');
    const keys = () =>
      psqlQuery(`SELECT coalesce(name_ar_search, 'NULL') FROM products WHERE id IN (${ids}) ORDER BY name;`);

    // What the API wrote is what Postgres would write: check-data's own query.
    const written = keys();
    expect(
      psqlQuery(`SELECT count(*) FROM products WHERE id IN (${ids})
                   AND name_ar_search IS DISTINCT FROM NULLIF(arabic_search_key(name_ar), '');`),
    ).toBe('0');

    // As it stood before the migration: the name, and no key — search misses it.
    psqlQuery(`UPDATE products SET name_ar_search = NULL WHERE id IN (${ids});`);
    const before = await (await request.get(`${API}/products?search=${encodeURIComponent(`خوذه ${tag}`)}`, { headers })).json();
    expect(before.data).toHaveLength(0);

    // The migration's own backfill statement, read from the migration file.
    const migration = readFileSync(
      resolve(__dirname, '../../api/prisma/migrations/20261015100000_arabic_search_key/migration.sql'),
      'utf8',
    );
    const backfill = migration.match(/UPDATE "products"[\s\S]*?;/)?.[0];
    expect(backfill, 'the migration backfills existing rows').toBeTruthy();
    psqlQuery(backfill!);

    expect(keys()).toBe(written);
    const after = await (await request.get(`${API}/products?search=${encodeURIComponent(`خوذه ${tag}`)}`, { headers })).json();
    expect(after.data.map((p: any) => p.nameAr)).toEqual([`خوذة ${tag}`]);
  });
});
