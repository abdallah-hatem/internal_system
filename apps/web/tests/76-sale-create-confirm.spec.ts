/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: create and confirm a sale in one step (U1)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §4, DECIDED 2026-10-10: an order can be created and
 *  confirmed in one step, both or neither. If confirming is refused, nothing
 *  is saved and the order stays on screen to fix. A draft owes nothing.
 *
 *  Screens are reached the way a person reaches them: log in, then click. No
 *  `page.goto` after the login page — a full load wipes the client cache that
 *  stale-list bugs live in (CLAUDE.md rule 2).
 *
 *  Fixtures build real stock through a cycle, a purchase order, a leg and a
 *  verified receipt (rule 4), via `stockedProduct`.
 */
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
import { API, EMAIL, PASSWORD, apiCtx, stockedProduct } from './support/fixtures';
import en from '../src/i18n/locales/en.json';
import ar from '../src/i18n/locales/ar.json';
import { WEB as BASE } from './support/env';

type Messages = typeof en;

async function login(page: Page, locale: 'en' | 'ar' = 'en') {
  await page.goto(`${BASE}/${locale}/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  const m: Messages = locale === 'en' ? en : ar;
  await page.getByRole('button', { name: m.auth.login, exact: true }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/**
 * To the sales page through the navigation: the sidebar, or on a phone the bar
 * at the foot (U3). The phone's sidebar is a drawer translated off-screen, which
 * Playwright still counts as visible, so its link was picked and could never be
 * clicked ("outside of the viewport"). A person on a phone taps the bar.
 */
async function openSales(page: Page, m: Messages = en) {
  const bar = page.getByTestId('phone-bar');
  if (await bar.isVisible()) {
    await bar.getByRole('link', { name: m.nav.short.sales, exact: true }).click();
  } else {
    await page.getByRole('link', { name: m.nav.sales, exact: true }).filter({ visible: true }).first().click();
  }
  await expect(page.getByRole('heading', { name: m.sales.title })).toBeVisible();
}

async function openNewOrder(page: Page, m: Messages = en) {
  await page.getByRole('button', { name: m.sales.create }).first().click();
  const form = page.getByTestId('sale-order-form');
  await expect(form).toBeVisible();
  return form;
}

/** Open a picker and choose an option by its label, searching when the list is long. */
async function choose(page: Page, trigger: Locator, label: string) {
  await trigger.click();
  const search = page.locator('[cmdk-input]').filter({ visible: true });
  if (await search.count()) await search.fill(label);
  await page.getByRole('option', { name: new RegExp(escape(label)) }).first().click();
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const combo = (form: Locator, n: number) => form.getByRole('combobox').nth(n);
const line = (form: Locator, n: number) => form.getByTestId('sale-line').nth(n);
const input = (row: Locator, name: string) => row.locator(`[data-field="${name}"]:not([type="hidden"])`);

/** A verified shop and a product with `qty` genuinely in stock. */
async function shopAndStock(request: APIRequestContext, label: string, qty: number) {
  const { headers, mk } = await apiCtx(request);
  const stamp = `${Date.now()}`;
  const customer = await mk('customers', { displayName: `${label} Shop ${stamp}`, type: 'B2B' });
  const { product } = await stockedProduct(request, headers, mk, `${label} ${stamp}`, qty);
  return { headers, mk, customer, product };
}

async function ordersOf(request: APIRequestContext, headers: Record<string, string>, customerId: string) {
  const res = await request.get(`${API}/sales/orders?customerId=${customerId}&limit=100`, { headers });
  const body = await res.json();
  return (body.data ?? body) as { id: string; status: string; total: string }[];
}

async function available(request: APIRequestContext, headers: Record<string, string>, productId: string) {
  const res = await request.get(`${API}/inventory`, { headers });
  const body = await res.json();
  const rows: { productId: string; availableStock?: number | string }[] = body.data ?? body;
  return Number(rows.find((r) => r.productId === productId)?.availableStock ?? 0);
}

/** Fill the first line: product, quantity, price, discount. */
async function fillLine(page: Page, form: Locator, productName: string, qty: string, price: string, discount = '') {
  await choose(page, combo(form, 3), productName);
  const row = line(form, 0);
  await input(row, 'quantity').fill(qty);
  await input(row, 'unitPrice').fill(price);
  if (discount) await input(row, 'discount').fill(discount);
}

test.describe('Create & confirm (BUSINESS_LOGIC §4)', () => {
  test('TC-CC-01: Create & confirm with enough stock → one confirmed order, stock reduced, in one request', async ({
    page,
    request,
  }) => {
    const { headers, customer, product } = await shopAndStock(request, 'CC01', 60);
    await login(page);
    await openSales(page);
    const form = await openNewOrder(page);
    await expect(form.getByTestId('sale-line')).toHaveCount(1); // starts with one row

    await choose(page, combo(form, 0), customer.displayName);
    await fillLine(page, form, product.name, '10', '250');

    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/sales\/orders/.test(r.url())) posts.push(r.url());
    });
    await form.getByRole('button', { name: en.sales.createAndConfirm }).click();
    await expect(form).toBeHidden();

    const orders = await ordersOf(request, headers, customer.id);
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('CONFIRMED');
    expect(await available(request, headers, product.id)).toBe(50);
    // One request: no separate POST /:id/confirm.
    expect(posts).toHaveLength(1);
    expect(posts[0]).not.toMatch(/confirm$/);
  });

  test('TC-CC-02: more than is in stock → refused NOT_ENOUGH_STOCK, no draft left behind, the form stays open with its lines', async ({
    page,
    request,
  }) => {
    const { headers, customer, product } = await shopAndStock(request, 'CC02', 5);
    await login(page);
    await openSales(page);
    const form = await openNewOrder(page);
    await choose(page, combo(form, 0), customer.displayName);
    await fillLine(page, form, product.name, '6', '100');

    await form.getByRole('button', { name: en.sales.createAndConfirm }).click();

    const alert = form.getByRole('alert');
    await expect(alert).toContainText(product.name);
    await expect(alert).not.toContainText('NOT_ENOUGH_STOCK');
    await expect(form).toBeVisible();
    await expect(input(line(form, 0), 'quantity')).toHaveValue('6');
    await expect(input(line(form, 0), 'unitPrice')).toHaveValue('100');

    expect(await ordersOf(request, headers, customer.id)).toHaveLength(0);
    expect(await available(request, headers, product.id)).toBe(5);

    // The second visit: fix the quantity in the same dialog and go again.
    await input(line(form, 0), 'quantity').fill('5');
    await form.getByRole('button', { name: en.sales.createAndConfirm }).click();
    await expect(form).toBeHidden();
    const orders = await ordersOf(request, headers, customer.id);
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('CONFIRMED');
  });

  test('TC-CC-03: a discount larger than the line → refused, nothing saved', async ({ page, request }) => {
    const { headers, customer, product } = await shopAndStock(request, 'CC03', 20);
    await login(page);
    await openSales(page);
    const form = await openNewOrder(page);
    await choose(page, combo(form, 0), customer.displayName);
    await fillLine(page, form, product.name, '1', '100', '9999');
    await expect(form.getByText(en.sales.discountTooLarge)).toBeVisible();

    await form.getByRole('button', { name: en.sales.createAndConfirm }).click();
    await expect(form.getByRole('alert')).toBeVisible();
    expect(await ordersOf(request, headers, customer.id)).toHaveLength(0);
    expect(await available(request, headers, product.id)).toBe(20);
  });

  test('TC-CC-04: a customer id that does not exist → 404, not 500', async ({ request }) => {
    const { headers, product } = await shopAndStock(request, 'CC04', 10);
    const res = await request.post(`${API}/sales/orders`, {
      headers,
      data: {
        customerId: '99999999-9999-4999-8999-999999999999',
        channel: 'B2B',
        currency: 'EGP',
        confirm: true,
        items: [{ productId: product.id, quantity: 1, unitPrice: 100 }],
      },
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  test('TC-CC-05: an investor → refused with a code, nothing saved', async ({ request }) => {
    const { headers, customer, product } = await shopAndStock(request, 'CC05', 10);
    const stamp = `${Date.now()}`;
    const email = `cc05-investor-${stamp}@motoparts.com`;
    const made = await request.post(`${API}/auth/register`, {
      headers,
      data: { email, password: 'password123', displayName: `Investor ${stamp}`, role: 'TEMP_INVESTOR' },
    });
    expect(made.ok(), await made.text()).toBeTruthy();
    const login = await request.post(`${API}/auth/login`, { data: { email, password: 'password123' } });
    const investor = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };

    const res = await request.post(`${API}/sales/orders`, {
      headers: investor,
      data: {
        customerId: customer.id,
        channel: 'B2B',
        currency: 'EGP',
        confirm: true,
        items: [{ productId: product.id, quantity: 1, unitPrice: 100 }],
      },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe('ROLE_NOT_ALLOWED');
    expect(await ordersOf(request, headers, customer.id)).toHaveLength(0);
  });

  test('TC-CC-06: two lines of one product (40 + 40) against 60 → refused as a sum, nothing saved', async ({
    request,
  }) => {
    const { headers, customer, product } = await shopAndStock(request, 'CC06', 60);
    const res = await request.post(`${API}/sales/orders`, {
      headers,
      data: {
        customerId: customer.id,
        channel: 'B2B',
        currency: 'EGP',
        confirm: true,
        items: [
          { productId: product.id, quantity: 40, unitPrice: 100 },
          { productId: product.id, quantity: 40, unitPrice: 100 },
        ],
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error.code).toBe('NOT_ENOUGH_STOCK');
    expect(await ordersOf(request, headers, customer.id)).toHaveLength(0);
    expect(await available(request, headers, product.id)).toBe(60);
  });

  test('TC-CC-07: double-click Create & confirm → one order', async ({ page, request }) => {
    const { headers, customer, product } = await shopAndStock(request, 'CC07', 30);
    await login(page);
    await openSales(page);
    const form = await openNewOrder(page);
    await choose(page, combo(form, 0), customer.displayName);
    await fillLine(page, form, product.name, '10', '100');

    await form.getByRole('button', { name: en.sales.createAndConfirm }).dblclick();
    await expect(form).toBeHidden();

    expect(await ordersOf(request, headers, customer.id)).toHaveLength(1);
    expect(await available(request, headers, product.id)).toBe(20);
  });

  test('TC-CC-07b: the same Idempotency-Key twice over the API → the same order', async ({ request }) => {
    const { headers, customer, product } = await shopAndStock(request, 'CC07b', 30);
    const send = () =>
      request.post(`${API}/sales/orders`, {
        headers: { ...headers, 'Idempotency-Key': `cc07b-${customer.id}` },
        data: {
          customerId: customer.id,
          channel: 'B2B',
          currency: 'EGP',
          confirm: true,
          items: [{ productId: product.id, quantity: 10, unitPrice: 100 }],
        },
      });
    const [a, b] = await Promise.all([send(), send()]);
    expect((await a.json()).data.id).toBe((await b.json()).data.id);
    expect(await ordersOf(request, headers, customer.id)).toHaveLength(1);
    expect(await available(request, headers, product.id)).toBe(20);
  });

  test("TC-CC-08: a draft's outstanding shows — (not confirmed), and the customer balance is unchanged by it", async ({
    page,
    request,
  }) => {
    const { headers, customer, product } = await shopAndStock(request, 'CC08', 10);
    const balanceBefore = async () => {
      const res = await request.get(`${API}/customers/${customer.id}`, { headers });
      const body = await res.json();
      return Number((body.data ?? body).outstandingBalance ?? 0);
    };
    const before = await balanceBefore();

    await login(page);
    await openSales(page);
    const form = await openNewOrder(page);
    await choose(page, combo(form, 0), customer.displayName);
    await fillLine(page, form, product.name, '2', '300');
    await form.getByRole('button', { name: en.sales.saveDraft }).click();
    await expect(form).toBeHidden();

    await page.getByPlaceholder(en.sales.search).fill(customer.displayName);
    const row = page.getByTestId('sale-row').filter({ hasText: customer.displayName });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('outstanding')).toContainText('—');
    await expect(row.getByTestId('outstanding')).toContainText(en.sales.notConfirmed);
    await expect(row).toContainText(en.codes.orderStatus.DRAFT);

    expect(await balanceBefore()).toBe(before);
    expect(await available(request, headers, product.id)).toBe(10);
  });

  test("TC-CC-09: the running total equals the server's order total for the same lines, discounts included", async ({
    page,
    request,
  }) => {
    const { headers, customer, product } = await shopAndStock(request, 'CC09', 50);
    await login(page);
    await openSales(page);
    const form = await openNewOrder(page);
    await choose(page, combo(form, 0), customer.displayName);
    await fillLine(page, form, product.name, '3', '33.33', '0.99');
    await form.getByRole('button', { name: en.sales.addItem }).click();
    await choose(page, combo(form, 4), product.name);
    await input(line(form, 1), 'quantity').fill('7');
    await input(line(form, 1), 'unitPrice').fill('19.99');
    await input(line(form, 1), 'discount').fill('5');

    const shown = (await form.getByTestId('order-total').innerText()).replace(/[^\d.]/g, '');

    await form.getByRole('button', { name: en.sales.createAndConfirm }).click();
    await expect(form).toBeHidden();
    const [order] = await ordersOf(request, headers, customer.id);
    // 99.99 − 0.99 + 139.93 − 5 = 233.93
    expect(Number(order.total)).toBe(233.93);
    expect(Number(shown)).toBe(Number(order.total));
  });

  test('TC-CC-10: at 390px in Arabic every input on an item card shows its full value', async ({
    page,
    request,
  }) => {
    const { customer, product } = await shopAndStock(request, 'CC10', 2000);
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, 'ar');
    await openSales(page, ar);
    const form = await openNewOrder(page, ar);
    await choose(page, combo(form, 0), customer.displayName);
    await choose(page, combo(form, 3), product.name);
    const row = line(form, 0);
    await input(row, 'quantity').fill('1250');
    await input(row, 'unitPrice').fill('12500.50');
    await input(row, 'discount').fill('1250.75');
    await form.getByText(ar.sales.orderTotal).click(); // blur, so the money fields regroup

    // The product sits on its own row above the numbers on a phone.
    const productBox = (await combo(form, 3).boundingBox())!;
    const qtyBox = (await input(row, 'quantity').boundingBox())!;
    expect(qtyBox.y).toBeGreaterThan(productBox.y + productBox.height - 1);

    for (const name of ['quantity', 'unitPrice', 'discount']) {
      const field = input(row, name);
      const { scroll, client, value } = await field.evaluate((el: HTMLInputElement) => ({
        scroll: el.scrollWidth,
        client: el.clientWidth,
        value: el.value,
      }));
      expect(value, name).not.toBe('');
      expect(scroll, `${name} "${value}" is clipped: ${scroll}px of text in ${client}px`).toBeLessThanOrEqual(client);
    }
    // Nothing on the page scrolls sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('The sales list', () => {
  test('TC-CC-11: the first chip reads All; a click anywhere on a row opens the order', async ({ page, request }) => {
    const { mk, customer, product } = await shopAndStock(request, 'CC11', 10);
    const order = await mk('sales/orders', {
      customerId: customer.id,
      channel: 'B2B',
      currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: 100 }],
    });
    await login(page);
    await openSales(page);
    await expect(page.getByRole('button', { name: en.sales.all, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.getByPlaceholder(en.sales.search).fill(order.orderNo);
    // The date cell, nowhere near the View button.
    await page.getByTestId('sale-row').filter({ hasText: order.orderNo }).locator('td').nth(6).click();
    await expect(page.getByRole('heading', { name: order.orderNo })).toBeVisible();
  });

  test('TC-CC-12: on a phone a card opens from the keyboard', async ({ page, request }) => {
    const { mk, customer, product } = await shopAndStock(request, 'CC12', 10);
    const order = await mk('sales/orders', {
      customerId: customer.id,
      channel: 'B2B',
      currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: 100 }],
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await openSales(page);
    await page.getByPlaceholder(en.sales.search).fill(order.orderNo);
    const card = page.getByTestId('sale-card').filter({ hasText: order.orderNo });
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: order.orderNo })).toBeVisible();
  });

  test('TC-CC-13: Enter in a field saves a draft — it never confirms a sale', async ({ page, request }) => {
    const { headers, customer, product } = await shopAndStock(request, 'CC13', 10);
    await login(page);
    await openSales(page);
    const form = await openNewOrder(page);
    await choose(page, combo(form, 0), customer.displayName);
    await fillLine(page, form, product.name, '2', '100');
    await input(line(form, 0), 'quantity').press('Enter');
    await expect(form).toBeHidden();
    const orders = await ordersOf(request, headers, customer.id);
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('DRAFT');
    expect(await available(request, headers, product.id)).toBe(10);
  });
});
