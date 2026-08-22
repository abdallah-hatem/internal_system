/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: A sale line takes its price from the product
 * ═══════════════════════════════════════════════════════════════════════
 *  B2B and B2C prices were recorded against a product and used by nothing —
 *  a sale line asked for a unit price and offered no hint that a price
 *  existed. These cover the wiring.
 *
 *  Each test drives the form by clicking, and asserts on the input the seller
 *  actually reads, because that is where the previous round of these tests
 *  kept slipping past real bugs.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';

const BASE = 'http://localhost:3000';
const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

const B2B_PRICE = 1800;
const B2C_PRICE = 2100;
const OTHER_B2B = 640;
const OTHER_B2C = 900;

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

async function token(request: APIRequestContext) {
  const auth = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return (await auth.json()).data.accessToken;
}

/** A product priced on both channels, and a B2B customer to sell it to. */
async function pricedProductAndCustomer(request: APIRequestContext) {
  const t = await token(request);
  const headers = { Authorization: `Bearer ${t}` };
  const stamp = Date.now();

  const prodRes = await request.post(`${API}/products`, {
    headers,
    data: { name: `Priced Part ${stamp}`, minStock: 0 },
  });
  expect(prodRes.ok(), await prodRes.text()).toBeTruthy();
  const product = (await prodRes.json()).data ?? (await prodRes.json());

  for (const [channel, amount] of [['B2B', B2B_PRICE], ['B2C', B2C_PRICE]] as const) {
    const res = await request.post(`${API}/products/${product.id}/prices`, {
      headers,
      data: { channel, currency: 'EGP', amount },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  // A second product at different prices, to prove a line re-prices when the
  // product changes rather than keeping the first one's figure.
  const otherRes = await request.post(`${API}/products`, {
    headers, data: { name: `Other Part ${stamp}`, minStock: 0 },
  });
  const other = (await otherRes.json()).data ?? (await otherRes.json());
  for (const [channel, amount] of [['B2B', OTHER_B2B], ['B2C', OTHER_B2C]] as const) {
    const res = await request.post(`${API}/products/${other.id}/prices`, {
      headers, data: { channel, currency: 'EGP', amount },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  const custRes = await request.post(`${API}/customers`, {
    headers,
    data: { displayName: `Shop ${stamp}`, type: 'B2B' },
  });
  expect(custRes.ok(), await custRes.text()).toBeTruthy();

  // A retail buyer, so switching customer changes the channel it prices at.
  const retailRes = await request.post(`${API}/customers`, {
    headers, data: { displayName: `Walkin ${stamp}`, type: 'B2C' },
  });
  expect(retailRes.ok(), await retailRes.text()).toBeTruthy();

  return {
    headers,
    productName: `Priced Part ${stamp}`,
    otherProductName: `Other Part ${stamp}`,
    customerName: `Shop ${stamp}`,
    retailName: `Walkin ${stamp}`,
  };
}

/** Open the new-order form with one empty line ready. */
async function openOrderForm(page: Page) {
  await page.goto(`${BASE}/en/sales`);
  await page.getByRole('button', { name: /new order/i }).click();
  await page.getByRole('button', { name: /add item/i }).click();
}

async function pick(page: Page, name: string, label: string | RegExp) {
  const trigger = page
    .locator(`input[type="hidden"][name="${name}"]`)
    .locator('..')
    .getByRole('combobox');
  await trigger.click();
  await page.getByRole('listbox').getByRole('option').filter({ hasText: label }).first().click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

/** The line's unit price box — the third number input on the row. */
function unitPrice(page: Page) {
  return page.locator('input[type="number"]').nth(1);
}

async function pickProduct(page: Page, productName: string) {
  // The product picker is the only combobox without a name, inside the row.
  const trigger = page.locator('form').getByRole('combobox').last();
  await trigger.click();
  await page.getByRole('listbox').getByRole('option').filter({ hasText: productName }).first().click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

test.describe('Sale line pricing', () => {
  test('TC-PRICE-01: choosing a product prices the line from the channel', async ({
    page,
    request,
  }) => {
    const { productName } = await pricedProductAndCustomer(request);
    await login(page);
    await openOrderForm(page);

    // Channel defaults to B2B.
    await pickProduct(page, productName);
    await expect(unitPrice(page)).toHaveValue(String(B2B_PRICE));
  });

  test('TC-PRICE-02: switching channel re-prices a line still at list price', async ({
    page,
    request,
  }) => {
    const { productName } = await pricedProductAndCustomer(request);
    await login(page);
    await openOrderForm(page);

    await pickProduct(page, productName);
    await expect(unitPrice(page)).toHaveValue(String(B2B_PRICE));

    await pick(page, 'channel', 'B2C');
    await expect(unitPrice(page)).toHaveValue(String(B2C_PRICE));
  });

  test('TC-PRICE-03: a price the seller typed survives a channel change', async ({
    page,
    request,
  }) => {
    // The rule that matters. A negotiated price is a decision, and re-pricing
    // it from a list would quietly overwrite what was agreed with the shop.
    const { productName } = await pricedProductAndCustomer(request);
    await login(page);
    await openOrderForm(page);

    await pickProduct(page, productName);
    await unitPrice(page).fill('1950');

    await pick(page, 'channel', 'B2C');
    await expect(unitPrice(page)).toHaveValue('1950');

    await pick(page, 'channel', 'B2B');
    await expect(unitPrice(page)).toHaveValue('1950');
  });

  test('TC-PRICE-04: choosing a customer sets the channel to their kind', async ({
    page,
    request,
  }) => {
    const { customerName } = await pricedProductAndCustomer(request);
    await login(page);
    await openOrderForm(page);

    // Move away from the default so the change is visible.
    await pick(page, 'channel', 'B2C');
    await expect(page.locator('input[type="hidden"][name="channel"]')).toHaveValue('B2C');

    await pick(page, 'customerId', customerName);
    await expect(page.locator('input[type="hidden"][name="channel"]')).toHaveValue('B2B');
  });

  test('TC-PRICE-05: a product with no price for the channel says so', async ({
    page,
    request,
  }) => {
    const t = await token(request);
    const headers = { Authorization: `Bearer ${t}` };
    const stamp = Date.now();
    const res = await request.post(`${API}/products`, {
      headers,
      data: { name: `Unpriced Part ${stamp}`, minStock: 0 },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    await login(page);
    await openOrderForm(page);
    await pickProduct(page, `Unpriced Part ${stamp}`);

    // Silence here would read as "zero is the price".
    await expect(page.getByText(/no b2b price set/i)).toBeVisible();
  });
});

test.describe('Sale line pricing — pushing on it', () => {
  test('TC-PRICE-06: changing the product on a line re-prices it', async ({ page, request }) => {
    // A line keeping the previous product's price is the kind of error that
    // looks entirely plausible on the row and is wrong by hundreds.
    const { productName, otherProductName } = await pricedProductAndCustomer(request);
    await login(page);
    await openOrderForm(page);

    await pickProduct(page, productName);
    await expect(unitPrice(page)).toHaveValue(String(B2B_PRICE));

    await pickProduct(page, otherProductName);
    await expect(unitPrice(page)).toHaveValue(String(OTHER_B2B));
  });

  test('TC-PRICE-07: switching to a retail customer re-prices at retail', async ({
    page,
    request,
  }) => {
    // The channel follows the customer, and the lines follow the channel.
    const { productName, retailName } = await pricedProductAndCustomer(request);
    await login(page);
    await openOrderForm(page);

    await pickProduct(page, productName);
    await expect(unitPrice(page)).toHaveValue(String(B2B_PRICE));

    await pick(page, 'customerId', retailName);
    await expect(page.locator('input[type="hidden"][name="channel"]')).toHaveValue('B2C');
    await expect(unitPrice(page)).toHaveValue(String(B2C_PRICE));
  });

  test('TC-PRICE-08: a typed price survives a customer switch too', async ({ page, request }) => {
    // The rule is about the seller's judgement, not about which control moved.
    // Testing it only against the channel picker would leave this route open.
    const { productName, retailName } = await pricedProductAndCustomer(request);
    await login(page);
    await openOrderForm(page);

    await pickProduct(page, productName);
    await unitPrice(page).fill('1975');

    await pick(page, 'customerId', retailName);
    await expect(page.locator('input[type="hidden"][name="channel"]')).toHaveValue('B2C');
    await expect(unitPrice(page)).toHaveValue('1975');
  });
});
