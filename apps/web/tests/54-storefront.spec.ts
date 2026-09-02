/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The storefront, through a browser
 * ═══════════════════════════════════════════════════════════════════════
 *  `53-portal` proves the API. Nothing until now proved that a shop owner
 *  holding a phone can reach any of it. Every bug this suite is shaped around
 *  is one that an API test cannot see:
 *
 *  - **A price the screen decided for itself.** The tier is resolved on the
 *    server and echoed back, but the card, the product page and the price
 *    context line all render it separately, and the query cache sits between
 *    them and the API. Signing in has to change what is already on screen —
 *    which is why nothing here reaches a screen with `page.goto()` after the
 *    first one. A full page load rebuilds the cache and hides exactly the bug
 *    this repository has shipped twice.
 *
 *  - **A refusal that arrives as a code.** The API answers
 *    `{ error: { code, message } }` and Arabic is the default locale here, so
 *    a screen that reads `data.message`, or trusts `t()` to throw on a missing
 *    key, shows a shop `errors.NOT_ENOUGH_STOCK` or nothing at all.
 *
 *  - **Two conventions the owner has corrected repeatedly.** No native
 *    `<select>`, and a pointer cursor on everything clickable. Both are
 *    asserted across every screen rather than at the one place they were last
 *    got wrong.
 *
 *  Fixtures come from `support/fixtures` and build stock properly — a cycle, a
 *  purchase order, a shipping leg and a verified receipt. A catalogue test that
 *  looks for a product with stock and skips when there is none is a test that
 *  reports green having asserted nothing.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { API, apiCtx, stockedProduct } from './support/fixtures';

const SHOP_EMAIL = 'shop.owner@example.com';
const SHOP_PASSWORD = 'password123';

/**
 * Unique per run, so a name typed into a search box matches one product.
 *
 * Letters, never digits. The first draft used `Date.now()` and TC-STORE-03 —
 * which asserts a stock quantity appears nowhere on the page — failed twice on
 * `8123` turning up inside a timestamp, once in its own product's name and once
 * in a product an earlier test had left in the catalogue. A fixture's own
 * naming should not be able to fail an assertion about the app.
 */
const stamp = () =>
  Array.from(
    { length: 10 },
    () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)],
  ).join('');

/**
 * The app's own alerts, and not Next's route announcer.
 *
 * `#__next-route-announcer__` is a `div[role="alert"]` the framework keeps on
 * every page, so a bare `getByRole('alert')` is a strict-mode violation
 * everywhere. Every refusal this app renders is a `<p role="alert">`.
 */
const alertIn = (scope: Page | ReturnType<Page['locator']>) => scope.locator('p[role="alert"]');

/**
 * Take the dev overlay out of the way.
 *
 * `next dev` mounts `<nextjs-portal>` over the bottom-left corner, which on a
 * phone viewport is exactly where the bottom bar's first tab is — so Playwright
 * refuses the click as intercepted. It is a development artifact and not part
 * of the app, and hiding it is honest in a way that `force: true` is not:
 * forcing the click would also hide a real element covering a real control.
 */
test.beforeEach(async ({ page }) => {
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

/**
 * A priced product, optionally with stock genuinely received.
 *
 * `qty: 0` skips the cycle entirely and leaves the product unstocked, which is
 * what `stockBand` calls OUT. Both are needed: a suite that only ever builds
 * stocked products never renders the band that matters most on a card.
 */
async function aProduct(
  request: APIRequestContext,
  label: string,
  {
    qty = 20,
    b2c = 500,
    b2b = 400,
    categoryId,
  }: { qty?: number; b2c?: number; b2b?: number; categoryId?: string } = {},
) {
  const { headers, mk } = await apiCtx(request);

  const product =
    qty > 0
      ? (await stockedProduct(request, headers, mk, label, qty, categoryId)).product
      : await mk('products', {
          name: `${label} Part`,
          minStock: 0,
          ...(categoryId ? { categoryId } : {}),
        });

  await mk(`products/${product.id}/prices`, { channel: 'B2C', currency: 'EGP', amount: b2c });
  await mk(`products/${product.id}/prices`, { channel: 'B2B', currency: 'EGP', amount: b2b });

  return { id: product.id as string, sku: product.sku as string, name: product.name as string };
}

/** The bottom bar, which is how a person moves between the four screens. */
const tab = (page: Page, key: 'catalogue' | 'requests' | 'imports' | 'account') =>
  page.locator(`[data-tab="${key}"]`);

/**
 * Sign in the way a shop does: the account tab, the sign-in screen, the form.
 *
 * Deliberately not a token written into `localStorage`. The whole point of
 * several tests below is what signing in does to a page that is already on
 * screen, and a seeded token skips the act being tested.
 */
async function signIn(page: Page, email: string, password: string) {
  await tab(page, 'account').click();
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // `router.replace('/')` on success — the catalogue is the landing.
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
}

/**
 * Bring one product on screen and return its card.
 *
 * The catalogue serves a page of ten. That is fine when the storefront suite
 * runs alone against the seeded catalogue, and wrong the moment it runs after
 * the office suite, which creates around ninety products first — the seeded
 * parts and the fixture's own product are then both on page two, and every
 * `[data-sku=…]` in this file resolves to nothing.
 *
 * Three tests failed exactly that way, and only when run together with the
 * office project, which is the run nobody had done. Searching for the part is
 * also what a shop with a real catalogue would do; expecting a specific SKU on
 * the first screen was only ever true of a small seed.
 */
async function showProduct(page: Page, sku: string, term: string) {
  const card = page.locator(`[data-sku="${sku}"]`);
  if (await card.count()) return card;

  const search = page.getByPlaceholder('Search parts…');
  await search.fill(term);
  await expect(card).toBeVisible({ timeout: 10_000 });
  return card;
}

/** Put a product in the basket from its own page, reached from the catalogue. */
async function addToBasket(page: Page, sku: string, term?: string) {
  if (term) await showProduct(page, sku, term);
  await page.locator(`[data-sku="${sku}"]`).click();
  const add = page.getByRole('button', { name: /Add to request|Added to your request/ });
  await add.click();
  await expect(add).toHaveText(/Added to your request/);
}

/**
 * Open the basket.
 *
 * The launcher lives on the orders tab, not the catalogue — see the note in
 * the report; this walks the route that exists rather than the one that ought
 * to.
 */
async function openBasket(page: Page) {
  await tab(page, 'requests').click();
  await page.getByRole('button', { name: /Your request/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

/**
 * Every clickable element on the current screen whose cursor is not a pointer.
 *
 * Returned rather than asserted so the failure names the offenders. Tailwind
 * v4's preflight dropped the rule, so a control added without it is an arrow —
 * a correction the owner has now made twice, which is why this is a test and
 * not a review note.
 */
async function arrowCursors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector = 'button, a[href], summary, [role="button"], [role="option"], [role="tab"]';
    const wrong: string[] = [];

    for (const el of Array.from(document.querySelectorAll(selector))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;

      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // A control that is off is honestly not-allowed, and says so.
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') continue;

      if (style.cursor !== 'pointer') {
        const label = (el.textContent ?? '').trim().slice(0, 30);
        wrong.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}"> ` +
          `"${label}" → cursor:${style.cursor}`);
      }
    }
    return wrong;
  });
}

/**
 * Any translation key that reached the screen as a key.
 *
 * next-intl does not throw on a missing message — it renders the dotted path —
 * so `errors.SHOP_NOT_VERIFIED` looks like a broken template to a shop and like
 * nothing at all to a test that only checks a box appeared. Scoped to this
 * app's own namespaces so a part number or an email address is not mistaken
 * for one.
 */
const NAMESPACES = ['common', 'nav', 'catalogue', 'basket', 'requests', 'imports', 'account', 'auth', 'errors', 'entity'];
const KEY_PATH = new RegExp(`\\b(?:${NAMESPACES.join('|')})\\.[A-Za-z_][A-Za-z0-9_]*`, 'g');

async function untranslatedKeys(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => document.body.innerText);
  return Array.from(new Set(text.match(KEY_PATH) ?? []));
}

/** Small real files on disk, because a file input takes paths. */
const FILES = mkdtempSync(path.join(tmpdir(), 'storefront-photos-'));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
function aPhoto(name: string): string {
  const file = path.join(FILES, name);
  writeFileSync(file, PNG);
  return file;
}
function aTextFile(name: string): string {
  const file = path.join(FILES, name);
  writeFileSync(file, 'this is not a photograph of a brake pad');
  return file;
}

// ─────────────────────────────────────────────────────────────────────────
test.describe('The shop window', () => {
  test('TC-STORE-01: the catalogue lists parts, and search narrows it', async ({
    page,
    request,
  }) => {
    const label = `Zephyr${stamp()}`;
    const mine = await aProduct(request, label);

    await page.goto('/en');

    // A page of ten, so how many cards there are is not a fixed number — it is
    // however many the catalogue holds, capped. Count what is on screen rather
    // than naming a SKU that may be on page two.
    const cards = page.locator('[data-sku]');
    await expect(cards.first()).toBeVisible();
    const before = await cards.count();
    expect(before, 'the catalogue rendered nothing to narrow').toBeGreaterThan(1);

    await page.getByPlaceholder('Search parts…').fill(label);

    // Narrowed to exactly the one part, whatever else the catalogue holds.
    await expect(page.locator(`[data-sku="${mine.sku}"]`)).toBeVisible();
    await expect(cards, 'search did not narrow anything').toHaveCount(1);

    // And clearing it puts the catalogue back — the second visit, where a
    // filter that is applied once and never lifted lives.
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(cards).toHaveCount(before);
  });

  test('TC-STORE-02: the category filter narrows, and is not a native select', async ({
    page,
    request,
  }) => {
    // A category of its own, with one part in it. Naming the seeded
    // `PRD-000001` and `PRD-000002` meant this test only held while the
    // catalogue was small enough for both to be on the first page of ten —
    // true when the storefront suite runs alone, false the moment the office
    // suite has run first and created ninety products.
    //
    // Filtering to a category nothing else can be in makes the assertion exact
    // rather than approximately true: one card, and it is the right one.
    const label = `Sprocket${stamp()}`;
    const { mk } = await apiCtx(request);
    const category = await mk('categories', { name: `${label} Category` });
    const mine = await aProduct(request, label, { categoryId: category.id });

    await page.goto('/en');

    await page.getByRole('combobox').click();
    // The picker is searchable, which an `<option>` cannot be — and while it
    // is open is the moment a native control would be in the DOM.
    await expect(page.locator('select, option')).toHaveCount(0);
    // Searched rather than scrolled to. The office suite leaves dozens of
    // categories behind, and a row far down a scrolling popover is the same
    // page-one assumption as the one this test was rewritten to remove.
    // `exact` because the catalogue's own box says "Search parts…", which a
    // substring match would take instead.
    await page.getByPlaceholder('Search', { exact: true }).fill(label);
    await page.getByRole('option', { name: `${label} Category` }).click();

    const cards = page.locator('[data-sku]');
    await expect(page.locator(`[data-sku="${mine.sku}"]`)).toBeVisible();
    await expect(cards, 'the category filter narrowed nothing').toHaveCount(1);
  });

  test('TC-STORE-03: stock is a band on the card, never a count', async ({ page, request }) => {
    // One with a quantity nobody should ever see, one with none at all.
    const label = `Bandit${stamp()}`;
    const stocked = await aProduct(request, `${label}A`, { qty: 8123 });
    const empty = await aProduct(request, `${label}B`, { qty: 0 });

    await page.goto('/en');
    await page.getByPlaceholder('Search parts…').fill(label);

    const stockedCard = page.locator(`[data-sku="${stocked.sku}"]`);
    const emptyCard = page.locator(`[data-sku="${empty.sku}"]`);
    await expect(stockedCard).toBeVisible();
    await expect(emptyCard).toBeVisible();

    await expect(stockedCard.locator('[data-stock]')).toHaveAttribute('data-stock', 'IN_STOCK');
    await expect(stockedCard.locator('[data-stock]')).toHaveText('In stock');
    await expect(emptyCard.locator('[data-stock]')).toHaveAttribute('data-stock', 'OUT');
    await expect(emptyCard.locator('[data-stock]')).toHaveText('Out of stock');

    // The number itself must be nowhere on the page, not merely absent from
    // the badge — a "8123 available" added anywhere is what this catches.
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('8123');

    // And an out-of-stock part cannot be asked for from its own page.
    await emptyCard.click();
    await expect(page.getByRole('button', { name: 'Add to request' })).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
test.describe('Whose prices these are', () => {
  test('TC-STORE-04: a stranger is quoted retail, and the card and the page agree', async ({
    page,
    request,
  }) => {
    const label = `Retail${stamp()}`;
    const mine = await aProduct(request, label, { b2c: 517, b2b: 411 });

    await page.goto('/en');
    await page.getByPlaceholder('Search parts…').fill(label);

    await expect(page.locator('[data-price-context="anonymous"]')).toBeVisible();
    const card = page.locator(`[data-sku="${mine.sku}"]`);
    await expect(card).toContainText('517');
    await expect(card, 'a signed-out visitor was quoted the trade price').not.toContainText('411');

    await card.click();
    const heading = page.getByRole('heading', { name: mine.name });
    await expect(heading).toBeVisible();
    // Two surfaces, one figure. A store that quotes one price on the card and
    // another on the page is one a shop stops trusting entirely.
    await expect(page.locator('article')).toContainText('517');
    await expect(page.locator('article')).not.toContainText('411');
  });

  test('TC-STORE-05: signing in changes the prices already on screen', async ({
    page,
    request,
  }) => {
    // The bug this is really about is the cache. Everything on screen was
    // fetched for nobody; if signing in only sets a token, the shop goes on
    // reading retail until each query happens to refetch. Reached by clicking,
    // never by `goto` — a reload would rebuild the cache and hide it.
    const label = `Trade${stamp()}`;
    const mine = await aProduct(request, label, { b2c: 517, b2b: 411 });

    await page.goto('/en');
    await page.getByPlaceholder('Search parts…').fill(label);
    const card = page.locator(`[data-sku="${mine.sku}"]`);
    await expect(card).toContainText('517');

    await signIn(page, SHOP_EMAIL, SHOP_PASSWORD);

    await expect(page.locator('[data-price-context="trade"]')).toBeVisible();
    await page.getByPlaceholder('Search parts…').fill(label);
    await expect(card, 'a verified shop was left reading retail prices').toContainText('411');
    await expect(card).not.toContainText('517');

    // And the product page agrees, still without a reload.
    await card.click();
    await expect(page.locator('article')).toContainText('411');
    await expect(page.getByText('Your trade prices')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────
test.describe('Asking for stock', () => {
  test('TC-STORE-06: a request is sent, and the hold is stated before the button', async ({
    page,
    request,
  }) => {
    const label = `Ask${stamp()}`;
    const mine = await aProduct(request, label, { qty: 40 });

    await page.goto('/en');
    await signIn(page, SHOP_EMAIL, SHOP_PASSWORD);
    await addToBasket(page, mine.sku, label);
    await openBasket(page);

    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText(mine.name);
    // Sending sets stock aside that another shop then cannot be promised. A
    // customer who learns that from the confirmation screen was not asked.
    const held = sheet.getByText(/Sending holds the stock for 48 hours/);
    const send = sheet.getByRole('button', { name: 'Send request' });
    await expect(held).toBeVisible();
    const heldBox = await held.boundingBox();
    const sendBox = await send.boundingBox();
    expect(heldBox!.y, 'the 48-hour hold is stated after the button').toBeLessThan(sendBox!.y);

    await send.click();

    await expect(sheet.getByText('Request sent. We will let you know.')).toBeVisible();
    const number = await sheet.locator('.font-mono').innerText();
    expect(number).toMatch(/^REQ-\d{4}-\d{4}$/);

    await sheet.getByRole('link', { name: 'See the request' }).click();
    await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { name: number })).toBeVisible();

    // The basket emptied only once a request number was in hand: the launcher
    // is gone from the orders tab.
    //
    // The row is waited for first, and that is not politeness. `toHaveCount(0)`
    // is satisfied the instant it is asked, so on its own it passes while the
    // screen is still blank — it passed against a build with `clear()` deleted.
    // The list rendering is the proof that the launcher had its chance.
    await tab(page, 'requests').click();
    await expect(page.locator(`[data-request="${number}"]`)).toBeVisible();
    await expect(page.getByRole('button', { name: /Your request/ })).toHaveCount(0);
  });

  test('TC-STORE-07: more than exists is refused in words, and the basket survives it', async ({
    page,
    request,
  }) => {
    // Arabic, because a refusal is the one place where reading the API's
    // English fallback would pass an English test while telling an Arabic
    // reader nothing.
    const mine = await aProduct(request, `Greed${stamp()}`, { qty: 5 });

    await page.goto('/ar');
    await tab(page, 'account').click();
    await page.getByRole('link', { name: 'تسجيل الدخول', exact: true }).click();
    await page.getByLabel('البريد الإلكتروني').fill(SHOP_EMAIL);
    await page.getByLabel('كلمة المرور', { exact: true }).fill(SHOP_PASSWORD);
    await page.getByRole('button', { name: 'تسجيل الدخول', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'المنتجات' })).toBeVisible();

    await page.getByPlaceholder('ابحث عن قطعة…').fill(mine.name);
    await page.locator(`[data-sku="${mine.sku}"]`).click();
    await page.getByRole('button', { name: /أضف إلى الطلب/ }).click();

    await tab(page, 'requests').click();
    await page.getByRole('button', { name: /طلبك/ }).click();
    const sheet = page.getByRole('dialog');

    await sheet.getByLabel(/الكمية/).fill('9999');
    await sheet.getByRole('button', { name: 'إرسال الطلب' }).click();

    const alert = alertIn(sheet);
    await expect(alert).toBeVisible();
    // The translated sentence, with the figures the API sent in it.
    await expect(alert).toContainText('المتاح من');
    await expect(alert).toContainText(mine.name);
    await expect(alert, 'the refusal arrived as a raw code').not.toContainText(
      'NOT_ENOUGH_STOCK',
    );
    expect(await untranslatedKeys(page)).toEqual([]);

    // A refusal leaves the basket exactly as it was, so the shop can act on
    // what it is told. Clearing optimistically throws away the thing they were
    // asked to correct.
    await expect(sheet.getByLabel(/الكمية/)).toHaveValue('9999');
    await expect(sheet.getByRole('button', { name: 'إرسال الطلب' })).toBeVisible();
  });

  test('TC-STORE-08: zero and negative never reach the server', async ({ page, request }) => {
    const label = `Zero${stamp()}`;
    const mine = await aProduct(request, label, { qty: 10 });

    await page.goto('/en');
    await signIn(page, SHOP_EMAIL, SHOP_PASSWORD);
    await addToBasket(page, mine.sku, label);
    await openBasket(page);

    const sheet = page.getByRole('dialog');
    const quantity = sheet.getByLabel(/Quantity/);

    // The floor is enforced by the control, not by a message after the fact.
    await expect(sheet.getByRole('button', { name: 'Take one off' })).toBeDisabled();

    // A minus typed on a phone's number pad is not a quantity.
    await quantity.fill('-5');
    await expect(quantity, 'a negative quantity was accepted').toHaveValue('5');

    // Zero is not "none of these", it is "take this off the request".
    await quantity.fill('0');
    await expect(sheet.getByText('Nothing added yet.')).toBeVisible();
    // And an empty request cannot be sent at all — there is no button to press.
    await expect(sheet.getByRole('button', { name: 'Send request' })).toHaveCount(0);
  });

  test('TC-STORE-09: a refusal does not follow the basket to the next visit', async ({
    page,
    request,
  }) => {
    // The second time. Most bugs found in this repository lived on the second
    // visit — a form that keeps last time's error over a basket that has since
    // changed, so the shop reads a refusal about something it already fixed.
    const label = `Again${stamp()}`;
    const scarce = await aProduct(request, label, { qty: 3 });

    await page.goto('/en');
    await signIn(page, SHOP_EMAIL, SHOP_PASSWORD);
    await addToBasket(page, scarce.sku, label);
    await openBasket(page);

    const sheet = page.getByRole('dialog');
    await sheet.getByLabel(/Quantity/).fill('500');
    await sheet.getByRole('button', { name: 'Send request' }).click();
    await expect(alertIn(sheet)).toBeVisible();

    await sheet.getByRole('button', { name: 'Close' }).first().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: /Your request/ }).click();
    const again = page.getByRole('dialog');
    await expect(again).toBeVisible();
    // The lines are still there — and last time's refusal is not.
    await expect(again.getByLabel(/Quantity/)).toHaveValue('500');
    await expect(alertIn(again), "last time's refusal was still on screen").toHaveCount(0);

    // Corrected to what exists, the same basket goes through.
    await again.getByLabel(/Quantity/).fill('3');
    await again.getByRole('button', { name: 'Send request' }).click();
    await expect(again.getByText('Request sent. We will let you know.')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────
test.describe('A shop that has just signed up', () => {
  test('TC-STORE-10: signup creates an account waiting to be looked at, not a session', async ({
    page,
  }) => {
    const email = `newshop${stamp()}@example.com`;

    await page.goto('/en');
    await tab(page, 'account').click();
    await page.getByRole('link', { name: 'Create an account' }).click();

    await page.getByLabel('Shop name').fill('Wadi Motors');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('password123');
    await page.getByRole('button', { name: 'Create an account' }).click();

    await expect(page.getByText('Your account has been created.')).toBeVisible();
    await expect(page.getByText(/ordering opens once your shop is approved/)).toBeVisible();

    // No token was minted. An account nobody has looked at is not a session,
    // and signing them in quietly would have the store behaving as though the
    // review had already happened.
    expect(await page.evaluate(() => localStorage.getItem('storefront.token'))).toBeNull();

    // Signing up again with the same address is refused, in a sentence, and
    // the form keeps what was typed.
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByRole('link', { name: 'Create an account' }).click();
    await page.getByLabel('Shop name').fill('Wadi Motors');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('password123');
    await page.getByRole('button', { name: 'Create an account' }).click();

    await expect(alertIn(page)).toContainText('That email address is already registered.');
    await expect(page.getByLabel('Shop name')).toHaveValue('Wadi Motors');
  });

  test('TC-STORE-11: an unverified shop is quoted retail, refused an order, and can still ask for an import', async ({
    page,
    request,
  }) => {
    const email = `unverified${stamp()}@example.com`;
    const mine = await aProduct(request, `Gate${stamp()}`, { qty: 12, b2c: 517, b2b: 411 });

    await page.goto('/en');
    await tab(page, 'account').click();
    await page.getByRole('link', { name: 'Create an account' }).click();
    await page.getByLabel('Shop name').fill('Halim Spares');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('password123');
    await page.getByRole('button', { name: 'Create an account' }).click();
    await expect(page.getByText('Your account has been created.')).toBeVisible();

    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('password123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();

    // The catalogue says why the prices are what they are, rather than showing
    // trade prices this account cannot buy at.
    await expect(page.locator('[data-price-context="unverified"]')).toBeVisible();
    await page.getByPlaceholder('Search parts…').fill(mine.name);
    await expect(page.locator(`[data-sku="${mine.sku}"]`)).toContainText('517');

    await tab(page, 'account').click();
    await expect(page.locator('[data-verification="unverified"]')).toBeVisible();

    // The wrong context: the whole ordering flow is open until the last step,
    // and the refusal has to be a sentence rather than a code.
    await tab(page, 'catalogue').click();
    await addToBasket(page, mine.sku, mine.name);
    await openBasket(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Send request' }).click();
    await expect(alertIn(page.getByRole('dialog'))).toContainText(
      'Your account is still being reviewed',
    );
    expect(await untranslatedKeys(page)).toEqual([]);

    // And the one thing it CAN do is not gated with it. An import request
    // holds no stock and promises nothing.
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();
    await tab(page, 'imports').click();
    await expect(page.getByRole('button', { name: 'Ask for a part' })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────
test.describe('Asking us to bring something in', () => {
  test('TC-STORE-12: an import request is saved before its photographs', async ({ page }) => {
    await page.goto('/en');
    await signIn(page, SHOP_EMAIL, SHOP_PASSWORD);
    await tab(page, 'imports').click();
    await page.getByRole('button', { name: 'Ask for a part' }).click();

    const sheet = page.getByRole('dialog');
    const name = `Ducati clutch basket ${stamp()}`;
    await sheet.getByLabel('What is it').fill(name);
    await sheet.getByLabel(/How many/).fill('4');
    // Typed the way a thumb types it; the scheme is added and written back
    // into the field rather than behind the shop's back.
    await sheet.getByLabel(/A link/).fill('parts.example.com/clutch');
    await sheet.getByRole('button', { name: 'Send', exact: true }).click();

    // The text is stored first: the photo step is on screen, and the part has
    // already been asked for.
    await expect(sheet.getByText('Sent. We will get back to you.')).toBeVisible();
    await expect(sheet.getByText('0 of 6 photos')).toBeVisible();

    await sheet.locator('input[type="file"]').setInputFiles(aPhoto('part-1.png'));
    await expect(sheet.getByText('1 of 6 photos')).toBeVisible({ timeout: 30_000 });

    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(name)).toBeVisible();
  });

  test('TC-STORE-13: a seventh photograph is refused, and the six are not', async ({ page }) => {
    await page.goto('/en');
    await signIn(page, SHOP_EMAIL, SHOP_PASSWORD);
    await tab(page, 'imports').click();
    await page.getByRole('button', { name: 'Ask for a part' }).click();

    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('What is it').fill(`Seven photos ${stamp()}`);
    await sheet.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(sheet.getByText('0 of 6 photos')).toBeVisible();

    const seven = Array.from({ length: 7 }, (_, i) => aPhoto(`many-${i}.png`));
    await sheet.locator('input[type="file"]').setInputFiles(seven);

    // Said at once, before ninety seconds of a workshop connection are spent
    // on a photo that was never going to be kept.
    await expect(alertIn(sheet)).toContainText('A request can carry at most 6 photos.');
    await expect(sheet.getByText('6 of 6 photos')).toBeVisible({ timeout: 90_000 });
    await expect(sheet.getByRole('button', { name: /You have added all 6 photos/ })).toBeDisabled();
  });

  test('TC-STORE-14: a file that is not a photograph is refused before it is sent', async ({
    page,
  }) => {
    await page.goto('/en');
    await signIn(page, SHOP_EMAIL, SHOP_PASSWORD);
    await tab(page, 'imports').click();
    await page.getByRole('button', { name: 'Ask for a part' }).click();

    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('What is it').fill(`Not a photo ${stamp()}`);
    await sheet.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(sheet.getByText('0 of 6 photos')).toBeVisible();

    await sheet.locator('input[type="file"]').setInputFiles(aTextFile('invoice.txt'));

    await expect(alertIn(sheet)).toContainText('That file is not an image we can read.');

    // Refused here, not uploaded and then refused. The tile is what tells the
    // two apart: the server refuses it too, with the same sentence, but only
    // after the file has been queued — and a queued file leaves a preview in
    // the grid whether it succeeds or fails. No tile means it never left.
    await expect(sheet.locator('img[alt=""]')).toHaveCount(0);
    await expect(sheet.locator('[role="progressbar"]')).toHaveCount(0);
    await expect(sheet.getByText('0 of 6 photos')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────
test.describe('The language it opens in', () => {
  // A browser asking for a language this app does not publish. next-intl honours
  // `Accept-Language` when it can, so a visitor on an Arabic phone was always
  // going to land on Arabic and proves nothing about the default; what a
  // *default* means is where everyone else lands. The suite's other tests run
  // under Playwright's `en-US`, which is why they name their locale in the path.
  test.use({ locale: 'fr-FR' });

  test('TC-STORE-15: the store opens in Arabic, right to left, with no key paths on screen', async ({
    page,
    request,
  }) => {
    await aProduct(request, `Arabic${stamp()}`, { qty: 9 });

    // No locale in the path: this is the address a shop is given.
    await page.goto('/');
    await expect(page, 'the store fell back to English').toHaveURL(/\/ar$/);

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('heading', { name: 'المنتجات' })).toBeVisible();
    await expect(page.getByPlaceholder('ابحث عن قطعة…')).toBeVisible();
    // The grid first: a key path cannot be found on a screen that has not
    // rendered the line it lives on.
    await expect(page.locator('[data-sku]').first()).toBeVisible();

    expect(await untranslatedKeys(page), 'a translation key reached the catalogue').toEqual([]);

    // Signed in, because that is where the sentences with parameters in them
    // live — the trade-price line, the verification line, the hold banner.
    await tab(page, 'account').click();
    await page.getByRole('link', { name: 'تسجيل الدخول', exact: true }).click();
    await page.getByLabel('البريد الإلكتروني').fill(SHOP_EMAIL);
    await page.getByLabel('كلمة المرور', { exact: true }).fill(SHOP_PASSWORD);
    await page.getByRole('button', { name: 'تسجيل الدخول', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'المنتجات' })).toBeVisible();
    await expect(page.getByText('أسعار الجملة الخاصة بك')).toBeVisible();

    for (const key of ['catalogue', 'requests', 'imports', 'account'] as const) {
      await tab(page, key).click();
      await expect(tab(page, key)).toHaveAttribute('aria-current', 'page');
      // Let whatever this tab fetches arrive before reading the text.
      await expect(page.getByText('جارٍ التحميل…')).toHaveCount(0);
      expect(await untranslatedKeys(page), `a translation key reached /${key}`).toEqual([]);
    }
  });

  test('TC-STORE-18: a phone set to English still opens in Arabic', async ({ browser }) => {
    // The decision (business-rules.md §13, 2026-08-31): the store opens in
    // Arabic for everyone, and English is a choice the reader makes.
    //
    // next-intl honours `Accept-Language` unless told not to, which made
    // `defaultLocale: 'ar'` only a fallback — a phone set to English landed on
    // /en, and plenty of phones here are set to English by whoever sold them,
    // which is not the same as somebody choosing to read English.
    //
    // TC-STORE-15 could not catch this: it uses the default context, which
    // never asks for English, so it passed throughout. A rule about what
    // happens when the browser has an opinion has to be tested with a browser
    // that has one.
    for (const locale of ['en-US', 'en-GB', 'fr-FR']) {
      const context = await browser.newContext({ locale });
      const page = await context.newPage();
      // The beforeEach hook runs on the fixture page, not this one.
      await page.addInitScript(() => {
        const style = document.createElement('style');
        style.textContent = 'nextjs-portal { display: none !important }';
        document.head?.appendChild(style);
      });

      await page.goto('/');
      await expect(page, `a browser asking for ${locale} was sent to English`).toHaveURL(
        /\/ar$/,
      );
      await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      // Arabic on screen, not merely an /ar address.
      await expect(page.getByRole('heading', { name: 'المنتجات' })).toBeVisible();

      await context.close();
    }
  });

});

// ─────────────────────────────────────────────────────────────────────────
test.describe('The controls it is made of', () => {
  test('TC-STORE-19: the bottom bar is one row, in both languages', async ({ page }) => {
    // "Import requests" wrapped to two lines on an iPhone while the other three
    // labels did not. The icons stayed level, the label did not, and the bar
    // grew — it read as broken alignment rather than as one long word.
    //
    // Asserted on geometry rather than on the strings, because the strings are
    // exactly what a translator changes. Every tab must be the same height and
    // every label must occupy a single line.
    // 375px: an iPhone SE, 13 mini, or any of the narrow ones still in use.
    //
    // This matters more than it looks. The first version of this test ran at
    // the project's default Pixel 7 width of 412px, where "Import requests"
    // fits on one line — so it passed against the exact markup that wrapped on
    // the owner's iPhone. A layout test proves nothing at a width where the
    // layout is not under pressure; it has to run at the narrowest screen the
    // app claims to support.
    await page.setViewportSize({ width: 375, height: 812 });

    for (const locale of ['en', 'ar']) {
      await page.goto(`/${locale}`);

      const tabs = page.locator('nav a[data-tab]');
      await expect(tabs).toHaveCount(4);

      const boxes = await tabs.evaluateAll((els) =>
        els.map((el) => {
          const label = el.querySelector('span');
          const cs = label ? getComputedStyle(label) : null;
          const lineHeight = cs ? parseFloat(cs.lineHeight) : 0;
          return {
            tab: el.getAttribute('data-tab'),
            height: Math.round(el.getBoundingClientRect().height),
            labelHeight: label ? Math.round(label.getBoundingClientRect().height) : 0,
            lineHeight: Math.round(lineHeight),
            text: (label?.textContent ?? '').trim(),
          };
        }),
      );

      // Every tab the same height: one that wrapped would be taller.
      const heights = [...new Set(boxes.map((b) => b.height))];
      expect(heights, `${locale}: tabs are not the same height — ${JSON.stringify(boxes)}`).toHaveLength(1);

      // And each label is a single line, which is the cause rather than the
      // symptom — two tabs could wrap together and still match in height.
      const wrapped = boxes.filter((b) => b.lineHeight > 0 && b.labelHeight > b.lineHeight * 1.5);
      expect(wrapped, `${locale}: these labels wrap — ${JSON.stringify(wrapped)}`).toEqual([]);
    }
  });

  test('TC-STORE-20: the password reveal sits where the field reserves room for it', async ({
    page,
  }) => {
    // In Arabic the eye sat on the left while the field reserved its 48px of
    // space on the right, so a typed password ran directly underneath the icon
    // and the reserved space stayed empty on the other side.
    //
    // The cause was two logical properties resolving against different
    // directions: `dir="auto"` made the input LTR (a password is Latin), so its
    // `padding-inline-end` went right, while the button's `end-0` resolved
    // against the RTL page and went left.
    //
    // Asserted as a relationship rather than as "the button is on the right",
    // because the right answer differs per direction. The button must sit in
    // the padding the input reserved — whichever side that turns out to be.
    for (const locale of ['ar', 'en']) {
      await page.goto(`/${locale}/login`);

      const field = page.locator('input[type="password"]');
      await expect(field).toBeVisible();
      await field.fill('MyPassword123');

      const geometry = await page.evaluate(() => {
        const input = document.querySelector('input[type="password"]') as HTMLInputElement;
        const button = input.parentElement!.querySelector('button')!;
        const cs = getComputedStyle(input);
        const ib = input.getBoundingClientRect();
        const bb = button.getBoundingClientRect();
        const ltr = cs.direction === 'ltr';
        return {
          inputDirection: cs.direction,
          // The side the input actually keeps clear.
          reserved: ltr ? parseFloat(cs.paddingRight) : parseFloat(cs.paddingLeft),
          // Does the button sit against that same edge?
          gapAtReservedEdge: ltr ? Math.abs(bb.right - ib.right) : Math.abs(bb.left - ib.left),
          buttonWidth: bb.width,
        };
      });

      // The field reserves real space for a button, not a token few pixels.
      expect(geometry.reserved, `${locale}: no room reserved`).toBeGreaterThanOrEqual(
        geometry.buttonWidth - 1,
      );

      // And the button is in it. Wrong side and this is the full field width.
      expect(
        geometry.gapAtReservedEdge,
        `${locale}: the reveal button is not against the edge the input reserves — ${JSON.stringify(geometry)}`,
      ).toBeLessThan(2);
    }
  });

  test('TC-STORE-21: no field is small enough to make Safari zoom', async ({ page }) => {
    // iOS Safari zooms the page in when a focused control's font-size is under
    // 16px, and does not zoom back out — the shop is left scrolled sideways
    // with the bottom bar off screen and no way back but a pinch. It reads as
    // the site being broken.
    //
    // It bit the control used most, the basket's quantity box at 14px.
    //
    // Probes constructed from the classes rather than only measuring what
    // happens to be on screen: the field that regresses next is the one
    // somebody adds tomorrow, and the rule has to beat a utility class.
    await page.goto('/ar');

    const result = await page.evaluate(() => {
      const measure = (tag: string, cls: string) => {
        const el = document.createElement(tag) as HTMLElement;
        el.className = cls;
        document.body.appendChild(el);
        const size = parseFloat(getComputedStyle(el).fontSize);
        el.remove();
        return size;
      };

      const probes: Record<string, number> = {
        'input.text-sm': measure('input', 'text-sm'),
        'input.text-xs': measure('input', 'text-xs'),
        'textarea.text-sm': measure('textarea', 'text-sm'),
        'select.text-xs': measure('select', 'text-xs'),
      };

      // And everything genuinely rendered on this page.
      document.querySelectorAll('input, select, textarea').forEach((el, i) => {
        probes[`onscreen[${i}]`] = parseFloat(getComputedStyle(el).fontSize);
      });

      return {
        coarse: window.matchMedia('(pointer: coarse)').matches,
        tooSmall: Object.entries(probes).filter(([, size]) => size < 16),
      };
    });

    // The rule is behind `pointer: coarse`; if the project stops emulating a
    // phone this test would pass by not applying, which proves nothing.
    expect(result.coarse, 'not running as a touch device — this test is void').toBe(true);
    expect(result.tooSmall, `these would zoom on iOS: ${JSON.stringify(result.tooSmall)}`).toEqual(
      [],
    );
  });

  test('TC-STORE-16: no native select or option anywhere in the store', async ({
    page,
    request,
  }) => {
    // Rejected four times now — twice in the internal system and twice here.
    // Asserted across every screen and inside every sheet, because the next
    // one will be added somewhere this suite was not looking.
    const mine = await aProduct(request, `Native${stamp()}`, { qty: 6 });
    const native = page.locator('select, option');

    await page.goto('/ar');
    // `toHaveCount(0)` is true of a blank page, so each of these follows
    // something that proves the screen it is asking about is on screen.
    await expect(page.getByRole('heading', { name: 'المنتجات' })).toBeVisible();
    await expect(native).toHaveCount(0);

    await signInArabic(page);
    await expect(page.getByRole('combobox')).toBeVisible();
    await expect(native).toHaveCount(0);

    await page.getByRole('combobox').click();
    await expect(page.getByRole('option').first()).toBeVisible();
    await expect(native, 'the category filter is a native select').toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByPlaceholder('ابحث عن قطعة…').fill(mine.name);
    await page.locator(`[data-sku="${mine.sku}"]`).click();
    await expect(page.getByRole('heading', { name: mine.name })).toBeVisible();
    await expect(native).toHaveCount(0);

    await page.getByRole('button', { name: /أضف إلى الطلب/ }).click();
    await tab(page, 'requests').click();
    await page.getByRole('button', { name: /طلبك/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(native, 'the basket sheet holds a native select').toHaveCount(0);
    await page.getByRole('dialog').getByRole('button', { name: 'إغلاق' }).first().click();

    await tab(page, 'imports').click();
    await page.getByRole('button', { name: 'اطلب قطعة' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(native, 'the import sheet holds a native select').toHaveCount(0);
    await page.getByRole('dialog').getByRole('button', { name: 'إغلاق' }).first().click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await tab(page, 'account').click();
    await expect(page.locator('[data-verification]')).toBeVisible();
    await expect(native).toHaveCount(0);
  });

  test('TC-STORE-17: everything clickable says so with the cursor', async ({ page, request }) => {
    const mine = await aProduct(request, `Cursor${stamp()}`, { qty: 6 });

    await page.goto('/en');
    await expect(page.getByRole('combobox')).toBeVisible();
    expect(await arrowCursors(page), 'catalogue').toEqual([]);

    await signIn(page, SHOP_EMAIL, SHOP_PASSWORD);
    await page.getByRole('combobox').click();
    await expect(page.getByRole('option').first()).toBeVisible();
    expect(await arrowCursors(page), 'the open category picker').toEqual([]);
    await page.keyboard.press('Escape');

    await page.getByPlaceholder('Search parts…').fill(mine.name);
    await page.locator(`[data-sku="${mine.sku}"]`).click();
    await expect(page.getByRole('button', { name: /Add to request/ })).toBeVisible();
    expect(await arrowCursors(page), 'the product page').toEqual([]);

    await page.getByRole('button', { name: /Add to request/ }).click();
    await tab(page, 'requests').click();
    await page.getByRole('button', { name: /Your request/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await arrowCursors(page), 'the basket sheet').toEqual([]);
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();

    await tab(page, 'imports').click();
    await page.getByRole('button', { name: 'Ask for a part' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await arrowCursors(page), 'the import sheet').toEqual([]);
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();

    await tab(page, 'account').click();
    await expect(page.locator('[data-verification]')).toBeVisible();
    expect(await arrowCursors(page), 'the account screen').toEqual([]);
  });
});

/** The Arabic half of `signIn`, for the tests that stay in the default locale. */
async function signInArabic(page: Page) {
  await tab(page, 'account').click();
  await page.getByRole('link', { name: 'تسجيل الدخول', exact: true }).click();
  await page.getByLabel('البريد الإلكتروني').fill(SHOP_EMAIL);
  await page.getByLabel('كلمة المرور', { exact: true }).fill(SHOP_PASSWORD);
  await page.getByRole('button', { name: 'تسجيل الدخول', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'المنتجات' })).toBeVisible();
}
