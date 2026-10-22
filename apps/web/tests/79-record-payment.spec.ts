/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: a payment on a chosen order, and one payment form (U2)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §7, DECIDED 2026-10-10: recorded from an order, the money
 *  goes on that order — the same shop's, confirmed, still owing, and no more
 *  than it owes. Recorded from the shop or the payments list, it goes on the
 *  oldest unpaid orders first. All three places open one form
 *  (`RecordPaymentDialog`).
 *
 *  Screens are reached by clicking after the login page (CLAUDE.md rule 2),
 *  and stock is built through a cycle and a verified receipt (rule 4).
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { API, EMAIL, PASSWORD, apiCtx, owedOrder, outstandingOf, stockedProduct } from './support/fixtures';
import en from '../src/i18n/locales/en.json';
import ar from '../src/i18n/locales/ar.json';
import { WEB as BASE } from './support/env';

type Messages = typeof en;

async function login(page: Page, locale: 'en' | 'ar' = 'en') {
  await page.goto(`${BASE}/${locale}/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  const m: Messages = locale === 'en' ? en : ar;
  await page.getByRole('button', { name: m.auth.login, exact: true }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** Through the navigation — the sidebar, or behind the menu on a phone. */
async function openNav(page: Page, name: string) {
  const link = () => page.getByRole('link', { name, exact: true }).filter({ visible: true }).first();
  if ((await link().count()) === 0) {
    await page.locator('button:has(svg.icon-menu)').filter({ visible: true }).first().click();
  }
  const href = await link().getAttribute('href');
  await link().click();
  // Wait until the route has actually changed. The click only starts a client
  // navigation; until it lands, the page on screen is still the one we left —
  // and the dashboard can name the very shop a test has just made (who to
  // collect from). TC-RP-06 flaked exactly so (I1, 2026-10-11): late in a
  // full run the route change is slow, the next getByText found the shop's
  // name on the dashboard, clicked that plain text, and the customer list
  // arrived after.
  if (href) await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), { timeout: 15000 });
}

async function openOrder(page: Page, orderNo: string, m: Messages = en) {
  await openNav(page, m.nav.sales);
  await expect(page.getByRole('heading', { name: m.sales.title })).toBeVisible();
  await page.getByPlaceholder(m.sales.search).fill(orderNo);
  await page.getByTestId('sale-row').filter({ hasText: orderNo }).locator('td').nth(6).click();
  await expect(page.getByRole('heading', { name: orderNo })).toBeVisible();
}

const dialog = (page: Page) => page.locator('[data-record-payment-dialog]');
const amountField = (page: Page) => dialog(page).locator('#payment-amount');

/** A verified shop owing an older 300 and a newer 800, both confirmed. */
async function shopOwingTwo(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}`;
  const customer = await mk('customers', { displayName: `${label} Shop ${stamp}`, type: 'B2B' });
  const { product } = await stockedProduct(request, headers, mk, `${label} ${stamp}`, 50);
  const older = await owedOrder(mk, customer.id, product.id, 300);
  const newer = await owedOrder(mk, customer.id, product.id, 800);
  return { headers, mk, customer, product, older, newer };
}

test.describe('Record payment from an order (§7)', () => {
  test('TC-RP-01: the dialog shows the order outstanding, defaults the amount to it, and pays only that order', async ({
    page,
    request,
  }) => {
    const { headers, older, newer } = await shopOwingTwo(request, 'RP01');
    await login(page);
    await openOrder(page, newer.orderNo);

    await page.getByTestId('order-record-payment').click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByTestId('payment-owed')).toContainText('800.00');
    await expect(amountField(page)).toHaveValue('800.00');

    await amountField(page).fill('500');
    await dialog(page).getByRole('button', { name: en.common.save }).click();
    await expect(dialog(page)).toBeHidden();

    // On the chosen order only, though an older one is unpaid.
    expect(await outstandingOf(request, headers, newer.id)).toBe(300);
    expect(await outstandingOf(request, headers, older.id)).toBe(300);
  });

  test('TC-RP-02: more than the order owes is refused and the dialog keeps what was typed', async ({
    page,
    request,
  }) => {
    const { headers, newer } = await shopOwingTwo(request, 'RP02');
    await login(page);
    await openOrder(page, newer.orderNo);
    await page.getByTestId('order-record-payment').click();

    await amountField(page).fill('900');
    await dialog(page).getByRole('button', { name: en.common.save }).click();
    await expect(dialog(page).getByTestId('payment-refusal')).toContainText('800.00');
    await expect(amountField(page)).toHaveValue('900');
    expect(await outstandingOf(request, headers, newer.id)).toBe(800);
  });

  test('TC-RP-03: a draft offers no Record payment', async ({ page, request }) => {
    const { mk, customer, product } = await shopOwingTwo(request, 'RP03');
    const draft = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
    });
    await login(page);
    await openOrder(page, draft.orderNo);
    await expect(page.getByTestId('order-record-payment')).toHaveCount(0);
  });

  test('TC-RP-03b: a fully paid order offers no Record payment', async ({ page, request }) => {
    const { mk, customer, newer } = await shopOwingTwo(request, 'RP03b');
    await mk('payments', { customerId: customer.id, amount: 800, currency: 'EGP', method: 'CASH', orderId: newer.id });
    await login(page);
    await openOrder(page, newer.orderNo);
    await expect(page.getByTestId('order-record-payment')).toHaveCount(0);
  });

  test('TC-RP-04: two quick clicks on Save record one payment', async ({ page, request }) => {
    const { headers, customer, newer } = await shopOwingTwo(request, 'RP04');
    await login(page);
    await openOrder(page, newer.orderNo);
    await page.getByTestId('order-record-payment').click();

    const save = dialog(page).getByRole('button', { name: en.common.save });
    await save.dblclick();
    await expect(dialog(page)).toBeHidden();

    const res = await request.get(`${API}/payments?customerId=${customer.id}`, { headers });
    const payments = (await res.json()).data;
    expect(payments).toHaveLength(1);
    expect(await outstandingOf(request, headers, newer.id)).toBe(0);
  });
});

test.describe('The one payment form elsewhere', () => {
  test('TC-RP-05: the Payments page records through the same form, oldest order first', async ({
    page,
    request,
  }) => {
    const { headers, customer, older, newer } = await shopOwingTwo(request, 'RP05');
    await login(page);
    await openNav(page, en.nav.payments);
    await page.getByRole('button', { name: en.payments.create }).first().click();
    await expect(dialog(page)).toBeVisible();

    await dialog(page).getByRole('combobox').first().click();
    const search = page.locator('[cmdk-input]').filter({ visible: true });
    if (await search.count()) await search.fill(customer.displayName);
    await page.getByRole('option', { name: customer.displayName }).first().click();
    await expect(dialog(page).getByTestId('payment-owed')).toContainText('1,100.00');

    await amountField(page).fill('400');
    await dialog(page).getByRole('button', { name: en.common.save }).click();
    await expect(dialog(page)).toBeHidden();

    await expect.poll(() => outstandingOf(request, headers, older.id)).toBe(0);
    expect(await outstandingOf(request, headers, newer.id)).toBe(700);
  });

  test('TC-RP-06: on the customer page a draft shows "—", not an amount owed', async ({ page, request }) => {
    const { mk, customer, product } = await shopOwingTwo(request, 'RP06');
    await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: 999, discount: 0 }],
    });
    await login(page);
    await openNav(page, en.nav.customers);
    // The shop's own link in the list — a person clicks the name in the row.
    await page.getByRole('main').getByRole('link', { name: customer.displayName, exact: true }).first().click();
    await expect(page.getByRole('heading', { name: customer.displayName })).toBeVisible();

    // The balance counts the two confirmed orders only.
    await expect(page.getByText('1,100.00').first()).toBeVisible();
    // The visible one: the orders are drawn as a table and, for a phone, as cards (2026-10-17).
    await expect(page.getByTestId('outstanding').filter({ hasText: en.sales.notConfirmed }).filter({ visible: true })).toHaveCount(1);
    // No payments yet: the empty state says so and offers the action.
    await expect(page.getByText(en.customers.noPayments)).toBeVisible();
  });

  test('TC-RP-07: a method reads the same in the list as in the form, in Arabic too', async ({
    page,
    request,
  }) => {
    const { customer, newer, mk } = await shopOwingTwo(request, 'RP07');
    await mk('payments', {
      customerId: customer.id, amount: 100, currency: 'EGP', method: 'BANK_TRANSFER', orderId: newer.id,
    });
    await login(page, 'ar');
    await openNav(page, ar.nav.payments);
    await page.getByPlaceholder(ar.payments.search).fill(customer.displayName);
    await expect(page.getByText(ar.codes.paymentMethod.BANK_TRANSFER).first()).toBeVisible();
    await expect(page.getByText('BANK_TRANSFER')).toHaveCount(0);
  });
});

test.describe('At the API', () => {
  test("TC-RP-08: a payment on another shop's order is 404, and nothing is saved", async ({ request }) => {
    const a = await shopOwingTwo(request, 'RP08a');
    const { headers, mk } = a;
    const other = await mk('customers', { displayName: `RP08b Shop ${Date.now()}`, type: 'B2B' });
    const theirs = await owedOrder(mk, other.id, a.product.id, 200);

    const res = await request.post(`${API}/payments`, {
      headers,
      data: { customerId: a.customer.id, amount: 100, currency: 'EGP', method: 'CASH', orderId: theirs.id },
    });
    expect(res.status()).toBe(404);
    expect(await outstandingOf(request, headers, theirs.id)).toBe(200);
    const mine = await request.get(`${API}/payments?customerId=${a.customer.id}`, { headers });
    expect((await mine.json()).data).toHaveLength(0);
  });

  test('TC-RP-09: the same sale Idempotency-Key twice returns one order; a negative discount is refused', async ({
    request,
  }) => {
    const { headers, mk } = await apiCtx(request);
    const stamp = `${Date.now()}`;
    const customer = await mk('customers', { displayName: `RP09 Shop ${stamp}`, type: 'B2B' });
    const { product } = await stockedProduct(request, headers, mk, `RP09 ${stamp}`, 10);
    const body = {
      customerId: customer.id, channel: 'B2B', currency: 'EGP', confirm: true,
      items: [{ productId: product.id, quantity: 2, unitPrice: 100, discount: 0 }],
    };
    const send = () =>
      request.post(`${API}/sales/orders`, { headers: { ...headers, 'Idempotency-Key': `rp09-${stamp}` }, data: body });
    const first = await (await send()).json();
    const second = await (await send()).json();
    expect(second.data.id).toBe(first.data.id);
    const list = await (await request.get(`${API}/sales/orders?customerId=${customer.id}`, { headers })).json();
    expect(list.data).toHaveLength(1);

    const negative = await request.post(`${API}/sales/orders`, {
      headers,
      data: { ...body, items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: -10 }] },
    });
    expect(negative.status()).toBe(400);
    expect((await negative.json()).error.code).toBe('DISCOUNT_NEGATIVE');
  });
});

// L7 (found by L6): Escape inside an open picker closed the whole payment form.
test.describe('Escape in the payment form (L7)', () => {
  test('TC-RP-10: Escape inside the open method picker closes the picker and keeps the form and what was typed; the next Escape closes the form', async ({ page, request }) => {
    const { newer } = await shopOwingTwo(request, 'RP10');
    await login(page);
    await openOrder(page, newer.orderNo);
    await page.getByTestId('order-record-payment').click();
    await expect(dialog(page)).toBeVisible();
    await amountField(page).fill('250');
    await dialog(page).getByRole('combobox').first().click();
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option')).toHaveCount(0);
    await expect(dialog(page)).toBeVisible();
    await expect(amountField(page)).toHaveValue(/250/);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  });
});
