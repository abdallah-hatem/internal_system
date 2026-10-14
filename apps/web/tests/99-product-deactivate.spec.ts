/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: deactivating a product (owner, 2026-10-14)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §3 "A product is switched off, never deleted". A partner
 *  deactivates a product and can reactivate it. Switched off, no more of it is
 *  BOUGHT — a new purchase-order line is refused with PRODUCT_INACTIVE and the
 *  buying pickers drop it — while what is on the shelf is still SOLD (owner,
 *  2026-10-14): the sale form, walk-in and storefront keep it, tagged, until
 *  the shelf is empty. Everything that already exists is left alone.
 *
 *  Stock is built as the business builds it (CLAUDE.md §4): a cycle, an order,
 *  a leg and a verified receipt (`stockedProduct`). The screens are reached by
 *  clicking through the navigation (CLAUDE.md §2).
 *
 *  The storefront half is 99-product-deactivate-storefront.spec.ts; the
 *  assistant's matching is pinned in apps/api/src/modules/assistant/tools/
 *  sales.spec.ts and receipt.spec.ts.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { API, apiCtx, daysAgo, refusedCallers, stockedProduct, SHOP_OWNER_EMAIL, PASSWORD } from './support/fixtures';
import { login, openNav, messages, type Locale } from './support/ui';

type Headers = Record<string, string>;
const stamp = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;

/** A product with `qty` units genuinely received, priced on both channels. */
async function stocked(request: APIRequestContext, label: string, qty = 20) {
  const { headers, mk } = await apiCtx(request);
  const { product, cycle, supplier } = await stockedProduct(request, headers, mk, `${label} ${stamp()}`, qty);
  await mk(`products/${product.id}/prices`, { channel: 'B2C', currency: 'EGP', amount: 500 });
  await mk(`products/${product.id}/prices`, { channel: 'B2B', currency: 'EGP', amount: 400 });
  return { headers, mk, product, cycle, supplier };
}

const setStatus = (request: APIRequestContext, headers: Headers, id: string, status: unknown) =>
  request.put(`${API}/products/${id}/status`, { headers, data: { status } });

async function deactivate(request: APIRequestContext, headers: Headers, id: string) {
  const res = await setStatus(request, headers, id, 'INACTIVE');
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function statusOf(request: APIRequestContext, headers: Headers, id: string) {
  const res = await request.get(`${API}/products/${id}`, { headers });
  return (await res.json()).data.status as string;
}

async function onHand(request: APIRequestContext, headers: Headers, productId: string) {
  const res = await request.get(`${API}/inventory?productId=${productId}&limit=100`, { headers });
  const rows = ((await res.json()).data ?? []) as { productId: string; totalStock?: number | string }[];
  return Number(rows.find((r) => r.productId === productId)?.totalStock ?? 0);
}

async function refused(res: { status(): number; json(): Promise<any> }) {
  const body = await res.json();
  return { status: res.status(), code: body?.error?.code, params: body?.error?.params };
}

/** An account of `role`, created by a partner and signed in. */
async function accountWithRole(request: APIRequestContext, role: string): Promise<Headers> {
  const { headers } = await apiCtx(request);
  const email = `deact-${role.toLowerCase()}-${stamp()}@motoparts.com`;
  const made = await request.post(`${API}/auth/register`, {
    headers,
    data: { email, password: PASSWORD, displayName: `Deact ${stamp()}`, role },
  });
  expect(made.ok(), await made.text()).toBeTruthy();
  const signedIn = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  return { Authorization: `Bearer ${(await signedIn.json()).data.accessToken}` };
}

async function shopHeaders(request: APIRequestContext): Promise<Headers> {
  const res = await request.post(`${API}/auth/portal/login`, {
    data: { email: SHOP_OWNER_EMAIL, password: PASSWORD },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

// ── The server ─────────────────────────────────────────────────────────────

test.describe('Switching a product off and on — the server (§3, 2026-10-14)', () => {
  test('TC-DEACT-01: only a core partner may switch a product off or on; the others are refused with a code, and the product is untouched', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const product = await mk('products', { name: `Deact01 Part ${stamp()}`, minStock: 0 });

    const callers = [
      ...(await refusedCallers(request, 'deact01')),
      { who: 'ADMIN_SUPPORT', headers: await accountWithRole(request, 'ADMIN_SUPPORT'), code: 'ROLE_NOT_ALLOWED' },
    ];
    for (const caller of callers) {
      const viaStatus = await refused(await setStatus(request, caller.headers, product.id, 'INACTIVE'));
      expect(viaStatus, caller.who).toMatchObject({ status: 403, code: caller.code });
      const viaUpdate = await refused(
        await request.put(`${API}/products/${product.id}`, { headers: caller.headers, data: { status: 'INACTIVE' } }),
      );
      expect(viaUpdate, caller.who).toMatchObject({ status: 403, code: caller.code });
    }
    expect(await statusOf(request, headers, product.id)).toBe('ACTIVE');

    // The right role still works — a guard that refuses everybody passes half a test.
    const off = await setStatus(request, headers, product.id, 'INACTIVE');
    expect(off.ok(), await off.text()).toBeTruthy();
    expect((await off.json()).data.status).toBe('INACTIVE');
    expect(await statusOf(request, headers, product.id)).toBe('INACTIVE');
  });

  test('TC-DEACT-02: a status other than ACTIVE or INACTIVE is refused (PRODUCT_STATUS_INVALID) on every way in, and nothing is stored', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const product = await mk('products', { name: `Deact02 Part ${stamp()}`, minStock: 0 });

    for (const bad of ['DISCONTINUED', 'inactive', 'Active', '', null, 5, true]) {
      const viaStatus = await refused(await setStatus(request, headers, product.id, bad));
      expect(viaStatus, `status endpoint, ${JSON.stringify(bad)}`).toMatchObject({ status: 400, code: 'PRODUCT_STATUS_INVALID' });
    }
    const missing = await refused(await request.put(`${API}/products/${product.id}/status`, { headers, data: {} }));
    expect(missing).toMatchObject({ status: 400, code: 'PRODUCT_STATUS_INVALID' });

    const viaUpdate = await refused(
      await request.put(`${API}/products/${product.id}`, { headers, data: { status: 'DISCONTINUED' } }),
    );
    expect(viaUpdate).toMatchObject({ status: 400, code: 'PRODUCT_STATUS_INVALID' });
    expect(await statusOf(request, headers, product.id)).toBe('ACTIVE');

    const viaCreate = await refused(
      await request.post(`${API}/products`, { headers, data: { name: `Deact02 New ${stamp()}`, status: 'GONE' } }),
    );
    expect(viaCreate).toMatchObject({ status: 400, code: 'PRODUCT_STATUS_INVALID' });

    // A product id that is no product: a coded 404, never a 500.
    const nobody = await refused(await setStatus(request, headers, '00000000-0000-0000-0000-000000000000', 'INACTIVE'));
    expect(nobody).toMatchObject({ status: 404, code: 'NOT_FOUND', params: { entity: 'product' } });
  });

  test('TC-DEACT-03: a switched-off product still SELLS from the shelf — a draft, create & confirm and a walk-in all go through — and once the shelf is empty a new line is refused as any sold-out product is', async ({ request }) => {
    const { headers, mk, product } = await stocked(request, 'Deact03', 6);
    const shop = await mk('customers', { displayName: `Deact03 Shop ${stamp()}`, type: 'B2B' });
    await deactivate(request, headers, product.id);

    const line = (quantity: number) => ({ productId: product.id, quantity, unitPrice: 400, discount: 0 });
    const draft = await request.post(`${API}/sales/orders`, {
      headers, data: { customerId: shop.id, channel: 'B2B', currency: 'EGP', items: [line(1)] },
    });
    expect(draft.ok(), await draft.text()).toBeTruthy();
    const confirmed = await request.post(`${API}/sales/orders`, {
      headers, data: { customerId: shop.id, channel: 'B2B', currency: 'EGP', confirm: true, items: [line(2)] },
    });
    expect(confirmed.ok(), await confirmed.text()).toBeTruthy();
    expect((await confirmed.json()).data.status).toBe('CONFIRMED');
    const walkIn = await request.post(`${API}/sales/orders`, {
      headers, data: { walkIn: true, currency: 'EGP', items: [{ ...line(4), unitPrice: 500 }] },
    });
    expect(walkIn.ok(), await walkIn.text()).toBeTruthy();
    expect(await onHand(request, headers, product.id)).toBe(0);
    expect(await statusOf(request, headers, product.id)).toBe('INACTIVE');

    // More than is left — nothing now — is refused as for any product.
    const more = await refused(await request.post(`${API}/sales/orders`, {
      headers, data: { customerId: shop.id, channel: 'B2B', currency: 'EGP', confirm: true, items: [line(1)] },
    }));
    expect(more).toMatchObject({ status: 400, code: 'NOT_ENOUGH_STOCK' });
  });

  test('TC-DEACT-04: a new purchase-order line for a switched-off product is refused (PRODUCT_INACTIVE) on a new order and when added to a draft', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const product = await mk('products', { name: `Deact04 Part ${stamp()}`, minStock: 0 });
    const other = await mk('products', { name: `Deact04 Other ${stamp()}`, minStock: 0 });
    const supplier = await mk('suppliers', { name: `Deact04 Supplier ${stamp()}`, country: 'AE' });
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const draft = await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(3),
      items: [{ productId: other.id, orderedQty: 5, unitPrice: 10 }],
    });
    await deactivate(request, headers, product.id);

    const fresh = await refused(
      await request.post(`${API}/cycles/${cycle.id}/purchases`, {
        headers,
        data: {
          supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(1),
          items: [{ productId: product.id, orderedQty: 5, unitPrice: 10 }],
        },
      }),
    );
    expect(fresh).toMatchObject({ status: 400, code: 'PRODUCT_INACTIVE', params: { product: product.name } });

    const added = await refused(
      await request.post(`${API}/purchases/items`, {
        headers,
        data: { purchaseOrderId: draft.id, productId: product.id, orderedQty: 5, unitPrice: 10 },
      }),
    );
    expect(added).toMatchObject({ status: 400, code: 'PRODUCT_INACTIVE' });

    const po = await (await request.get(`${API}/purchases/${draft.id}`, { headers })).json();
    expect(po.data.items.map((i: any) => i.productId)).toEqual([other.id]);
    const orders = await (await request.get(`${API}/cycles/${cycle.id}/purchases`, { headers })).json();
    expect((orders.data ?? orders)).toHaveLength(1);
  });

  test('TC-DEACT-05: a shop can still ask for a switched-off product while it is on the shelf — the request holds the stock — and is refused once there is none', async ({ request }) => {
    const { headers, product } = await stocked(request, 'Deact05', 3);
    await deactivate(request, headers, product.id);
    const shop = await shopHeaders(request);

    const asked = await request.post(`${API}/portal/requests`, { headers: shop, data: { items: [{ productId: product.id, quantity: 3 }] } });
    expect(asked.ok(), await asked.text()).toBeTruthy();
    // All three are held now, so the next ask is refused as for any product.
    const again = await refused(
      await request.post(`${API}/portal/requests`, { headers: shop, data: { items: [{ productId: product.id, quantity: 1 }] } }),
    );
    expect(again).toMatchObject({ status: 400, code: 'NOT_ENOUGH_STOCK' });
  });

  test('TC-DEACT-06: what already exists is untouched — a draft holding it still confirms, a pending storefront request for it can still be approved, its stock stays on the shelf and its page still reads', async ({ request }) => {
    const { headers, mk, product } = await stocked(request, 'Deact06', 20);
    const shopRecord = await mk('customers', { displayName: `Deact06 Shop ${stamp()}`, type: 'B2B' });
    const draft = await mk('sales/orders', {
      customerId: shopRecord.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 3, unitPrice: 400, discount: 0 }],
    });
    const shop = await shopHeaders(request);
    const asked = await request.post(`${API}/portal/requests`, {
      headers: shop, data: { items: [{ productId: product.id, quantity: 2 }] },
    });
    expect(asked.ok(), await asked.text()).toBeTruthy();
    const pending = (await asked.json()).data;

    await deactivate(request, headers, product.id);

    // The page and the shelf.
    const page = await request.get(`${API}/products/${product.id}`, { headers });
    expect(page.ok()).toBeTruthy();
    expect(await onHand(request, headers, product.id)).toBe(20);

    // The draft confirms.
    const confirmed = await request.post(`${API}/sales/orders/${draft.id}/confirm`, { headers, data: { version: draft.version } });
    expect(confirmed.ok(), await confirmed.text()).toBeTruthy();
    expect((await confirmed.json()).data.status).toBe('CONFIRMED');

    // The shop's request, made before the switch, is approved.
    const approved = await request.post(`${API}/order-requests/${pending.id}/approve`, {
      headers, data: { lines: [{ productId: product.id, qtyApproved: 2 }] },
    });
    expect(approved.ok(), await approved.text()).toBeTruthy();

    expect(await onHand(request, headers, product.id)).toBe(15);
    expect(await statusOf(request, headers, product.id)).toBe('INACTIVE');
  });

  test('TC-DEACT-07: switching off twice changes nothing; reactivating lets it be bought again', async ({ request }) => {
    const { headers, mk, product, cycle, supplier } = await stocked(request, 'Deact07', 20);
    await deactivate(request, headers, product.id);
    await deactivate(request, headers, product.id); // the second visit
    expect(await statusOf(request, headers, product.id)).toBe('INACTIVE');

    const fresh = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const po = { supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: daysAgo(1), items: [{ productId: product.id, orderedQty: 5, unitPrice: 10 }] };
    expect(await refused(await request.post(`${API}/cycles/${fresh.id}/purchases`, { headers, data: po }))).toMatchObject({ code: 'PRODUCT_INACTIVE' });

    const on = await setStatus(request, headers, product.id, 'ACTIVE');
    expect(on.ok(), await on.text()).toBeTruthy();
    expect(await statusOf(request, headers, product.id)).toBe('ACTIVE');

    const bought = await request.post(`${API}/cycles/${fresh.id}/purchases`, { headers, data: po });
    expect(bought.ok(), await bought.text()).toBeTruthy();
    expect(cycle.id).not.toBe(fresh.id);
  });
});

test.describe('Switching a product off — what points a shop at it', () => {
  test('TC-DEACT-08: an import request cannot be answered with a switched-off product — the shop could not order it; answering with an active one still works', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const off = await mk('products', { name: `Deact08 Off ${stamp()}`, minStock: 0 });
    const on = await mk('products', { name: `Deact08 On ${stamp()}`, minStock: 0 });
    await deactivate(request, headers, off.id);
    const shop = await shopHeaders(request);
    const asked = await request.post(`${API}/portal/imports`, {
      headers: shop, data: { productName: `Deact08 wish ${stamp()}`, quantity: 3 },
    });
    expect(asked.ok(), await asked.text()).toBeTruthy();
    const id = (await asked.json()).data.id;

    const answer = (productId: string) =>
      request.post(`${API}/import-requests/${id}/answer`, {
        headers, data: { status: 'ANSWERED', decisionNote: 'We have it now.', productId },
      });
    expect(await refused(await answer(off.id))).toMatchObject({ status: 400, code: 'PRODUCT_INACTIVE' });
    const ok = await answer(on.id);
    expect(ok.ok(), await ok.text()).toBeTruthy();
  });
});

// ── The office app, reached by clicking ────────────────────────────────────

async function openProducts(page: Page, locale: Locale = 'en') {
  const m = messages(locale);
  await openNav(page, m.nav.products);
  await expect(page.getByRole('main').getByRole('heading', { name: m.products.title, level: 1 })).toBeVisible();
}

async function search(page: Page, term: string, locale: Locale = 'en') {
  await page.getByRole('main').getByPlaceholder(messages(locale).products.search).fill(term);
}

/** The products list, reduced to the names of rows on screen. */
const rowNames = (page: Page) =>
  page.getByRole('main').locator('table tbody tr td:nth-child(2)').filter({ visible: true });

/** Open a picker and type `term` into its search box. */
async function openPicker(page: Page, trigger: Locator, term: string) {
  await trigger.click();
  const box = page.locator('[cmdk-input]').filter({ visible: true });
  await box.fill(term);
}

test.describe('Switching a product off and on — the office app', () => {
  test('TC-DEACT-10: Deactivate on the product page asks first, says what it does, and the page then shows Inactive with Reactivate in its place', async ({ page, request }) => {
    const { headers, product } = await stocked(request, 'Deact10', 7);
    const m = messages('en');

    await login(page);
    await openProducts(page);
    await search(page, product.name);
    await page.getByRole('main').getByRole('link', { name: product.name }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: product.name, level: 1 })).toBeVisible();

    // Cancel first: asking must not act.
    await main.getByRole('button', { name: m.products.deactivate, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(m.products.deactivateBody);
    await dialog.getByRole('button', { name: m.common.cancel }).click();
    await expect(dialog).toBeHidden();
    expect(await statusOf(request, headers, product.id)).toBe('ACTIVE');

    await main.getByRole('button', { name: m.products.deactivate, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: m.products.deactivate, exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await expect(main.getByTestId('product-status')).toHaveText(m.products.inactive);
    await expect(main.getByRole('button', { name: m.products.reactivate, exact: true })).toBeVisible();
    await expect(main.getByText(m.products.inactiveNotice)).toBeVisible();
    expect(await statusOf(request, headers, product.id)).toBe('INACTIVE');
    // The page keeps its stock: nothing on the shelf moved.
    expect(await onHand(request, headers, product.id)).toBe(7);
  });

  test('TC-DEACT-11: the new-sale picker keeps a switched-off product while it has stock, tagged Inactive, and drops it once the shelf is empty', async ({ page, request }) => {
    const label = `Deact11 ${stamp()}`;
    const { headers, mk } = await apiCtx(request);
    const stockedOff = (await stockedProduct(request, headers, mk, `${label} Left`, 5)).product;
    const emptyOff = await mk('products', { name: `${label} Empty Part`, minStock: 0 });
    const emptyOn = await mk('products', { name: `${label} Fresh Part`, minStock: 0 });
    await deactivate(request, headers, stockedOff.id);
    await deactivate(request, headers, emptyOff.id);
    const m = messages('en');

    await login(page);
    await openNav(page, m.nav.sales);
    await page.getByRole('button', { name: m.sales.create }).first().click();
    const form = page.getByTestId('sale-order-form');
    await expect(form).toBeVisible();
    await openPicker(page, form.getByTestId('sale-line').first().getByRole('combobox').first(), label);

    const left = page.getByRole('option', { name: new RegExp(stockedOff.name) });
    await expect(left).toBeVisible();
    await expect(left).toContainText(m.sales.inactiveTag);
    await expect(left).toBeEnabled();
    // Sold out and switched off: gone. Sold out and on: still listed (disabled) as before.
    await expect(page.getByRole('option', { name: new RegExp(emptyOff.name) })).toHaveCount(0);
    await expect(page.getByRole('option', { name: new RegExp(emptyOn.name) })).toHaveCount(1);
    await expect(page.getByRole('option', { name: new RegExp(emptyOn.name) })).not.toContainText(m.sales.inactiveTag);
  });

  test('TC-DEACT-12: the products list opens on Active; Inactive shows only the switched-off one; All shows both', async ({ page, request }) => {
    const label = `Deact12 ${stamp()}`;
    const { headers, mk } = await apiCtx(request);
    const off = await mk('products', { name: `${label} Off`, minStock: 0 });
    const on = await mk('products', { name: `${label} On`, minStock: 0 });
    await deactivate(request, headers, off.id);
    const m = messages('en');

    await login(page);
    await openProducts(page);
    await search(page, label);
    const filter = page.getByRole('main').getByTestId('status-filter');
    await expect(filter.getByRole('button', { name: m.products.active, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(rowNames(page)).toHaveText([on.name]);

    await filter.getByRole('button', { name: m.products.inactive, exact: true }).click();
    await expect(rowNames(page)).toHaveText([off.name]);

    await filter.getByRole('button', { name: m.products.filterAll, exact: true }).click();
    // Newest first, as the list always orders.
    await expect(rowNames(page)).toHaveText([on.name, off.name]);
  });

  test('TC-DEACT-13: a switched-off product is not offered on a new purchase order; Reactivate from the row\'s actions asks, puts it back under Active and back in that picker', async ({ page, request }) => {
    const label = `Deact13 ${stamp()}`;
    const { headers, mk } = await apiCtx(request);
    const product = (await stockedProduct(request, headers, mk, label, 5)).product;
    await deactivate(request, headers, product.id);
    const m = messages('en');

    await login(page);
    const poPicker = async () => {
      await openNav(page, m.nav.purchases);
      await page.getByRole('main').getByTestId('create-action').click();
      await page.getByRole('button', { name: m.purchases.addItem }).click();
      await openPicker(page, page.getByRole('combobox').filter({ visible: true }).last(), label);
    };
    await poPicker();
    await expect(page.getByRole('option', { name: new RegExp(product.name) })).toHaveCount(0);
    await page.keyboard.press('Escape'); // the picker
    await page.getByRole('button', { name: m.common.cancel, exact: true }).click(); // the order
    await expect(page.getByRole('heading', { name: m.purchases.create })).toBeHidden();

    await openProducts(page);
    await search(page, label);
    const main = page.getByRole('main');
    await expect(rowNames(page)).toHaveCount(0);
    await main.getByTestId('status-filter').getByRole('button', { name: m.products.inactive, exact: true }).click();
    const row = main.locator('table tbody tr').filter({ hasText: product.name });
    await row.getByRole('button', { name: m.products.reactivate }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(m.products.reactivateBody);
    await dialog.getByRole('button', { name: m.products.reactivate, exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect(rowNames(page)).toHaveCount(0); // it left the Inactive view
    await main.getByTestId('status-filter').getByRole('button', { name: m.products.active, exact: true }).click();
    await expect(rowNames(page)).toHaveText([product.name]);
    expect(await statusOf(request, headers, product.id)).toBe('ACTIVE');

    // Back in the purchase picker, through the menu — the cached list must not lie.
    await poPicker();
    await expect(page.getByRole('option', { name: new RegExp(product.name) })).toBeVisible();
  });
});
