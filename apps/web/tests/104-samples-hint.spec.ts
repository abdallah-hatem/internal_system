/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: New Order warns when the shop holds samples
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §4 "Samples at shops" (owner 2026-10-25): picking a shop
 *  with samples out shows, above the lines, each product and its units from
 *  its open samples orders, with a link to that order's "They're buying". The
 *  hint never blocks the new order.
 *
 *  Reached the way a person reaches it: log in, the navigation, the New Order
 *  button, the customer picker. No `page.goto` after the login page — the hint
 *  is cached per shop, and a full load would wipe the cache a stale hint
 *  lives in (CLAUDE.md rule 2). Stock exists only through a cycle and a
 *  verified receipt (rule 4, `stockedProduct`); samples are left and decided
 *  through the office's own endpoints.
 *
 *  Unit tests for the same cases: apps/api/src/modules/sales/samples.db.spec.ts
 *  (the reading), components/sales/samples-at-shop-hint.test.tsx (the form).
 */
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
import { API, apiCtx, stockedProduct } from './support/fixtures';
import { login, openNav } from './support/ui';
import en from '../src/i18n/locales/en.json';
import ar from '../src/i18n/locales/ar.json';

const stamp = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function openNewOrder(page: Page) {
  await openNav(page, en.nav.sales);
  await expect(page.getByRole('heading', { name: en.sales.title })).toBeVisible();
  await page.getByRole('button', { name: en.sales.create }).first().click();
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
const combo = (form: Locator, n: number) => form.getByRole('combobox').nth(n);
const line = (form: Locator, n: number) => form.getByTestId('sale-line').nth(n);
const input = (row: Locator, name: string) => row.locator(`[data-field="${name}"]:not([type="hidden"])`);

/**
 * Two products in stock and four shops: one holding a helmet and two gloves,
 * one holding nothing, one whose samples came back, and one holding samples
 * of its own (another shop's, which must never show).
 */
async function setup(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const s = stamp();
  const { product: helmet } = await stockedProduct(request, headers, mk, `${label} Helmet ${s}`, 20);
  const { product: gloves } = await stockedProduct(request, headers, mk, `${label} Gloves ${s}`, 20);
  const shop = (name: string) => mk('customers', { displayName: `${label} ${name} ${s}`, type: 'B2B' });
  const holder = await shop('Holder');
  const empty = await shop('Empty');
  const returned = await shop('Returned');
  const other = await shop('Other');
  const leave = (customerId: string, items: { productId: string; quantity: number }[]) =>
    mk('sales/orders', { samples: true, customerId, channel: 'B2B', currency: 'EGP', items });

  const held = await leave(holder.id, [
    { productId: helmet.id, quantity: 1 },
    { productId: gloves.id, quantity: 2 },
  ]);
  const back = await leave(returned.id, [{ productId: helmet.id, quantity: 3 }]);
  await mk(`sales/orders/${back.id}/samples/return`, {});
  await leave(other.id, [{ productId: gloves.id, quantity: 4 }]);
  return { headers, helmet, gloves, holder, empty, returned, other, held };
}

async function statusOf(request: APIRequestContext, headers: Record<string, string>, id: string) {
  const res = await request.get(`${API}/sales/orders/${id}`, { headers });
  return ((await res.json()).data as { status: string }).status;
}

test.describe('New Order — the shop holds samples (§4, 2026-10-25)', () => {
  test('TC-SH-01: each product and its units above the lines; nothing for a shop with none, with returned samples, or for another shop; switching never leaves a stale hint; and the order still goes through', async ({
    page,
    request,
  }) => {
    const { headers, helmet, gloves, holder, empty, returned, held } = await setup(request, 'SH01');
    await login(page);
    const form = await openNewOrder(page);
    const hint = form.getByTestId('samples-at-shop-hint');
    await expect(hint).toHaveCount(0);

    await choose(page, combo(form, 0), holder.displayName);
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(`(${held.orderNo}, left`);
    await expect(hint).toContainText(`1 ${helmet.name}`);
    await expect(hint).toContainText(`2 ${gloves.name}`);
    await expect(hint).toContainText('as samples');
    // Above the lines.
    const hintBox = (await hint.boundingBox())!;
    const lineBox = (await line(form, 0).boundingBox())!;
    expect(hintBox.y).toBeLessThan(lineBox.y);

    // Another shop: the holder's hint goes, and nothing of the other shop's shows.
    await choose(page, combo(form, 0), empty.displayName);
    await expect(hint).toHaveCount(0);
    // Samples that came back are no longer out.
    await choose(page, combo(form, 0), returned.displayName);
    await expect(hint).toHaveCount(0);
    // The second visit: back to the holder, the hint is back.
    await choose(page, combo(form, 0), holder.displayName);
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(held.orderNo);

    // The hint never blocks: 5 more helmets, a separate purchase.
    await choose(page, combo(form, 3), helmet.name);
    await input(line(form, 0), 'quantity').fill('5');
    await input(line(form, 0), 'unitPrice').fill('300');
    await form.getByRole('button', { name: en.sales.createAndConfirm }).click();
    await expect(form).toBeHidden();
    const res = await request.get(`${API}/sales/orders?customerId=${holder.id}&limit=100`, { headers });
    const orders = ((await res.json()).data ?? []) as { status: string }[];
    expect(orders.map((o) => o.status).sort()).toEqual(['CONFIRMED', 'SAMPLES']);
    expect(await statusOf(request, headers, held.id)).toBe('SAMPLES');
  });

  test('TC-SH-02: the link opens that samples order\'s "They\'re buying"; once bought, New Order on the same shop shows no hint (no reload)', async ({
    page,
    request,
  }) => {
    const { headers, holder, held } = await setup(request, 'SH02');
    await login(page);
    let form = await openNewOrder(page);
    await choose(page, combo(form, 0), holder.displayName);
    const hint = form.getByTestId('samples-at-shop-hint');
    await expect(hint).toBeVisible();

    await hint.getByRole('button', { name: `They're buying — open ${held.orderNo}` }).click();
    // New Order closed; "They're buying" for that order opened, every line on it.
    await expect(page.getByRole('heading', { name: en.sales.create, exact: true })).toHaveCount(0);
    form = page.getByTestId('sale-order-form');
    await expect(form.getByTestId('samples-convert-note')).toBeVisible();
    await expect(page.getByText(`Complete sale from samples ${held.orderNo}`)).toBeVisible();
    await expect(form.getByTestId('sale-line')).toHaveCount(2);
    for (const n of [0, 1]) await input(line(form, n), 'unitPrice').fill('300');
    await form.getByTestId('sale-submit').click();
    await expect(form).toBeHidden();
    expect(await statusOf(request, headers, held.id)).toBe('CONFIRMED');

    // The same page, the same cache: the shop holds nothing now.
    await page.getByRole('button', { name: en.sales.create }).first().click();
    form = page.getByTestId('sale-order-form');
    // Wait for the shop's reading to land before saying the hint is absent.
    const answered = page.waitForResponse(
      (r) => r.url().includes('/sales/orders/samples-at-shop') && r.url().includes(holder.id),
    );
    await choose(page, combo(form, 0), holder.displayName);
    await answered;
    await expect(form.getByTestId('sale-line')).toHaveCount(1);
    await expect(form.getByTestId('samples-at-shop-hint')).toHaveCount(0);
  });

  test('TC-SH-03: in Arabic, the hint is in Arabic', async ({ page, request }) => {
    const { holder, held } = await setup(request, 'SH03');
    await login(page, 'ar');
    await openNav(page, ar.nav.sales);
    await page.getByRole('button', { name: ar.sales.create }).first().click();
    const form = page.getByTestId('sale-order-form');
    await choose(page, combo(form, 0), holder.displayName);
    const hint = form.getByTestId('samples-at-shop-hint');
    await expect(hint).toContainText('هذا المحل لديه');
    await expect(hint).toContainText(held.orderNo);
    await expect(hint).toContainText(ar.sales.samples.holdsHint);
  });
});
