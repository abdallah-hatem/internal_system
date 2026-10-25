/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: a customer with branches (§7, owner 2026-10-25)
 * ═══════════════════════════════════════════════════════════════════════
 *  One owner pays for several branches. New Order starts on the customer's
 *  default branch and can be changed; switching customer drops the branch.
 *  The customer's page shows each branch's balance, a total equal to the
 *  balance tile, and narrows the statement to one branch on a click — closing
 *  at that branch's balance. The money rules themselves are pinned against
 *  Postgres in apps/api customer-branches.db.spec.ts; this is the screen.
 *
 *  Reached by clicking (CLAUDE.md §2). Stock comes through a cycle (§4).
 *
 *  Written 2026-10-25 and NOT run yet: the owner said no e2e runs for now.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { API, apiCtx, stockedProduct } from './support/fixtures';
import { login, messages, openCustomer, openNav } from './support/ui';

const en = messages('en');
const stamp = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;

/** An owner with Mokattam (the default), Master and LS2, and a plain shop; stock to sell. */
async function owner(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const tag = `${label} ${stamp()}`;
  const { product } = await stockedProduct(request, headers, mk, tag, 20);
  const shop = await mk('customers', { displayName: `${tag} Owner`, type: 'B2B' });
  const plain = await mk('customers', { displayName: `${tag} Plain`, type: 'B2B' });
  const b: Record<string, string> = {};
  for (const name of ['Mokattam', 'Master', 'LS2']) {
    const made = await mk(`customers/${shop.id}/branches`, { name, isDefault: name === 'Mokattam' });
    b[name] = made.id;
  }
  return { headers, mk, shop, plain, product, b };
}

async function choose(page: Page, trigger: Locator, label: string) {
  await trigger.click();
  const search = page.locator('[cmdk-input]').filter({ visible: true });
  if (await search.count()) await search.fill(label);
  await page.getByRole('option', { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();
}

async function newOrder(page: Page) {
  await openNav(page, en.nav.sales);
  await page.getByRole('button', { name: en.sales.create }).first().click();
  const form = page.getByTestId('sale-order-form');
  await expect(form).toBeVisible();
  return form;
}

async function lastOrderOf(request: APIRequestContext, headers: Record<string, string>, customerId: string) {
  const res = await request.get(`${API}/sales/orders?customerId=${customerId}&limit=5`, { headers });
  return ((await res.json()).data as any[])[0];
}

test.describe('Customer branches (§7, 2026-10-25)', () => {
  test('TC-BR-01: New Order starts on the default branch, sends the branch picked, and a switched customer takes none', async ({
    page,
    request,
  }) => {
    const { headers, shop, plain, product, b } = await owner(request, 'BR01');
    await login(page);

    // The default, then another branch picked by hand.
    let form = await newOrder(page);
    await choose(page, form.getByRole('combobox').first(), shop.displayName);
    const branch = form.getByTestId('sale-branch');
    await expect(branch.getByRole('combobox')).toContainText('Mokattam');
    await choose(page, branch.getByRole('combobox'), 'LS2');
    await choose(page, form.getByTestId('sale-line').first().getByRole('combobox'), product.name);
    await page.getByRole('button', { name: en.sales.createAndConfirm }).click();
    await expect(form).toBeHidden();
    expect((await lastOrderOf(request, headers, shop.id)).branch?.id).toBe(b.LS2);

    // A branch picked for the owner does not follow the order to another customer.
    form = await newOrder(page);
    await choose(page, form.getByRole('combobox').first(), shop.displayName);
    await choose(page, form.getByTestId('sale-branch').getByRole('combobox'), 'Master');
    await choose(page, form.getByRole('combobox').first(), plain.displayName);
    await expect(form.getByTestId('sale-branch')).toHaveCount(0);
    await choose(page, form.getByTestId('sale-line').first().getByRole('combobox'), product.name);
    await page.getByRole('button', { name: en.sales.createAndConfirm }).click();
    await expect(form).toBeHidden();
    const plainOrder = await lastOrderOf(request, headers, plain.id);
    expect(plainOrder.branchId).toBeNull();
  });

  test("TC-BR-02: the page's branch balances add up to Owes us, and one branch's statement closes at its balance", async ({
    page,
    request,
  }) => {
    const { mk, shop, product, b } = await owner(request, 'BR02');
    // 2 × 150 on Mokattam (the default, none named), 1 × 150 on LS2.
    await mk('sales/orders', {
      customerId: shop.id,
      channel: 'B2B',
      currency: 'EGP',
      confirm: true,
      items: [{ productId: product.id, quantity: 2, unitPrice: 150 }],
    });
    await mk('sales/orders', {
      customerId: shop.id,
      branchId: b.LS2,
      channel: 'B2B',
      currency: 'EGP',
      confirm: true,
      items: [{ productId: product.id, quantity: 1, unitPrice: 150 }],
    });

    await login(page);
    await openCustomer(page, shop.displayName);
    await expect(page.getByTestId('owner-tag')).toBeVisible();
    await expect(page.getByTestId('customer-balance')).toContainText('450.00');
    const card = page.getByTestId('customer-branches');
    await expect(card.getByTestId('branch-row')).toHaveCount(3);
    await expect(card.getByTestId('branch-row').nth(0)).toContainText('Mokattam');
    await expect(card.getByTestId('branch-row').nth(0).getByTestId('branch-default')).toBeVisible();
    await expect(card.getByTestId('branch-row').nth(0).getByTestId('branch-owed')).toContainText('300.00');
    await expect(card.getByTestId('branch-row').nth(2).getByTestId('branch-owed')).toContainText('150.00');
    await expect(card.getByTestId('branches-total')).toContainText('450.00');

    // The owner's statement names the branch on each row; LS2's closes at 150.
    const st = page.getByTestId('customer-statement');
    await expect(st.getByTestId('statement-closing-balance')).toContainText('450.00');
    await expect(st.getByTestId('statement-branch').first()).toContainText(/Mokattam|LS2/);
    await card.getByTestId('branch-row').nth(2).click();
    await expect(st.getByTestId('statement-closing-balance')).toContainText('150.00');
    await expect(st.getByTestId('statement-row')).toHaveCount(1);
  });
});
