/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Sales and Payments — a date range, and a CSV of what it shows
 * ═══════════════════════════════════════════════════════════════════════
 *  Improvement batch I1 (2026-10-11). Both lists take a From / To pair of the
 *  shared date pickers; the API filters (the day ordered, the day received —
 *  both ends included, days in Cairo) and refuses a reversed range with
 *  DATE_RANGE_REVERSED. Export writes every row the filters show — every page,
 *  not the ten on screen.
 *
 *  Reached by clicking, as a person does (CLAUDE.md §2): the menu, the picker,
 *  the calendar day, the Export button; the file is read back from the
 *  download, not from the API underneath.
 */
import { readFileSync } from 'fs';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import en from '../src/i18n/locales/en.json';
import ar from '../src/i18n/locales/ar.json';
import { API, apiCtx, EMAIL, PASSWORD, owedOrder, stockedProduct } from './support/fixtures';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';

/** A calendar day `n` days from today, local, YYYY-MM-DD. */
function day(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 20000 });
}

/** From the menu, by clicking. */
async function open(page: Page, path: 'sales' | 'payments') {
  await page.locator(`aside a[href="/en/${path}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/en/${path}$`), { timeout: 15000 });
}

/** Open a picker, step to the month, click the day — as a person picks one. */
async function pickDate(page: Page, name: string, iso: string) {
  await page.locator(`[data-date-picker="${name}"]`).click();
  const grid = page.getByRole('grid');
  await grid.waitFor({ state: 'visible' });
  for (let i = 0; i < 36; i++) {
    const shown = await grid.locator('[data-day]:not([data-outside])').first().getAttribute('data-day');
    const shownMonth = (shown ?? '').slice(0, 7);
    if (shownMonth === iso.slice(0, 7)) break;
    await page.getByTestId(shownMonth < iso.slice(0, 7) ? 'calendar-next' : 'calendar-prev').click();
  }
  await grid.locator(`[data-day="${iso}"]:not([data-outside])`).click();
  await expect(page.locator(`input[type="hidden"][name="${name}"]`)).toHaveValue(iso);
}

/** Click Export and read the file that arrives: [header, ...rows] as cells. */
async function exportCsv(page: Page, testId: string): Promise<string[][]> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId(testId).click()]);
  const path = await download.path();
  const text = readFileSync(path!, 'utf8').replace(/^﻿/, '');
  // The cells here carry no commas or quotes, so a plain split is exact.
  return text.split('\r\n').filter(Boolean).map((line) => line.split(','));
}

/** A shop owing on `orders` confirmed sales placed today. */
async function shopWithSales(request: APIRequestContext, label: string, orders: number) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${label}${Date.now()}`;
  const { product } = await stockedProduct(request, headers, mk, stamp, orders + 5);
  const customer = await mk('customers', { displayName: `${stamp} Shop`, type: 'B2B' });
  const made = [];
  for (let i = 0; i < orders; i++) made.push(await owedOrder(mk, customer.id, product.id, 1000 + i));
  return { headers, mk, stamp, customer, orders: made };
}

test.describe('Sales and Payments: date range and CSV (I1)', () => {
  test('TC-DR-01: Sales — the range filters, Export writes every page of it, and a second filter exports the second view', async ({
    page,
    request,
  }) => {
    // 13 orders: more than one page of ten.
    const { stamp, orders } = await shopWithSales(request, 'DRS', 13);
    await login(page);
    await open(page, 'sales');
    await page.getByPlaceholder(en.sales.search).fill(stamp);

    await pickDate(page, 'salesFrom', day(0));
    await pickDate(page, 'salesTo', day(0));
    await expect(page.getByTestId('sale-row')).toHaveCount(10);

    const rows = await exportCsv(page, 'sales-export');
    expect(rows[0]).toEqual([
      en.sales.orderNo, en.sales.date, en.sales.customer, en.sales.channel, en.common.status,
      en.sales.currency, en.sales.total, en.sales.outstanding,
    ]);
    const body = rows.slice(1);
    expect(body).toHaveLength(13);
    expect(body.map((r) => r[0]).sort()).toEqual(orders.map((o: { orderNo: string }) => o.orderNo).sort());
    expect(body.every((r) => r[1] === day(0))).toBe(true);
    // Money as numbers a spreadsheet can sum: 1000 + … + 1012.
    expect(body.reduce((s, r) => s + Number(r[6]), 0)).toBe(13 * 1000 + 78);

    // A range with none of them: nothing shown, Export has nothing to write.
    await page.getByTestId('sales-dates-clear').click();
    await pickDate(page, 'salesFrom', day(-3));
    await pickDate(page, 'salesTo', day(-2));
    await expect(page.getByTestId('sale-row')).toHaveCount(0);
    await expect(page.getByTestId('sales-export')).toBeDisabled();

    // The way back clears the dates and the search together.
    await page.getByRole('button', { name: en.common.clearSearchAndFilters }).first().click();
    await expect(page.locator('input[type="hidden"][name="salesFrom"]')).toHaveValue('');
    await expect(page.getByPlaceholder(en.sales.search)).toHaveValue('');

    // Second time round: today again, exported again — the same 13, not a stale empty file.
    await page.getByPlaceholder(en.sales.search).fill(stamp);
    await pickDate(page, 'salesFrom', day(0));
    expect((await exportCsv(page, 'sales-export')).slice(1)).toHaveLength(13);
  });

  test('TC-DR-02: Payments — the day received decides, both ends included, and Export follows the filter', async ({
    page,
    request,
  }) => {
    const { mk, stamp, customer } = await shopWithSales(request, 'DRP', 2);
    await mk('payments', { customerId: customer.id, amount: 100, currency: 'EGP', method: 'CASH', receivedOn: day(-10) });
    await mk('payments', { customerId: customer.id, amount: 200, currency: 'EGP', method: 'CASH', receivedOn: day(0) });

    await login(page);
    await open(page, 'payments');
    await page.getByPlaceholder(en.payments.search).fill(stamp);

    // One day, the older one: only the 100.
    await pickDate(page, 'paymentsFrom', day(-10));
    await pickDate(page, 'paymentsTo', day(-10));
    let rows = (await exportCsv(page, 'payments-export')).slice(1);
    expect(rows.map((r) => [r[0], r[2]])).toEqual([[day(-10), '100']]);

    // Widen the end to today: both, since both ends are included.
    await pickDate(page, 'paymentsTo', day(0));
    rows = (await exportCsv(page, 'payments-export')).slice(1);
    expect(rows.map((r) => Number(r[2])).sort((a, b) => a - b)).toEqual([100, 200]);

    // From the day after the older one: only today's.
    await page.getByTestId('payments-dates-clear').click();
    await pickDate(page, 'paymentsFrom', day(-9));
    rows = (await exportCsv(page, 'payments-export')).slice(1);
    expect(rows.map((r) => r[2])).toEqual(['200']);
  });

  test('TC-DR-03: a reversed range cannot be picked — To offers nothing before From, From nothing after To', async ({ page }) => {
    await login(page);
    await open(page, 'sales');

    await pickDate(page, 'salesFrom', day(-5));
    await page.locator('[data-date-picker="salesTo"]').click();
    const grid = page.getByRole('grid');
    // Days before From are disabled; From itself is allowed (both ends included).
    for (const n of [-6, -7]) {
      const cell = grid.locator(`[data-day="${day(n)}"]`).first();
      if (await cell.count()) await expect(cell).toBeDisabled();
    }
    await expect(grid.locator(`[data-day="${day(-5)}"]`).first()).toBeEnabled();
    await page.keyboard.press('Escape');

    await pickDate(page, 'salesTo', day(-5));
    await page.locator('[data-date-picker="salesFrom"]').click();
    const after = page.getByRole('grid').locator(`[data-day="${day(-4)}"]`).first();
    if (await after.count()) await expect(after).toBeDisabled();
  });

  test('TC-DR-04: the server refuses a reversed range and a non-date on both lists, with a code said in both languages; an investor is refused', async ({
    request,
  }) => {
    const { headers } = await apiCtx(request);
    for (const path of ['sales/orders', 'payments']) {
      const reversed = await request.get(`${API}/${path}?from=2026-09-10&to=2026-09-01`, { headers });
      expect(reversed.status()).toBe(400);
      expect((await reversed.json()).error).toMatchObject({
        code: 'DATE_RANGE_REVERSED',
        params: { from: '2026-09-10', to: '2026-09-01' },
      });

      const notADay = await request.get(`${API}/${path}?from=2026-02-30`, { headers });
      expect(notADay.status()).toBe(400);
      expect((await notADay.json()).error.code).toBe('BAD_DATE');

      // The same day as both ends is a range, not a reversal.
      expect((await request.get(`${API}/${path}?from=${day(0)}&to=${day(0)}`, { headers })).status()).toBe(200);
    }
    for (const code of ['DATE_RANGE_REVERSED', 'BAD_DATE'] as const) {
      expect(en.errors[code]).toBeTruthy();
      expect(ar.errors[code]).toBeTruthy();
      expect(ar.errors[code]).not.toBe(en.errors[code]);
    }

    // Customer money is the office's: an investor cannot list it by date either (§12).
    const login = await request.post(`${API}/auth/login`, {
      data: { email: 'investor@motoparts.com', password: PASSWORD },
    });
    const investor = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
    for (const path of ['sales/orders', 'payments']) {
      const res = await request.get(`${API}/${path}?from=${day(-30)}&to=${day(0)}`, { headers: investor });
      expect([path, res.status()]).toEqual([path, 403]);
      expect((await res.json()).error.code).toBe('ROLE_NOT_ALLOWED');
    }
  });

  test('TC-DR-05: in Arabic the pickers and Export speak Arabic', async ({ page }) => {
    await page.goto(`${BASE}/ar/login`);
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/dashboard/, { timeout: 20000 });
    await page.locator('aside a[href="/ar/payments"]').click();
    await expect(page).toHaveURL(/\/ar\/payments$/, { timeout: 15000 });

    await expect(page.locator('[data-date-picker="paymentsFrom"]')).toHaveAccessibleName(ar.common.dateFrom);
    await expect(page.locator('[data-date-picker="paymentsTo"]')).toHaveAccessibleName(ar.common.dateTo);
    await expect(page.getByTestId('payments-export')).toContainText(ar.common.export);
  });
});

// I2 (from I1): a new date range used to swap the table for a spinner and
// back. The rows on screen now stay, dimmed and marked busy, until the new
// range arrives. The range's request is held so the in-between is visible.
for (const path of ['sales', 'payments'] as const) {
  test(`TC-DR-0${path === 'sales' ? 7 : 8}: ${path} — while a new range loads, the rows already shown stay, dimmed, with a busy sign`, async ({
    page,
    request,
  }) => {
    const { stamp, customer, mk } = await shopWithSales(request, `DRK${path[0]}`, 2);
    if (path === 'payments') {
      await mk('payments', { customerId: customer.id, amount: 100, currency: 'EGP', applyOldestFirst: true });
    }
    await login(page);
    await open(page, path);
    const search = path === 'sales' ? en.sales.search : en.payments.search;
    await page.getByPlaceholder(search).fill(stamp);
    const rows = page.getByTestId(`${path}-table`).locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();

    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const pattern = path === 'sales' ? '**/sales/orders?*from=*' : '**/payments?*from=*';
    await page.route(pattern, async (route) => {
      await held;
      await route.continue();
    });
    await pickDate(page, `${path}From`, day(0));
    await expect(page.getByTestId(`${path}-reloading`)).toBeVisible();
    await expect(page.getByTestId(`${path}-table`)).toHaveAttribute('aria-busy', 'true');
    await expect(rows).toHaveCount(before);
    release();
    await expect(page.getByTestId(`${path}-reloading`)).toBeHidden();
    await expect(page.getByTestId(`${path}-table`)).toHaveAttribute('aria-busy', 'false');
    await expect(rows).toHaveCount(before);
    await page.unroute(pattern);
  });
}
