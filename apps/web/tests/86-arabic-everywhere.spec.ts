/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Arabic everywhere (U5, UX #10 and #12)
 * ═══════════════════════════════════════════════════════════════════════
 *  An Arabic reader used to meet English on every page: status codes printed
 *  raw (`CREATE`, `PARTIALLY_PAID`), dates in English, "Customer created
 *  successfully", the browser's own "Please fill out this field", and
 *  notifications stored as English sentences.
 *
 *  Every check here reaches the screen the way a person does — by clicking
 *  through the Arabic app — and asserts on the Arabic they would read
 *  (CLAUDE.md rule 2).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json';
import { WEB as BASE, API } from './support/env';

const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

const ARABIC_MONTHS =
  /يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر/;
const ENGLISH_MONTH = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;

async function loginArabic(page: Page) {
  await page.goto(`${BASE}/ar/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.getByRole('button').filter({ hasText: /.+/ }).last().click();
  await expect(page).toHaveURL(/\/ar\/dashboard/, { timeout: 10000 });
}

async function auth(request: APIRequestContext) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

/** A real cycle, through the service — it writes an audit row and a notification. */
async function createCycle(request: APIRequestContext): Promise<string> {
  const h = await auth(request);
  const res = await request.post(`${API}/cycles`, {
    headers: h,
    data: { originType: 'CHINA', currency: 'USD' },
  });
  expect(res.ok(), 'creating a cycle').toBeTruthy();
  return (await res.json()).data.code as string;
}

/** Through the sidebar, as a person gets there — not page.goto. */
async function openFromMenu(page: Page, label: string) {
  await page.getByRole('link', { name: label, exact: true }).first().click();
}

test.describe('Arabic everywhere', () => {
  test('TC-AR-01: a status chip and a date read in Arabic (audit log)', async ({ page, request }) => {
    await createCycle(request);
    await loginArabic(page);
    await openFromMenu(page, ar.nav.auditLogs);
    await expect(page).toHaveURL(/\/ar\/audit-logs/);

    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible();
    // The action chip: "إنشاء", never the raw CREATE.
    await expect(page.locator('table').getByText(ar.codes.auditAction.CREATE).first()).toBeVisible();
    await expect(page.locator('table')).not.toContainText('CREATE');
    // The entity reads as a word too.
    await expect(page.locator('table').getByText(ar.codes.entityType.ImportCycle).first()).toBeVisible();

    const when = (await firstRow.locator('td').first().innerText()).trim();
    expect(when).toMatch(ARABIC_MONTHS);
    expect(when).not.toMatch(ENGLISH_MONTH);
  });

  test('TC-AR-02: an empty form shows the app’s Arabic message, not the browser’s', async ({ page }) => {
    await loginArabic(page);
    await openFromMenu(page, ar.nav.customers);
    await page.getByRole('button', { name: ar.customers.create }).click();

    const form = page.locator('form').filter({ has: page.locator('input[name="displayName"]') });
    await expect(form).toHaveAttribute('novalidate', '');
    await form.getByRole('button', { name: ar.common.create }).click();

    await expect(form.getByRole('alert')).toHaveText(
      ar.validation.requiredNamed.replace('{fields}', ar.customers.name),
    );
    await expect(form.locator('input[name="displayName"]')).toHaveAttribute('aria-invalid', 'true');
  });

  test('TC-AR-03: the toast after saving reads in Arabic', async ({ page }) => {
    await loginArabic(page);
    await openFromMenu(page, ar.nav.customers);
    await page.getByRole('button', { name: ar.customers.create }).click();

    const form = page.locator('form').filter({ has: page.locator('input[name="displayName"]') });
    await form.locator('input[name="displayName"]').fill(`محل الاختبار ${Date.now()}`);
    await form.getByRole('button', { name: ar.common.create }).click();

    await expect(page.getByText(ar.customers.createSuccess)).toBeVisible();
    await expect(page.getByText('Customer created successfully')).toHaveCount(0);
  });

  test('TC-AR-04: an empty list says so in Arabic', async ({ page }) => {
    await loginArabic(page);
    await openFromMenu(page, ar.nav.customers);
    await page.getByPlaceholder(ar.customers.search).fill('لا-يوجد-عميل-بهذا-الاسم-zzz');

    await expect(page.getByText(ar.common.noMatch).first()).toBeVisible();
    await expect(page.getByText('No data available')).toHaveCount(0);
  });

  test('TC-AR-05: a new notification reads in Arabic in the bell', async ({ page, request }) => {
    const code = await createCycle(request);
    await loginArabic(page);

    await page.getByRole('button', { name: new RegExp(ar.notifications.title) }).click();
    const expected = ar.notifications.CYCLE_CREATED.replace('{cycleCode}', code);
    await expect(page.getByRole('dialog').getByText(expected)).toBeVisible();
    await expect(page.getByRole('dialog')).not.toContainText(`New import cycle ${code} created`);
  });
});
