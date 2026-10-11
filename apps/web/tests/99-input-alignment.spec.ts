/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: amounts typed into a field sit at its start
 * ═══════════════════════════════════════════════════════════════════════
 *  Owner, 2026-10-11: Record payment showed "90,000.00" at the right edge of
 *  its field in English. A typed amount or quantity sits at the start, like
 *  every other field — left in English, right in Arabic. Figures in tables and
 *  summaries stay end-aligned; this is about inputs only.
 *
 *  One rule in app/globals.css does it (unit/input-alignment.test.mjs pins the
 *  rule and the source). This reads what a person sees: each screen reached by
 *  clicking, at 1440 and 390, in English and Arabic, and the side every
 *  numeric field's text actually starts on.
 *
 *  `L3_SHOTS=1` also saves each screen to .ui-audit/l3/ for review.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { apiCtx, daysAgo } from './support/fixtures';
import { login, messages, type Locale } from './support/ui';

const SHOTS = process.env.L3_SHOTS === '1';
const SHOT_DIR = '../../.ui-audit/l3';
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const;

const NUMERIC = 'input:is([inputmode="decimal"], [inputmode="numeric"], [type="number"])';

/** The physical side each visible numeric field's text starts on. */
async function sides(scope: Locator) {
  return scope.locator(NUMERIC).evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => {
        const s = getComputedStyle(el);
        const a = s.textAlign;
        const rtl = s.direction === 'rtl';
        const side =
          a === 'left' || a === 'right'
            ? a
            : a === 'start'
              ? rtl ? 'right' : 'left'
              : a === 'end'
                ? rtl ? 'left' : 'right'
                : a;
        return `${(el as HTMLInputElement).id || (el as HTMLInputElement).getAttribute('data-field') || el.tagName}:${side}`;
      }),
  );
}

async function expectStart(scope: Locator, locale: Locale, what: string) {
  const found = await sides(scope);
  expect(found.length, `${what}: no numeric field found`).toBeGreaterThan(0);
  const want = locale === 'ar' ? 'right' : 'left';
  expect(found.filter((f) => !f.endsWith(`:${want}`)), `${what} (${locale})`).toEqual([]);
}

/** The menu as a person uses it: the sidebar at 1440; on a phone the bar, or More and the menu. */
async function go(page: Page, locale: Locale, name: string, phone: boolean) {
  const m = messages(locale);
  if (phone) {
    const bar = page.getByTestId('phone-bar');
    const inBar = bar.getByRole('link', { name, exact: true });
    if ((await inBar.count()) > 0) {
      await inBar.click();
    } else {
      // In Arabic, More sits bottom-left — under the dev server's own Next.js
      // badge, which takes the pointer. Not part of the app; tap past it.
      await bar.getByRole('button', { name: m.nav.more, exact: true }).dispatchEvent('click');
      const link = page.locator('aside').getByRole('link', { name, exact: true });
      await link.scrollIntoViewIfNeeded();
      await link.click();
    }
  } else {
    await page.locator('aside').getByRole('link', { name, exact: true }).click();
  }
  await page.waitForLoadState('networkidle');
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });
}

async function world(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const s = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const shop = await mk('customers', { displayName: `Align ${s} Shop`, type: 'B2B' });
  const product = await mk('products', { name: `Align ${s} Exhaust`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `Align ${s} Dubai Trading`, country: 'AE' });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
  const po = await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'AED', fxRateToEgp: 13, orderedOn: daysAgo(30),
    items: [{ productId: product.id, orderedQty: 100, unitPrice: 300 }],
  });
  const lender = await mk('lenders', { name: `Align ${s} Friend` });
  await mk(`purchases/${po.id}/financings`, { lenderId: lender.id, amount: 1000, paidOn: daysAgo(20) });
  return { headers, shop, lender };
}

for (const locale of ['en', 'ar'] as Locale[]) {
  for (const size of SIZES) {
    test(`TC-ALIGN-${locale}-${size.name}: Record payment, the sale form, purchases, the wizard, a friend's repayment and the statement — every typed amount starts at the start`, async ({ page, request }) => {
      test.setTimeout(120_000);
      const m = messages(locale);
      const { shop, lender } = await world(request);
      await page.setViewportSize({ width: size.width, height: size.height });
      await login(page, locale);
      const tag = `${locale}-${size.name}`;
      const phone = size.width < 768;

      // Customers → the shop → Record payment, with an amount typed.
      await go(page, locale, m.nav.customers, phone);
      const main = page.getByRole('main');
      await main.getByPlaceholder(m.customers.search).fill(shop.displayName);
      await main.getByRole('link', { name: shop.displayName, exact: true }).filter({ visible: true }).first().click();
      await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/, { timeout: 15000 });
      await expect(page.getByTestId('customer-statement')).toBeVisible();
      await page.getByTestId('customer-statement').scrollIntoViewIfNeeded();
      await shot(page, `statement-${tag}`);
      await main.getByRole('button', { name: m.payments.create, exact: true }).filter({ visible: true }).first().click();
      const pay = page.locator('[data-record-payment-dialog]');
      await expect(pay).toBeVisible();
      const amount = pay.locator(NUMERIC).first();
      await amount.click();
      await page.keyboard.type('90000');
      await expect(amount).toHaveValue('90,000');
      await expectStart(pay, locale, 'Record payment');
      await shot(page, `record-payment-${tag}`);
      await page.keyboard.press('Escape');
      await expect(pay).toHaveCount(0);

      // The sale form, from the same page.
      await main.getByRole('button', { name: m.sales.create, exact: true }).filter({ visible: true }).first().click();
      const sale = page.getByTestId('sale-order-form');
      await expect(sale).toBeVisible({ timeout: 15000 });
      await expectStart(sale, locale, 'Sale form');
      await shot(page, `sale-form-${tag}`);
      await sale.getByRole('button', { name: m.common.cancel, exact: true }).click();
      await expect(sale).toHaveCount(0);

      // Purchases → New Purchase Order.
      await go(page, locale, m.nav.purchases, phone);
      await page.getByTestId('create-action').filter({ visible: true }).first().click();
      // The modal is the only place on this page with numeric fields.
      const po = page.locator('body');
      await page.getByRole('button', { name: m.purchases.addItem }).filter({ visible: true }).first().click();
      await expect(po.locator(NUMERIC).nth(1)).toBeVisible();
      await expectStart(po, locale, 'New purchase order');
      await shot(page, `purchase-${tag}`);
      await page.getByRole('button', { name: m.common.cancel, exact: true }).filter({ visible: true }).first().click();
      await expect(po.locator(NUMERIC)).toHaveCount(0);

      // Import Cycles → New Cycle: the wizard's first step.
      await go(page, locale, m.nav.cycles, phone);
      await page.getByRole('main').getByRole('button', { name: m.cycles.create }).or(page.getByRole('main').getByRole('link', { name: m.cycles.create })).filter({ visible: true }).first().click();
      // Step 1 asks no number; its route and currency, then the order step's lines.
      for (const name of ['originType', 'currency']) {
        await page.locator(`input[type="hidden"][name="${name}"]`).locator('..').getByRole('combobox').click();
        await page.getByRole('listbox').getByRole('option').first().click();
        await expect(page.getByRole('listbox')).toHaveCount(0);
      }
      await page.getByRole('main').getByRole('button', { name: m.wizard.saveAndContinueBtn }).click();
      // Step 2 opens with one line ready: its quantity and price.
      await expect(page.getByTestId('wizard-line-item')).toHaveCount(1, { timeout: 15000 });
      await expectStart(page.getByRole('main'), locale, 'Wizard');
      await shot(page, `wizard-${tag}`);

      // Lenders → the friend → Record repayment.
      await go(page, locale, m.nav.lenders, phone);
      await page.getByRole('main').getByText(lender.name, { exact: true }).filter({ visible: true }).first().click();
      await page.getByTestId('record-repayment').first().click();
      const repay = page.getByTestId('record-repayment-dialog');
      await expect(repay).toBeVisible();
      await repay.locator('#repayment-amount').click();
      await page.keyboard.type('50000');
      await expectStart(repay, locale, "A friend's repayment");
      await shot(page, `repayment-${tag}`);
    });
  }
}
