import { test, expect } from '@playwright/test';

/**
 * The deployed system, in a browser.
 *
 * Everything else in this directory runs against localhost, and three separate
 * failures this week existed *only* in production and could not have been
 * caught by any of it: `@nestjs/schedule` and `uuid` are ESM-only and crash the
 * compiled CommonJS bundle, which local development never builds because it
 * runs through ts-node; and the blob adapter is never the one selected locally,
 * so both of its bugs were invisible until deployed. Each of those reported a
 * healthy build and then 500'd on every request.
 *
 * So this file exists to hit the real URLs. It is deliberately small: it checks
 * that the deployed pieces are connected to each other, not that the features
 * work — the localhost suite already does that, far more cheaply.
 *
 * Not part of the default run. It talks to production, it depends on data that
 * lives there, and it costs a network round trip per assertion:
 *
 *   npx playwright test --project=production
 */

const STORE = 'https://internal-system-store.vercel.app';
const OFFICE = 'https://internal-system-web-three.vercel.app';
const API = 'https://internal-system-api.vercel.app/api/v1';

const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

/** A translation key that reached the screen, e.g. "errors.SOME_CODE". */
async function untranslatedKeys(page: any): Promise<string[]> {
  return page.evaluate(() => {
    const text = document.body.innerText;
    return [...new Set(text.match(/\b[a-z][a-zA-Z]*\.[a-zA-Z][a-zA-Z0-9_]{2,}\b/g) ?? [])].filter(
      (t) => !/\.(com|net|org|app|io|webp|png|jpg|svg|js|css)$/i.test(t as string),
    ) as string[];
  });
}

test.describe('The deployed store', () => {
  test('TC-PROD-01: the store opens in Arabic, right to left', async ({ page }) => {
    await page.goto(STORE, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/ar$/);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('heading', { name: 'المنتجات' })).toBeVisible();
  });

  test('TC-PROD-02: a browser asking for English still gets Arabic', async ({ browser }) => {
    // The decision of 2026-08-31, checked where it actually matters. The
    // localhost test proves the setting; this proves the deployment carries it.
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    await page.goto(STORE, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/ar$/);
    await context.close();
  });

  test('TC-PROD-03: the catalogue lists a real product at its retail price', async ({ page }) => {
    // Connected end to end: the store's build has the right API URL, the API
    // reaches Neon, and an anonymous visitor is quoted B2C.
    await page.goto(`${STORE}/ar`, { waitUntil: 'domcontentloaded' });
    const card = page.locator('[data-sku]').first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Brake Disc');

    // Not `toContainText('1,200')`. The store renders in Arabic, and Arabic
    // number formatting uses its own digits and its own thousands separator —
    // asserting on the Western spelling tests the reader's locale, not the
    // price. Normalise the digits, then compare.
    const shown = (await card.innerText()).replace(/[٠-٩]/g, (d) =>
      String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)),
    ).replace(/[^0-9]/g, '');
    expect(shown, 'the retail price is not on the card').toContain('1200');
    expect(shown, 'a signed-out visitor was quoted the trade price').not.toContain('850');
  });

  test('TC-PROD-04: the product photograph loads from the blob store', async ({ page }) => {
    // The one piece with no local equivalent: locally this adapter is never
    // chosen, so nothing before deployment exercises it.
    await page.goto(`${STORE}/ar`, { waitUntil: 'domcontentloaded' });
    const image = page.locator('[data-sku] img').first();
    await expect(image).toBeVisible({ timeout: 30_000 });

    const ok = await image.evaluate(
      (el: HTMLImageElement) => el.complete && el.naturalWidth > 0,
    );
    expect(ok, 'the image element rendered but no bytes arrived').toBe(true);
  });

  test('TC-PROD-05: no untranslated key reaches the storefront', async ({ page }) => {
    await page.goto(`${STORE}/ar`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-sku]').first()).toBeVisible({ timeout: 30_000 });
    expect(await untranslatedKeys(page)).toEqual([]);
  });
});

test.describe('The deployed office app', () => {
  test('TC-PROD-06: a partner can sign in and reach the dashboard', async ({ page }) => {
    // Proves the whole chain in one go: the office build's API URL, CORS from a
    // real origin, the JWT secret set on the API, and Neon behind it.
    await page.goto(`${OFFICE}/en/login`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder(EMAIL).fill(EMAIL);
    await page.getByPlaceholder('••••••••').fill(PASSWORD);
    await page.getByRole('button', { name: /login/i }).click();
    await expect(page).toHaveURL(/dashboard/, { timeout: 30_000 });
  });

  test('TC-PROD-07: the product created in production is listed with its photo', async ({ page }) => {
    await page.goto(`${OFFICE}/en/login`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder(EMAIL).fill(EMAIL);
    await page.getByPlaceholder('••••••••').fill(PASSWORD);
    await page.getByRole('button', { name: /login/i }).click();
    await expect(page).toHaveURL(/dashboard/, { timeout: 30_000 });

    await page.goto(`${OFFICE}/en/products`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Brake Disc, Front')).toBeVisible({ timeout: 30_000 });
  });

  test('TC-PROD-08: CORS allows the office origin', async ({ page }) => {
    // A CORS refusal is a browser-side network error with nothing in the API
    // log, so it reads as the API being down. WEB_ORIGIN was wrong once
    // already — it named a project that is not this one.
    await page.goto(`${OFFICE}/en/login`, { waitUntil: 'domcontentloaded' });
    const status = await page.evaluate(async (api) => {
      try {
        const res = await fetch(`${api}/portal/catalogue`);
        return res.status;
      } catch {
        return 'blocked by CORS';
      }
    }, API);
    expect(status).toBe(200);
  });
});

test.describe('The deployed API', () => {
  test('TC-PROD-09: the scheduled sweep refuses an unauthenticated caller', async ({ request }) => {
    // It mutates reservations and sends notifications. Open, it is a way for
    // anyone who finds the URL to expire holds.
    const res = await request.get(`${API}/jobs/sweep-holds`);
    expect(res.status()).toBe(401);
    expect((await res.json()).error.code).toBe('CRON_FORBIDDEN');
  });

  test('TC-PROD-10: an image is not readable without a token', async ({ request }) => {
    // The blob store is private; the API is the gate. Both halves matter.
    const res = await request.get(`${API}/files/download/products/nonexistent/x-original.webp`);
    expect([401, 403, 404]).toContain(res.status());
  });
});
