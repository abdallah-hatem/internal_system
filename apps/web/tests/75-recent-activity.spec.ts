/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Recent activity on the dashboard
 * ═══════════════════════════════════════════════════════════════════════
 *  The panel read `/audit-logs`. The audit log only holds what was done through
 *  the API's own services — the demo seed writes none — so on a database full
 *  of confirmed sales the panel said "No data". And what it did hold included a
 *  draft being saved, which is not activity: a draft counts for nothing
 *  (BUSINESS_LOGIC §4).
 *
 *  `GET /analytics/recent-activity` builds the feed from the records: realised
 *  sales, payments that stand, verified stock receipts. It is restricted to the
 *  roles that may list sales and payments themselves (rule 12).
 *
 *  These are API cases. The dashboard page is wired to this endpoint by U4,
 *  whose own case — the latest sale shows after confirming, reached by
 *  clicking — is the last test here.
 */
import { test, expect, APIRequestContext, Page } from '@playwright/test';
import { apiCtx, stockedProduct, owedOrder, API, EMAIL, PASSWORD } from './support/fixtures';
import { WEB as BASE } from './support/env';

type Headers = Record<string, string>;

/** One line of the feed, as the API sends it. */
interface ActivityItem {
  kind: 'SALE' | 'PAYMENT' | 'RECEIPT';
  id: string;
  amount?: number;
  customer?: { id: string; displayName: string };
}

async function feed(request: APIRequestContext, headers: Headers, limit = 50) {
  const res = await request.get(`${API}/analytics/recent-activity?limit=${limit}`, { headers });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).data as ActivityItem[];
}

/** A logged-in account with the given role, created by a partner. */
async function accountWithRole(request: APIRequestContext, role: string) {
  const { headers } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(performance.now() % 1000)}`;
  const email = `recent-${role.toLowerCase()}-${stamp}@motoparts.com`;
  const made = await request.post(`${API}/auth/register`, {
    headers,
    data: { email, password: 'password123', displayName: `Recent ${stamp}`, role },
  });
  expect(made.ok(), `create ${role}: ${await made.text()}`).toBeTruthy();
  const signedIn = await request.post(`${API}/auth/login`, {
    data: { email, password: 'password123' },
  });
  return { Authorization: `Bearer ${(await signedIn.json()).data.accessToken}` };
}

async function shopWithStock(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const stamp = Date.now();
  const { product } = await stockedProduct(request, headers, mk, `${label} ${stamp}`, 10);
  const customer = await mk('customers', { displayName: `${label} Shop ${stamp}`, type: 'B2B' });
  return { headers, mk, product, customer };
}

test.describe('Recent activity — what it lists', () => {
  test('TC-RECENT-01: confirming a sale puts it in recent activity', async ({ request }) => {
    const { headers, mk, product, customer } = await shopWithStock(request, 'Recent Sale');
    const order = await owedOrder(mk, customer.id, product.id, 640);

    const items = await feed(request, headers);
    const line = items.find((i) => i.kind === 'SALE' && i.id === order.id);
    expect(line, 'the confirmed sale is in the feed').toBeTruthy();
    expect(line?.amount).toBe(640);
    expect(line?.customer?.id).toBe(customer.id);
  });

  test('TC-RECENT-02: a draft is not activity', async ({ request }) => {
    const { headers, mk, product, customer } = await shopWithStock(request, 'Recent Draft');
    const draft = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: 300, discount: 0 }],
    });

    const items = await feed(request, headers);
    expect(items.some((i) => i.id === draft.id)).toBe(false);
  });

  test('TC-RECENT-03: the same draft appears once it is confirmed (the second visit)', async ({
    request,
  }) => {
    const { headers, mk, product, customer } = await shopWithStock(request, 'Recent Later');
    const draft = await mk('sales/orders', {
      customerId: customer.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: 300, discount: 0 }],
    });
    expect((await feed(request, headers)).some((i) => i.id === draft.id)).toBe(false);

    await mk(`sales/orders/${draft.id}/confirm`, { version: draft.version });
    expect((await feed(request, headers)).some((i) => i.id === draft.id)).toBe(true);
  });

  test('TC-RECENT-04: a cancelled order drops out', async ({ request }) => {
    const { headers, mk, product, customer } = await shopWithStock(request, 'Recent Cancel');
    const order = await owedOrder(mk, customer.id, product.id, 200);
    const res = await request.post(`${API}/sales/orders/${order.id}/cancel`, { headers });
    expect(res.ok(), await res.text()).toBeTruthy();

    expect((await feed(request, headers)).some((i) => i.id === order.id)).toBe(false);
  });

  test('TC-RECENT-05: a payment appears, and a reversed one does not', async ({ request }) => {
    const { headers, mk, product, customer } = await shopWithStock(request, 'Recent Pay');
    // A payment needs something owed: paying a customer who owes nothing is
    // refused (CUSTOMER_OWES_NOTHING, CLAUDE.md rule 1 "too much"). 240 owed
    // covers both payments.
    await owedOrder(mk, customer.id, product.id, 240);
    const kept = await mk('payments', {
      customerId: customer.id, amount: 150, currency: 'EGP', method: 'CASH',
    });
    const reversed = await mk('payments', {
      customerId: customer.id, amount: 90, currency: 'EGP', method: 'CASH',
    });
    const rev = await request.post(`${API}/payments/${reversed.id}/reverse`, {
      headers,
      data: { reason: 'Entered twice' },
    });
    expect(rev.ok(), await rev.text()).toBeTruthy();

    const items = await feed(request, headers);
    expect(items.some((i) => i.kind === 'PAYMENT' && i.id === kept.id)).toBe(true);
    expect(items.some((i) => i.id === reversed.id)).toBe(false);
  });

  test('TC-RECENT-06: the limit is kept to 1..50 and nonsense falls back', async ({ request }) => {
    const { headers } = await apiCtx(request);
    expect((await feed(request, headers, 10_000)).length).toBeLessThanOrEqual(50);
    const res = await request.get(`${API}/analytics/recent-activity?limit=abc`, { headers });
    expect(res.status()).toBe(200);
    expect(((await res.json()).data as ActivityItem[]).length).toBeLessThanOrEqual(10);
  });
});

test.describe('Recent activity — who may read it', () => {
  test('TC-RECENT-07: a temporary investor is refused with a coded error', async ({
    request,
  }) => {
    const headers = await accountWithRole(request, 'TEMP_INVESTOR');
    const res = await request.get(`${API}/analytics/recent-activity`, { headers });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe('ROLE_NOT_ALLOWED');
  });

  test('TC-RECENT-08: support staff may read it', async ({ request }) => {
    const headers = await accountWithRole(request, 'ADMIN_SUPPORT');
    const res = await request.get(`${API}/analytics/recent-activity`, { headers });
    expect(res.status()).toBe(200);
  });
});

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

// U4: the dashboard reads /analytics/recent-activity and refetches it on every
// visit, so a sale confirmed elsewhere shows after clicking back.
test('TC-RECENT-09: the dashboard lists a sale confirmed a moment ago, reached by clicking', async ({
  page,
  request,
}) => {
  const { mk, product, customer } = await shopWithStock(request, 'Recent UI');
  await login(page);
  const order = await owedOrder(mk, customer.id, product.id, 410);

  // Away and back by clicking, so the cached panel is what is under test.
  await page.getByRole('link', { name: 'Customers', exact: true }).first().click();
  // Arrive before leaving again. On a cold dev server /customers compiles for a
  // few seconds, and clicking Dashboard meanwhile never leaves the dashboard —
  // nothing remounts, so nothing refetches, and the test read the stale list.
  await expect(page).toHaveURL(/\/customers/);
  await page.getByRole('link', { name: 'Dashboard', exact: true }).first().click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(order.orderNo)).toBeVisible();
});

// I2 (from I1): a shop's name in the panel is the way to that shop — it was
// plain text, and clicking it did nothing. The walk-in record has no page and
// reads "Walk-in", never "Walk-in" as a link to a record.
test('TC-RECENT-10: a shop named in recent activity opens that shop; a walk-in sale names no record', async ({
  page,
  request,
}) => {
  const { mk, product, customer } = await shopWithStock(request, 'Recent Link');
  const order = await owedOrder(mk, customer.id, product.id, 515);
  const walkIn = await mk('sales/orders', {
    walkIn: true, currency: 'EGP', items: [{ productId: product.id, quantity: 1, unitPrice: 300, discount: 0 }],
  });
  await login(page);

  const panel = page.locator('section[aria-labelledby="recent-activity-heading"]');
  const saleLine = panel.locator('li', { hasText: order.orderNo });
  await expect(saleLine).toBeVisible();
  const walkInLine = panel.locator('li', { hasText: walkIn.orderNo });
  await expect(walkInLine.getByTestId('recent-activity-subject')).toHaveText('Walk-in');
  await expect(walkInLine.getByRole('link')).toHaveCount(0);

  await saleLine.getByRole('link', { name: customer.displayName }).click();
  await expect(page).toHaveURL(new RegExp(`/en/customers/${customer.id}$`), { timeout: 15000 });
  await expect(page.getByRole('main').getByRole('heading', { name: customer.displayName, level: 1 })).toBeVisible();
});
