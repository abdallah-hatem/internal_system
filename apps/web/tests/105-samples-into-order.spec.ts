/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Samples into the current order
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §4 "Samples into the current order" (owner 2026-10-27):
 *  New Order's samples hint lists each product with Add to order and Add
 *  all; the line it adds is tagged "From sample ORD-…" and edits like any
 *  line; on confirm the sample's units move into the sale (more takes the
 *  rest from the shelf, fewer leaves the rest a sample). "They're buying"
 *  asks Keep as sample or Returned for a removed or lowered line.
 *
 *  WRITTEN, NOT RUN (owner 2026-10-27: no Playwright for now). Reached the way
 *  a person reaches it: log in, the navigation, the New Order button, the
 *  customer picker — no `page.goto` after login (CLAUDE.md rule 2). Stock
 *  exists only through a cycle and a verified receipt (rule 4,
 *  `stockedProduct`); samples are left through the office's own endpoint.
 *
 *  The same cases at unit level: apps/api/src/modules/sales/
 *  samples-into-order.db.spec.ts and components/sales/samples-into-order.test.tsx.
 */
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
import { API, apiCtx, stockedProduct } from './support/fixtures';
import { login, openNav } from './support/ui';
import en from '../src/i18n/locales/en.json';

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

async function choose(page: Page, trigger: Locator, label: string) {
  await trigger.click();
  const search = page.locator('[cmdk-input]').filter({ visible: true });
  if (await search.count()) await search.fill(label);
  await page.getByRole('option', { name: new RegExp(escape(label)) }).first().click();
}
const combo = (form: Locator, n: number) => form.getByRole('combobox').nth(n);
const line = (form: Locator, n: number) => form.getByTestId('sale-line').nth(n);
const input = (row: Locator, name: string) => row.locator(`[data-field="${name}"]:not([type="hidden"])`);

/** A shop holding 3 helmets and 2 gloves on one samples order; another shop with nothing. */
async function setup(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const s = stamp();
  const { product: helmet } = await stockedProduct(request, headers, mk, `${label} Helmet ${s}`, 10);
  const { product: gloves } = await stockedProduct(request, headers, mk, `${label} Gloves ${s}`, 10);
  const holder = await mk('customers', { displayName: `${label} Holder ${s}`, type: 'B2B' });
  const other = await mk('customers', { displayName: `${label} Other ${s}`, type: 'B2B' });
  const held = await mk('sales/orders', {
    samples: true,
    customerId: holder.id,
    channel: 'B2B',
    currency: 'EGP',
    items: [
      { productId: helmet.id, quantity: 3 },
      { productId: gloves.id, quantity: 2 },
    ],
  });
  return { headers, helmet, gloves, holder, other, held };
}

async function order(request: APIRequestContext, headers: Record<string, string>, id: string) {
  const res = await request.get(`${API}/sales/orders/${id}`, { headers });
  return (await res.json()).data as {
    status: string;
    items: { productId: string; quantity: string | number }[];
  };
}

test.describe('Samples into the current order (§4, 2026-10-27)', () => {
  test('TC-SIO-01: Add to order one of two products, buy fewer than the sample; the rest stays a sample on the same order', async ({
    page,
    request,
  }) => {
    const { headers, helmet, gloves, holder, held } = await setup(request, 'SIO01');
    await login(page);
    const form = await openNewOrder(page);
    await choose(page, combo(form, 0), holder.displayName);
    const hint = form.getByTestId('samples-at-shop-hint');
    await expect(hint).toBeVisible();

    const helmetRow = hint.getByTestId('samples-at-shop-line').filter({ hasText: helmet.name });
    await helmetRow.getByRole('button', { name: en.sales.samples.addToOrder }).click();
    await expect(helmetRow.getByRole('button', { name: en.sales.samples.added })).toBeDisabled();
    await expect(form.getByTestId('sale-line')).toHaveCount(1);
    await expect(line(form, 0).getByTestId('sale-line-from-sample')).toContainText(held.orderNo);
    // Buys 2 of the 3.
    await input(line(form, 0), 'quantity').fill('2');
    await input(line(form, 0), 'unitPrice').fill('300');
    await form.getByRole('button', { name: en.sales.createAndConfirm }).click();
    await expect(form).toBeHidden();

    const samples = await order(request, headers, held.id);
    expect(samples.status).toBe('SAMPLES');
    const left = Object.fromEntries(samples.items.map((i) => [i.productId, Number(i.quantity)]));
    expect(left).toEqual({ [helmet.id]: 1, [gloves.id]: 2 });
  });

  test('TC-SIO-02: Add all and more than the sample: the samples order closes as bought, the rest comes from the shelf', async ({
    page,
    request,
  }) => {
    const { headers, helmet, holder, held } = await setup(request, 'SIO02');
    await login(page);
    const form = await openNewOrder(page);
    await choose(page, combo(form, 0), holder.displayName);
    const hint = form.getByTestId('samples-at-shop-hint');
    await hint.getByRole('button', { name: en.sales.samples.addAll }).click();
    await expect(form.getByTestId('sale-line')).toHaveCount(2);
    const helmetLine = form.getByTestId('sale-line').filter({ hasText: helmet.name });
    await input(helmetLine, 'quantity').fill('5');
    for (const n of [0, 1]) await input(line(form, n), 'unitPrice').fill('300');
    await form.getByRole('button', { name: en.sales.createAndConfirm }).click();
    await expect(form).toBeHidden();
    expect((await order(request, headers, held.id)).status).toBe('SAMPLES_BOUGHT');
    // The samples order's popup says where its units went.
    await page.getByText(held.orderNo).first().click();
    await expect(page.getByTestId('samples-panel')).toContainText('every unit went into');
  });

  test('TC-SIO-03: the second visit — switching shop drops the sample lines; nothing of the first shop is sold to the second', async ({
    page,
    request,
  }) => {
    const { headers, holder, other, held } = await setup(request, 'SIO03');
    await login(page);
    const form = await openNewOrder(page);
    await choose(page, combo(form, 0), holder.displayName);
    await form.getByTestId('samples-at-shop-hint').getByRole('button', { name: en.sales.samples.addAll }).click();
    await expect(form.getByTestId('sale-line-from-sample')).toHaveCount(2);
    await choose(page, combo(form, 0), other.displayName);
    await expect(form.getByTestId('sale-line-from-sample')).toHaveCount(0);
    await expect(form.getByTestId('sale-line')).toHaveCount(1);
    await page.getByRole('button', { name: en.common.cancel, exact: true }).first().click();
    expect((await order(request, headers, held.id)).status).toBe('SAMPLES');
  });

  test("TC-SIO-04: They're buying — a removed line kept as sample stays on the order; one marked Returned goes back to the shelf", async ({
    page,
    request,
  }) => {
    const { headers, helmet, gloves, holder, held } = await setup(request, 'SIO04');
    await login(page);
    let form = await openNewOrder(page);
    await choose(page, combo(form, 0), holder.displayName);
    await form.getByTestId('samples-at-shop-open').click();
    form = page.getByTestId('sale-order-form');
    await expect(form.getByTestId('samples-convert-note')).toBeVisible();
    // Buy one helmet; the gloves come back.
    const helmetLine = form.getByTestId('sale-line').filter({ hasText: helmet.name });
    await input(helmetLine, 'quantity').fill('1');
    await input(helmetLine, 'unitPrice').fill('300');
    const glovesLine = form.getByTestId('sale-line').filter({ hasText: gloves.name });
    await glovesLine.getByRole('button', { name: en.sales.removeItem }).click();
    const notBought = form.getByTestId('samples-not-bought');
    await expect(notBought.getByTestId('samples-not-bought-line')).toHaveCount(2);
    await notBought
      .getByTestId('samples-not-bought-line')
      .filter({ hasText: gloves.name })
      .getByTestId('samples-return-line')
      .click();
    await form.getByTestId('sale-submit').click();
    await expect(form).toBeHidden();

    const samples = await order(request, headers, held.id);
    expect(samples.status).toBe('SAMPLES');
    expect(samples.items.map((i) => [i.productId, Number(i.quantity)])).toEqual([[helmet.id, 2]]);
  });
});
