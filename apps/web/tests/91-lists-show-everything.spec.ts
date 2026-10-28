/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: A list page shows every record, or says it does not (L1)
 * ═══════════════════════════════════════════════════════════════════════
 *  The office list pages search and page on the client, over what they
 *  fetched. Most of them fetched the API's default page — 20 rows, newest
 *  first — so the 21st-newest purchase order, product, cycle, sale, payment
 *  or ledger entry was not on its page at all, and typing its reference into
 *  the search box found nothing. Suppliers and customers asked for 200, which
 *  only moved the wall. The record existed; the screen said it did not.
 *
 *  Each test makes the record it will look for FIRST, then enough newer ones
 *  to push it past the old page (25 past a page of 20; 201 past a page of
 *  200, for the two lists ordered or capped that way). It then signs in,
 *  reaches the list by clicking the menu as a person would, searches for the
 *  record and expects to see it. Against the old pages every one of these
 *  fails: the row was never fetched.
 *
 *  Every row is built through the API the way the business makes it (rule 4):
 *  a payment needs a customer who owes, which needs a confirmed order, which
 *  needs stock from a received cycle.
 *
 *  Not run at the time of writing (L1 was told not to run Playwright).
 */
import { test, expect, Page } from '@playwright/test';
import { apiCtx, stockedProduct, owedOrder, today, EMAIL, PASSWORD } from './support/fixtures';
import en from '../src/i18n/locales/en.json';
import { WEB as BASE } from './support/env';
import { openView, showAllSales } from './support/ui';
import { pageOfView } from '../src/lib/page-views';

/** One more than the old default page of 20, with room for rows made in parallel. */
const PAST_20 = 25;
/** One past the 200 the suppliers and customers pages used to ask for. */
const PAST_200 = 201;

test.describe.configure({ timeout: 180_000 });

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** From the menu to a list, by clicking, then type into its search box. */
async function searchList(page: Page, href: string, placeholder: string, text: string) {
  // Purchases is a tab of Cycles since 2026-10-18.
  if (pageOfView(href.slice(1))) {
    await openView(page, href.slice(1));
  } else {
    await page.locator(`aside a[href="/en${href}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/en${href}$`));
  }
  // Sales opens on Confirmed + Partially paid (owner 2026-10-28); these orders are drafts, under All.
  if (href === '/sales') await showAllSales(page);
  await page.getByRole('main').getByPlaceholder(placeholder).fill(text);
}

/** `n` rows made `batch` at a time — sequential is minutes for 201. */
async function many(n: number, make: (i: number) => Promise<unknown>, batch = 1) {
  for (let i = 0; i < n; i += batch) {
    await Promise.all(Array.from({ length: Math.min(batch, n - i) }, (_, j) => make(i + j)));
  }
}

const tagOf = (label: string) => `L1-${label}-${Date.now()}`;

test.describe('L1 — a list shows the record that is not among the newest 20', () => {
  test('TC-LIST-01: products — a product with 25 newer ones is found by its name', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const tag = tagOf('PRD');
    const target = await mk('products', { name: `${tag} Target`, minStock: 0 });
    await many(PAST_20, (i) => mk('products', { name: `${tag} Newer ${i}`, minStock: 0 }));

    await login(page);
    await searchList(page, '/products', en.products.search, target.name);
    await expect(page.getByText(target.name).first()).toBeVisible();
  });

  test('TC-LIST-02: purchases — an order with 25 newer ones is found by its reference', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const tag = tagOf('PO');
    const supplier = await mk('suppliers', { name: `${tag} Supplier`, country: 'AE' });
    const product = await mk('products', { name: `${tag} Part`, minStock: 0 });
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const po = (n: number) =>
      mk(`cycles/${cycle.id}/purchases`, {
        supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: today(),
        items: [{ productId: product.id, orderedQty: n + 1, unitPrice: 10 }],
      });
    const target = await po(0);
    await many(PAST_20, (i) => po(i + 1));

    await login(page);
    await searchList(page, '/purchases', en.purchases.search, target.reference);
    await expect(page.getByText(target.reference).first()).toBeVisible();
  });

  test('TC-LIST-03: cycles — a cycle with 25 newer ones is found by its code', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const target = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await many(PAST_20, () => mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' }));

    await login(page);
    await searchList(page, '/cycles', en.cycles.search, target.code);
    await expect(page.getByText(target.code).first()).toBeVisible();
  });

  test('TC-LIST-04: sales — an order with 25 newer ones is found by its customer', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const tag = tagOf('SO');
    const { product } = await stockedProduct(request, headers, mk, tag, 200);
    const target = await mk('customers', { displayName: `${tag} Target Shop`, type: 'B2B' });
    const filler = await mk('customers', { displayName: `${tag} Busy Shop`, type: 'B2B' });
    const order = (customerId: string) =>
      mk('sales/orders', {
        customerId, channel: 'B2B', currency: 'EGP',
        items: [{ productId: product.id, quantity: 1, unitPrice: 50, discount: 0 }],
      });
    await order(target.id);
    await many(PAST_20, () => order(filler.id));

    await login(page);
    await searchList(page, '/sales', en.sales.search, target.displayName);
    await expect(page.getByText(target.displayName).first()).toBeVisible();
  });

  test('TC-LIST-05: payments — a payment with 25 newer ones is found by its customer', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const tag = tagOf('PAY');
    const { product } = await stockedProduct(request, headers, mk, tag, 10);
    const target = await mk('customers', { displayName: `${tag} Target Shop`, type: 'B2B' });
    const filler = await mk('customers', { displayName: `${tag} Busy Shop`, type: 'B2B' });
    // Both genuinely owe, so every payment below settles something real.
    await owedOrder(mk, target.id, product.id, 500);
    await owedOrder(mk, filler.id, product.id, 5000);
    const pay = (customerId: string, amount: number) =>
      mk('payments', { customerId, amount, currency: 'EGP', method: 'CASH' });
    await pay(target.id, 100);
    await many(PAST_20, () => pay(filler.id, 10));

    await login(page);
    await searchList(page, '/payments', en.payments.search, target.displayName);
    await expect(page.getByText(target.displayName).first()).toBeVisible();
  });

  test('TC-LIST-06: ledger — an entry with 25 newer ones is found by its reason', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const tag = tagOf('LED');
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const entry = (reason: string) =>
      mk('ledger', {
        kind: 'EXPENSE', category: 'extra_freight', amount: 5,
        currency: 'EGP', cycleId: cycle.id, note: reason,
      });
    await entry(`${tag} target freight surcharge`);
    await many(PAST_20, (i) => entry(`${tag} newer charge ${i}`));

    await login(page);
    await searchList(page, '/ledger', en.ledger.search, `${tag} target`);
    // The ledger list has no reason column; the reason is in the entry's detail. The search
    // matches on it, so exactly one row comes back, and opening it shows the reason.
    const rows = page.getByRole('row').filter({ has: page.getByRole('button', { name: en.common.view }) });
    await expect(rows).toHaveCount(1);
    await rows.first().getByRole('button', { name: en.common.view }).click();
    await expect(page.getByText(`${tag} target freight surcharge`).first()).toBeVisible();
  });
});

test.describe('L1 — a list shows the record past the old 200', () => {
  test('TC-LIST-07: suppliers — the last supplier by name, after 201 others, is found', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const tag = tagOf('SUP');
    // Suppliers are listed by name: "zzzz" sorts after every filler below.
    const target = await mk('suppliers', { name: `zzzz ${tag} Target`, country: 'AE' });
    await many(PAST_200, (i) => mk('suppliers', { name: `${tag} Filler ${String(i).padStart(3, '0')}`, country: 'AE' }), 20);

    await login(page);
    await searchList(page, '/suppliers', en.suppliers.search, target.name);
    await expect(page.getByText(target.name).first()).toBeVisible();
  });

  test('TC-LIST-08: customers — a customer with 201 newer ones is found by name', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const tag = tagOf('CUS');
    const target = await mk('customers', { displayName: `${tag} Target Shop`, type: 'B2B' });
    await many(PAST_200, (i) => mk('customers', { displayName: `${tag} Filler ${i}`, type: 'B2B' }), 20);

    await login(page);
    await searchList(page, '/customers', en.customers.search, target.displayName);
    await expect(page.getByText(target.displayName).first()).toBeVisible();
  });
});

