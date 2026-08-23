/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Item-row inputs select their contents on focus
 * ═══════════════════════════════════════════════════════════════════════
 *  Quantity starts at 1 and the money fields at 0, so entering a real value
 *  meant clearing the prefilled one first. A missed keystroke turns 5 into 15
 *  — a quantity that is wrong by ten and looks perfectly normal.
 *
 *  These drive the field with real clicks and keystrokes rather than fill(),
 *  because fill() replaces the value outright and would pass whether the
 *  selection happens or not. The first version of this fix looked right and
 *  did nothing: mouseup collapses the selection made during focus, so only a
 *  click-then-type test can tell the difference.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';

const BASE = 'http://localhost:3000';
const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

async function token(request: APIRequestContext) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return (await auth.json()).data.accessToken;
}

async function openOrderWithARow(page: Page) {
  await page.goto(`${BASE}/en/sales`);
  await page.getByRole('button', { name: /new order/i }).first().click();
  await page.getByRole('button', { name: /add item/i }).click();
}

/**
 * The item row's own number inputs.
 *
 * Not just `input[type="number"]`: the purchase order form has an FX Rate
 * field above the items, so the plain selector matched that instead and the
 * purchase test was asserting on the wrong element entirely — passing whether
 * the row worked or not. The row's inputs are the ones with no `name`, since
 * they are held in React state rather than submitted through the form.
 */
const rowInputs = (page: Page) => page.locator('input[type="number"]:not([name])');
const qty = (page: Page) => rowInputs(page).first();

/** Amount fields are formatted while typing, so they are text inputs. */
const money = (page: Page) => page.locator('input[inputmode="decimal"]');

test.describe('Item row inputs', () => {
  test('TC-INPUT-01: clicking a prefilled quantity and typing replaces it', async ({ page }) => {
    await login(page);
    await openOrderWithARow(page);

    await expect(qty(page)).toHaveValue('1');
    await qty(page).click();
    await page.keyboard.type('7');

    // Not "17": the prefilled 1 was selected and typed over.
    await expect(qty(page)).toHaveValue('7');
  });

  test('TC-INPUT-02: clicking again inside the field still edits normally', async ({ page }) => {
    // Selecting on every click would make correcting a long number impossible,
    // so the selection is only for the click that brings the field into focus.
    await login(page);
    await openOrderWithARow(page);

    await qty(page).click();
    await page.keyboard.type('7');
    await expect(qty(page)).toHaveValue('7');

    await qty(page).click();
    await page.keyboard.type('2');
    await expect(qty(page)).toHaveValue('72');
  });

  test('TC-INPUT-03: tabbing into the price field selects it too', async ({ page }) => {
    // Keyboard entry down a row is the fast path, and it should not need a
    // delete between fields either.
    await login(page);
    await openOrderWithARow(page);

    await qty(page).click();
    await page.keyboard.press('Tab');
    await page.keyboard.type('250');

    // Tab lands on the unit price, which is a formatted amount field.
    const price = money(page).first();
    await expect(price).toHaveValue('250');
  });

  test('TC-INPUT-04: the same holds on a purchase order row', async ({ page, request }) => {
    // The behaviour is shared, so it is worth one check outside sales.
    const t = await token(request);
    const headers = { Authorization: `Bearer ${t}` };
    const stamp = Date.now();
    const res = await request.post(`${API}/suppliers`, {
      headers, data: { name: `Input Supplier ${stamp}`, country: 'AE' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    await login(page);
    await page.goto(`${BASE}/en/purchases`);
    await page.getByRole('button', { name: /new purchase order/i }).click();
    await page.getByRole('button', { name: /add item/i }).click();

    const orderedQty = rowInputs(page).first();

    // Give it a real value first. A field showing 0 cannot prove anything
    // here: typing 9 without selecting makes "09", and the onChange runs it
    // through Number(), which turns that back into 9 — so the test would pass
    // whether the selection happened or not. It has to start at something a
    // stray keystroke would visibly corrupt.
    await orderedQty.click();
    await page.keyboard.type('250');
    await expect(orderedQty).toHaveValue('250');

    await orderedQty.blur();
    await orderedQty.click();
    await page.keyboard.type('9');
    await expect(orderedQty).toHaveValue('9');
  });
});

test.describe('Amount fields read as money while they are typed', () => {
  test('TC-MONEY-01: separators appear as the number grows', async ({ page }) => {
    // 1512.91 is a number; 1,512.91 is an amount. Without the grouping a
    // mistyped 15129.1 looks much like 1512.91 at a glance.
    await login(page);
    await openOrderWithARow(page);

    const price = page.locator('input[inputmode="decimal"]').first();
    await price.click();
    await page.keyboard.type('1234567.89');
    await expect(price).toHaveValue('1,234,567.89');
  });

  test('TC-MONEY-02: the caret stays with the digit when a comma appears', async ({ page }) => {
    // Reformatting on every keystroke moves everything after the inserted
    // comma. Restoring the caret by character position puts it in the wrong
    // place; it has to be restored by counting digits.
    await login(page);
    await openOrderWithARow(page);

    const price = page.locator('input[inputmode="decimal"]').first();
    await price.click();
    await page.keyboard.type('1234567.89');

    // Put the caret after "1,234" and type a digit.
    await price.evaluate((el: HTMLInputElement) => el.setSelectionRange(5, 5));
    await page.keyboard.type('9');

    await expect(price).toHaveValue('12,349,567.89');
    const before = await price.evaluate(
      (el: HTMLInputElement) => el.value.slice(0, el.selectionStart ?? 0),
    );
    expect(before).toBe('12,349');
  });

  test('TC-MONEY-03: the form submits a plain number, not the formatted text', async ({
    page,
  }) => {
    // The separators are for reading. Anything sending "25,000.50" to the API
    // would have it parsed as 25 or rejected outright.
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.getByRole('button', { name: /record payment/i }).click();

    const amount = page.locator('input[inputmode="decimal"]').first();
    await amount.click();
    await page.keyboard.type('25000.50');
    await expect(amount).toHaveValue('25,000.50');

    const submitted = await page
      .locator('input[type="hidden"][name="amount"]')
      .inputValue();
    expect(submitted).toBe('25000.50');
  });

  test('TC-MONEY-04: letters and stray punctuation are ignored', async ({ page }) => {
    await login(page);
    await openOrderWithARow(page);

    const price = page.locator('input[inputmode="decimal"]').first();
    await price.click();
    await page.keyboard.type('12a3b4.5c6');
    await expect(price).toHaveValue('1,234.56');
  });

  test('TC-MONEY-05: a second decimal point is refused', async ({ page }) => {
    // "12.34.56" is not a number, and silently keeping the first part is
    // better than sending something unparseable.
    await login(page);
    await openOrderWithARow(page);

    const price = page.locator('input[inputmode="decimal"]').first();
    await price.click();
    await page.keyboard.type('12.34.56');
    await expect(price).toHaveValue('12.34');
  });
});
