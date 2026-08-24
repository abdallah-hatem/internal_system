/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Shared UI controls
 * ═══════════════════════════════════════════════════════════════════════
 *  The Select replaced every native <select> — long entity lists and short
 *  fixed enums alike — the DatePicker replaced native <input type="date">, and
 *  money is rendered through one component so Decimal values arriving as
 *  strings still format. All three are easy to regress silently.
 */
import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test.describe('Searchable select', () => {
  // The product category filter, not the settlement cycle picker: the seed
  // creates five categories but only two cycles, and a two-option list is
  // deliberately rendered without a search box. Anchor the search tests on a
  // list that is long enough by construction.
  const CATEGORY_FILTER = '#category-filter';

  async function openCategories(page: Page) {
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.locator(CATEGORY_FILTER).click();
    await expect(page.getByRole('listbox')).toBeVisible();
  }

  /** The panel's own search box — the page has search inputs of its own. */
  function panelSearch(page: Page) {
    return page.locator('[data-slot="command-input"]');
  }

  test('TC-UI-01: opening focuses the search box so you can type straight away', async ({ page }) => {
    await openCategories(page);
    await expect(panelSearch(page)).toBeFocused();
  });

  test('TC-UI-02: typing filters the list', async ({ page }) => {
    await openCategories(page);

    const before = await page.getByRole('listbox').getByRole('option').count();
    expect(before).toBeGreaterThan(1);

    await panelSearch(page).fill('Brake');
    await expect.poll(() => page.getByRole('listbox').getByRole('option').count()).toBeLessThan(before);
    await expect(page.getByRole('listbox').getByRole('option').first()).toContainText('Brake Parts');
  });

  test('TC-UI-03: a search matching nothing says so instead of showing an empty box', async ({ page }) => {
    await openCategories(page);
    await panelSearch(page).fill('zzzz-no-such-category');

    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0);
    await expect(page.getByText(/no matches/i)).toBeVisible();
  });

  test('TC-UI-04: arrow keys and Enter pick an option without the mouse', async ({ page }) => {
    await openCategories(page);
    const trigger = page.locator(CATEGORY_FILTER); // `id` lands on the trigger button

    // "Parts" leaves more than one match, so ArrowDown has somewhere to go.
    await panelSearch(page).fill('Parts');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(trigger).toContainText(/Parts/);
  });

  test('TC-UI-05: Escape closes the list and keeps the previous value', async ({ page }) => {
    await openCategories(page);
    const trigger = page.locator(CATEGORY_FILTER); // `id` lands on the trigger button

    await panelSearch(page).fill('Parts');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const chosen = (await trigger.textContent())?.trim();

    await trigger.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    expect((await trigger.textContent())?.trim()).toBe(chosen);
  });

  test('TC-UI-06: clicking outside closes the list', async ({ page }) => {
    await openCategories(page);
    await page.locator('h1').first().click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
  });
});

test.describe('Money rendering', () => {
  test('TC-UI-07: amounts carry thousands separators and two decimals', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/sales`);

    // Decimal values arrive from the API as strings; calling toLocaleString on
    // a string returns it unchanged, which is how "199999800 EGP" reached the
    // page. Every amount must show grouped digits and exactly two decimals.
    const amounts = page.locator('text=/\\d[\\d,]*\\.\\d{2}\\s*EGP/');
    await expect.poll(() => amounts.count(), { timeout: 10000 }).toBeGreaterThan(0);

    const unformatted = page.locator('text=/\\b\\d{5,}\\s*EGP/');
    expect(await unformatted.count()).toBe(0);
  });

  test('TC-UI-08: Arabic keeps amounts left-to-right', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/sales`);

    // In an RTL paragraph a bidi-neutral run drifts; money must stay isolated
    // or "1,234.00 EGP" renders with the currency on the wrong side.
    const money = page.locator('[dir="ltr"]').first();
    await expect(money).toBeVisible();
  });
});

test.describe('Date picker', () => {
  /** Open the Record Payment modal, which carries the required `receivedOn` date. */
  async function openPaymentForm(page: Page) {
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.getByRole('button', { name: /Record Payment|New|Create/i }).first().click();
    await expect(page.locator('[data-date-picker="receivedOn"]')).toBeVisible({ timeout: 10000 });
  }

  test('TC-UI-09: the field starts empty and opens the app calendar, not the browser one', async ({ page }) => {
    await openPaymentForm(page);

    // A native date input would still be in the DOM; the value has to travel in
    // a hidden input for FormData to keep working.
    expect(await page.locator('input[type="date"]').count()).toBe(0);
    await expect(page.locator('input[type="hidden"][name="receivedOn"]')).toHaveValue('');

    await page.locator('[data-date-picker="receivedOn"]').click();
    await expect(page.getByRole('grid')).toBeVisible();
    // 6 rows of 7 so the panel does not resize between months.
    await expect(page.getByRole('gridcell')).toHaveCount(42);
  });

  test('TC-UI-10: picking a day fills the value and closes the panel', async ({ page }) => {
    await openPaymentForm(page);
    await page.locator('[data-date-picker="receivedOn"]').click();

    const grid = page.getByRole('grid');
    const day = grid.locator('[data-day]:not([data-outside])').nth(9);
    const iso = await day.getAttribute('data-day');
    await day.click();

    await expect(page.locator('input[type="hidden"][name="receivedOn"]')).toHaveValue(iso!);
    await expect(grid).toHaveCount(0);
  });

  test('TC-UI-11: "Today" fills today, and the month can be jumped without stepping', async ({ page }) => {
    await openPaymentForm(page);
    await page.locator('[data-date-picker="receivedOn"]').click();
    await page.getByTestId('date-picker-today').click();

    const today = new Date();
    const iso = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;
    await expect(page.locator('input[type="hidden"][name="receivedOn"]')).toHaveValue(iso);

    // The header label is a switcher: 12 months at once beats 11 clicks.
    await page.locator('[data-date-picker="receivedOn"]').click();
    await page.getByTestId('calendar-switch').click();
    await page.getByTestId('calendar-month-0').click();
    await expect(page.getByRole('grid')).toHaveAttribute('aria-label', /January/i);
  });

  test('TC-UI-12: arrow keys walk the grid and Enter picks the focused day', async ({ page }) => {
    await openPaymentForm(page);
    await page.locator('[data-date-picker="receivedOn"]').click();

    const grid = page.getByRole('grid');
    const start = grid.locator('[data-day][tabindex="0"]');
    const startIso = await start.getAttribute('data-day');
    await start.focus();
    await page.keyboard.press('ArrowRight');

    const expected = new Date(`${startIso}T00:00:00`);
    expected.setDate(expected.getDate() + 1);
    const expectedIso = `${expected.getFullYear()}-${`${expected.getMonth() + 1}`.padStart(2, '0')}-${`${expected.getDate()}`.padStart(2, '0')}`;

    await expect(grid.locator('[data-day][tabindex="0"]')).toHaveAttribute('data-day', expectedIso);
    await page.keyboard.press('Enter');
    await expect(page.locator('input[type="hidden"][name="receivedOn"]')).toHaveValue(expectedIso);
  });

  test('TC-UI-13: Arabic gets Arabic month names and a mirrored grid', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/ar/payments`);
    await page.getByRole('button', { name: /Record Payment|New|Create|تسجيل|إضافة/i }).first().click();
    await page.locator('[data-date-picker="receivedOn"]').click();

    const calendar = page.locator('[dir="rtl"]').filter({ has: page.getByRole('grid') }).first();
    await expect(calendar).toBeVisible();
    await expect(page.getByTestId('calendar-switch')).toHaveText(/[\u0600-\u06FF]/);
  });
});

test.describe('Select — short lists', () => {
  /** The Record Payment modal carries a three-currency Select and a three-method one. */
  async function openPaymentForm(page: Page) {
    await login(page);
    await page.goto(`${BASE}/en/payments`);
    await page.getByRole('button', { name: /Record Payment|New|Create/i }).first().click();
    await expect(page.locator('input[type="hidden"][name="currency"]')).toBeAttached({ timeout: 10000 });
  }

  function trigger(page: Page, name: string) {
    return page.locator(`input[type="hidden"][name="${name}"]`).locator('..').getByRole('combobox');
  }

  test('TC-UI-14: no native <select> is left on a form', async ({ page }) => {
    await openPaymentForm(page);
    expect(await page.locator('select').count()).toBe(0);
  });

  test('TC-UI-15: a three-option list opens without a search box', async ({ page }) => {
    await openPaymentForm(page);
    await trigger(page, 'currency').click();

    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(3);
    // Searching three currencies is slower than reading them.
    expect(await page.locator('[data-slot="command-input"]').count()).toBe(0);
  });

  test('TC-UI-16: a long list still gets its search box', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page.locator('#category-filter').click();

    expect(await page.getByRole('listbox').getByRole('option').count()).toBeGreaterThan(3);
    expect(await page.locator('[data-slot="command-input"]').count()).toBe(1);
  });

  test('TC-UI-17: without a search box the arrow keys still work', async ({ page }) => {
    await openPaymentForm(page);
    // Nothing inside the panel is tabbable when there is no search input, so
    // this is really a test that focus lands somewhere cmdk can hear.
    await trigger(page, 'currency').click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await expect(page.locator('input[type="hidden"][name="currency"]')).toHaveValue('USD');
    await expect(trigger(page, 'currency')).toContainText('USD');
  });

  test('TC-UI-19: an empty required picker blocks submit and says why', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/cycles/new`);
    await page.getByRole('button', { name: /save & continue/i }).click();

    // The value lives in a hidden input. If its required-mirror has no box, the
    // browser blocks the submit, cannot focus the field, and gives up silently —
    // the button reads as broken. Both required pickers must own up instead.
    await expect(page.locator('[data-slot="select-error"]')).toHaveCount(2);
    await expect(page.getByText('Cycle Information')).toBeVisible();

    // …and the message clears as soon as the field is answered.
    await page.locator('input[type="hidden"][name="originType"]').locator('..').getByRole('combobox').click();
    await page.getByRole('listbox').getByRole('option').first().click();
    await expect(page.locator('[data-slot="select-error"]')).toHaveCount(1);
  });

  test('TC-UI-18: a short list keeps the value the native select would have submitted', async ({ page }) => {
    await openPaymentForm(page);
    // The native <select> submitted its first option when untouched; the
    // replacement has to start on that same value, not empty.
    await expect(page.locator('input[type="hidden"][name="currency"]')).toHaveValue('EGP');
    await expect(page.locator('input[type="hidden"][name="method"]')).toHaveValue('CASH');
  });
});
