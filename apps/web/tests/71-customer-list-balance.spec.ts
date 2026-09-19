/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The balance on the Customers list
 * ═══════════════════════════════════════════════════════════════════════
 *  The list showed 0.00 for every shop. The API's list never sent a balance,
 *  the table read a field that was not there, and `?? 0` turned "missing" into
 *  "owes nothing" — so a shop owing thousands looked settled until someone
 *  opened it.
 *
 *  The list and the customer's page must say the same thing, because the
 *  second is where the office looks when the first looks wrong. Both are
 *  reached by clicking, as a person does: a full page load would rebuild the
 *  cache and hide a list that goes stale after a payment.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { apiCtx, stockedProduct, owedOrder, EMAIL, PASSWORD } from './support/fixtures';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/**
 * One shop owing 750 on a confirmed order and holding a 300 draft, and one
 * shop with only a draft. The drafts are there to be ignored: a draft is not a
 * sale and owes nothing.
 */
async function twoShops(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const stamp = Date.now();
  const { product } = await stockedProduct(request, headers, mk, `ListBal ${stamp}`, 10);

  const owing = await mk('customers', { displayName: `ListBal Owing ${stamp}`, type: 'B2B' });
  await owedOrder(mk, owing.id, product.id, 750);
  await mk('sales/orders', {
    customerId: owing.id, channel: 'B2B', currency: 'EGP',
    items: [{ productId: product.id, quantity: 1, unitPrice: 300, discount: 0 }],
  });

  const draftOnly = await mk('customers', { displayName: `ListBal Draft ${stamp}`, type: 'B2B' });
  await mk('sales/orders', {
    customerId: draftOnly.id, channel: 'B2B', currency: 'EGP',
    items: [{ productId: product.id, quantity: 1, unitPrice: 900, discount: 0 }],
  });

  return { owing, draftOnly };
}

/** Customers, reached from the sidebar. */
async function openCustomers(page: Page) {
  await page.getByRole('link', { name: 'Customers', exact: true }).first().click();
  await expect(page).toHaveURL(/\/en\/customers$/);
}

/** The balance cell of the row for this shop — the fifth column, "Balance". */
async function listBalance(page: Page, name: string) {
  const row = page.locator('tbody tr').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  return row.locator('td').nth(4);
}

/** The Balance tile on the customer's own page. */
function pageBalance(page: Page) {
  return page.locator('div.rounded-xl').filter({ has: page.getByText('Balance', { exact: true }) }).first();
}

test.describe('Customers list balance', () => {
  test('TC-LISTBAL-01: the list shows what the shop owes, the same as its page', async ({
    page,
    request,
  }) => {
    const { owing } = await twoShops(request);
    await login(page);
    await openCustomers(page);

    // 750 confirmed; the 300 draft does not count.
    const cell = await listBalance(page, owing.displayName);
    await expect(cell).toHaveText(/750\.00\s*EGP/);

    await page.getByRole('link', { name: owing.displayName }).first().click();
    await expect(page).toHaveURL(new RegExp(`/customers/${owing.id}`));
    await expect(pageBalance(page)).toContainText(/750\.00\s*EGP/);
  });

  test('TC-LISTBAL-02: a shop with only a draft shows 0.00 in both places', async ({
    page,
    request,
  }) => {
    const { draftOnly } = await twoShops(request);
    await login(page);
    await openCustomers(page);

    await expect(await listBalance(page, draftOnly.displayName)).toHaveText(/^0\.00\s*EGP$/);

    await page.getByRole('link', { name: draftOnly.displayName }).first().click();
    await expect(page).toHaveURL(new RegExp(`/customers/${draftOnly.id}`));
    await expect(pageBalance(page)).toContainText(/0\.00\s*EGP/);
  });

  test('TC-LISTBAL-03: after a payment, going back to the list shows the new balance', async ({
    page,
    request,
  }) => {
    // The second visit. The list was cached on the way in; a payment taken on
    // the shop's page must not leave the list still saying 750.
    const { owing } = await twoShops(request);
    await login(page);
    await openCustomers(page);
    await expect(await listBalance(page, owing.displayName)).toHaveText(/750\.00\s*EGP/);

    await page.getByRole('link', { name: owing.displayName }).first().click();
    await page.getByRole('button', { name: /record payment|new payment/i }).first().click();
    await page.locator('input[inputmode="decimal"]').first().fill('200');
    await page.getByRole('button', { name: /save/i }).click();
    await expect(pageBalance(page)).toContainText(/550\.00\s*EGP/, { timeout: 15000 });

    await openCustomers(page);
    await expect(await listBalance(page, owing.displayName)).toHaveText(/550\.00\s*EGP/);
  });
});
