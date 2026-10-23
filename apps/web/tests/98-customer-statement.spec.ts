/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: a customer's statement of account (I2, item 3)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §7b (2026-10-11): on the shop's page, a date range, the
 *  balance it opened at, every sale, payment, return and reversal in order with
 *  the balance after it, and the balance it closed at — which must be the
 *  balance the page shows. Printed through the print stylesheet; taken out as
 *  a CSV. The rule itself is pinned in 34 (TC-INV-26..28); this is the screen.
 *
 *  Reached by clicking (CLAUDE.md §2); the debt is real — confirmed orders on
 *  stock that came through a cycle (§4).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, apiCtx, owedOrder, stockedProduct } from './support/fixtures';
import { day, exportCsv, login, messages, openCustomer, pickDate } from './support/ui';

const stamp = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;
const en = messages('en');

/** A shop owing 3,000 and 4,000, which paid 3,500 oldest first: 3,500 still owed. */
async function shopWithHistory(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const tag = `${label} ${stamp()}`;
  const { product } = await stockedProduct(request, headers, mk, tag, 10);
  const shop = await mk('customers', { displayName: `${tag} Shop`, type: 'B2B' });
  const first = await owedOrder(mk, shop.id, product.id, 3000);
  const second = await owedOrder(mk, shop.id, product.id, 4000);
  await mk('payments', { customerId: shop.id, amount: 3500, currency: 'EGP', method: 'CASH', applyOldestFirst: true });
  return { headers, mk, shop, first, second, product };
}

test.describe('Customer statement (§7b, 2026-10-11)', () => {
  test('TC-ST-01: every sale and payment in order, a running balance, and a closing balance equal to the balance on the page', async ({ page, request }) => {
    const { shop, first, second } = await shopWithHistory(request, 'ST01');
    await login(page);
    await openCustomer(page, shop.displayName);

    const st = page.getByTestId('customer-statement');
    await expect(st.getByTestId('statement-row')).toHaveCount(3);
    const rows = st.getByTestId('statement-row');
    await expect(rows.nth(0)).toContainText(first.orderNo);
    await expect(rows.nth(0)).toContainText('3,000.00');
    await expect(rows.nth(1)).toContainText(second.orderNo);
    await expect(rows.nth(1)).toContainText('7,000.00');
    await expect(rows.nth(2)).toContainText('Cash');
    await expect(st.getByTestId('statement-opening')).toContainText('0.00');
    await expect(st.getByTestId('statement-closing-balance')).toHaveText('3,500.00 EGP');
    await expect(page.getByTestId('customer-balance')).toContainText('3,500.00');
  });

  test('TC-ST-02: a range with nothing in it opens and closes where the shop stood; back to today shows the rows again', async ({ page, request }) => {
    const { shop } = await shopWithHistory(request, 'ST02');
    await login(page);
    await openCustomer(page, shop.displayName);
    const st = page.getByTestId('customer-statement');
    await expect(st.getByTestId('statement-row')).toHaveCount(3);

    await pickDate(page, 'statementFrom', day(-3));
    await pickDate(page, 'statementTo', day(-1));
    await expect(st.getByTestId('statement-row')).toHaveCount(0);
    await expect(st).toContainText(en.customers.statement.empty);
    await expect(st.getByTestId('statement-closing-balance')).toHaveText('0.00 EGP');

    // From yesterday onwards: nothing before it, so it opens at nothing and ends at today's balance.
    await page.getByTestId('statement-dates-clear').click();
    await pickDate(page, 'statementFrom', day(-1));
    await expect(st.getByTestId('statement-row')).toHaveCount(3);
    await expect(st.getByTestId('statement-closing-balance')).toHaveText('3,500.00 EGP');
  });

  test('TC-ST-03: while a new range loads, the rows already there stay, dimmed, with a busy sign — never a blank card', async ({ page, request }) => {
    const { shop } = await shopWithHistory(request, 'ST03');
    await login(page);
    await openCustomer(page, shop.displayName);
    const st = page.getByTestId('customer-statement');
    await expect(st.getByTestId('statement-row')).toHaveCount(3);

    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/statement?*', async (route) => {
      await held;
      await route.continue();
    });
    await pickDate(page, 'statementFrom', day(-1));
    await expect(st.getByTestId('statement-reloading')).toBeVisible();
    await expect(st.getByTestId('statement-row')).toHaveCount(3);
    await expect(st.locator('[aria-busy="true"]')).toBeVisible();
    release();
    await expect(st.getByTestId('statement-reloading')).toBeHidden();
    await page.unroute('**/statement?*');
  });

  test('TC-ST-04: Export writes the opening, every row and the closing, money as numbers', async ({ page, request }) => {
    const { shop, first } = await shopWithHistory(request, 'ST04');
    await login(page);
    await openCustomer(page, shop.displayName);
    await expect(page.getByTestId('statement-row')).toHaveCount(3);

    const rows = await exportCsv(page, 'statement-export');
    const t = en.customers.statement;
    expect(rows[0]).toEqual([t.date, t.description, t.debit, t.credit, t.balance]);
    expect(rows).toHaveLength(1 + 1 + 3 + 1);
    expect(rows[1][1]).toBe(t.opening);
    expect(rows[2][1]).toContain(first.orderNo);
    expect(Number(rows[2][2])).toBe(3000);
    expect(Number(rows[4][3])).toBe(3500);
    expect(rows[5][1]).toBe(t.closing);
    expect(Number(rows[5][4])).toBe(3500);
  });

  test('TC-ST-05: on paper only the statement is printed — with whose it is — not the menu, the tiles or the other cards', async ({ page, request }) => {
    const { shop } = await shopWithHistory(request, 'ST05');
    await login(page);
    await openCustomer(page, shop.displayName);
    await expect(page.getByTestId('statement-row')).toHaveCount(3);

    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('aside')).toBeHidden();
    await expect(page.getByTestId('customer-balance')).toBeHidden();
    await expect(page.getByTestId('statement-print')).toBeHidden();
    await expect(page.getByTestId('statement-date-range')).toBeHidden();
    const st = page.getByTestId('customer-statement');
    await expect(st.getByRole('heading', { name: en.customers.statement.heading })).toBeVisible();
    await expect(st.getByText(shop.displayName)).toBeVisible();
    await expect(st.getByTestId('statement-table')).toBeVisible();
  });

  test('TC-ST-06: the second time — a payment recorded on the page shows in the statement at once, and it still closes at the balance', async ({ page, request }) => {
    const { shop } = await shopWithHistory(request, 'ST06');
    await login(page);
    await openCustomer(page, shop.displayName);
    await expect(page.getByTestId('statement-row')).toHaveCount(3);

    await page.getByRole('main').getByRole('button', { name: en.payments.create }).first().click();
    const dialog = page.locator('[data-record-payment-dialog]');
    await dialog.locator('#payment-amount').pressSequentially('500');
    await dialog.getByRole('button', { name: en.common.save }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByTestId('statement-row')).toHaveCount(4);
    await expect(page.getByTestId('statement-closing-balance')).toHaveText('3,000.00 EGP');
    await expect(page.getByTestId('customer-balance')).toContainText('3,000.00');
  });

  test('TC-ST-07: in Arabic the statement reads right to left, in Arabic, with the amounts whole', async ({ page, request }) => {
    const { shop } = await shopWithHistory(request, 'ST07');
    await login(page, 'ar');
    await openCustomer(page, shop.displayName, 'ar');
    const st = page.getByTestId('customer-statement');
    await expect(st.getByRole('heading', { name: messages('ar').customers.statement.title })).toBeVisible();
    expect(await st.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    await expect(st.getByTestId('statement-closing-balance')).toHaveText('3,500.00 EGP');
  });
  test('TC-ST-08: the Profit column — the server’s profit on each sale, "—" on a payment, the period’s total on the closing row; never on paper (owner 2026-10-23)', async ({ page, request }) => {
    const { shop, headers } = await shopWithHistory(request, 'ST08');
    const res = await request.get(`${API}/customers/${shop.id}/statement`, { headers });
    const statement = (await res.json()).data;
    // Each sale made money: two units at their price, drawn from a cycle at its landed cost.
    expect(statement.rows.map((r: any) => r.kind)).toEqual(['SALE', 'SALE', 'PAYMENT']);
    expect(statement.rows[2].profit).toBeNull();
    const total = statement.rows.reduce((sum: number, r: any) => sum + Number(r.profit ?? 0), 0);
    expect(Number(statement.profit)).toBeCloseTo(total, 2);

    await login(page);
    await openCustomer(page, shop.displayName);
    const st = page.getByTestId('customer-statement');
    await expect(st.getByTestId('statement-row')).toHaveCount(3);
    const money = (v: string) => `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v))} EGP`;
    const cells = st.getByTestId('statement-profit');
    await expect(cells.nth(0)).toHaveText(money(statement.rows[0].profit));
    await expect(cells.nth(1)).toHaveText(money(statement.rows[1].profit));
    await expect(cells.nth(2)).toHaveText('—');
    await expect(st.getByTestId('statement-closing-profit')).toHaveText(money(statement.profit));

    // On paper the shop may get it: no Profit header, no profit cell, the rest printed.
    await page.emulateMedia({ media: 'print' });
    await expect(st.getByRole('columnheader', { name: en.customers.statement.profit })).toBeHidden();
    await expect(cells.first()).toBeHidden();
    await expect(st.getByTestId('statement-closing-profit')).toBeHidden();
    await expect(st.getByTestId('statement-closing-balance')).toBeVisible();
  });
});
