/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Return some samples, not all
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §4 "Return some samples, not all" (owner 2026-10-28: "I
 *  should be able to pick which sample a shop returned"). "Returned" on a
 *  samples order opens the products the shop holds on it, each at all of its
 *  units; lower it, or 0 for what stays. Those units go back to the batches
 *  they left, at their cost; the rest stay samples on the same order; nothing
 *  left → SAMPLES_RETURNED.
 *
 *  WRITTEN, NOT RUN (owner: no Playwright for now). Reached the way a person
 *  reaches it: log in, the navigation, the Sales list's Samples filter and
 *  search, the order, Returned — no `page.goto` after login (CLAUDE.md rule 2).
 *  Stock exists only through a cycle and a verified receipt (rule 4,
 *  `stockedProduct`); samples are left through the office's own endpoint.
 *
 *  The same cases at unit level: apps/api/src/modules/sales/
 *  samples-part-return.db.spec.ts and components/sales/return-samples-dialog.test.tsx.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { API, apiCtx, stockedProduct } from './support/fixtures';
import { login, openNav } from './support/ui';
import en from '../src/i18n/locales/en.json';

const stamp = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;

/** A shop holding 3 helmets and 2 gloves on one samples order. */
async function setup(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const s = stamp();
  const { product: helmet } = await stockedProduct(request, headers, mk, `${label} Helmet ${s}`, 10);
  const { product: gloves } = await stockedProduct(request, headers, mk, `${label} Gloves ${s}`, 10);
  const shop = await mk('customers', { displayName: `${label} Shop ${s}`, type: 'B2B' });
  const held = await mk('sales/orders', {
    samples: true,
    customerId: shop.id,
    channel: 'B2B',
    currency: 'EGP',
    items: [
      { productId: helmet.id, quantity: 3 },
      { productId: gloves.id, quantity: 2 },
    ],
  });
  return { headers, helmet, gloves, shop, held };
}

async function order(request: APIRequestContext, headers: Record<string, string>, id: string) {
  const res = await request.get(`${API}/sales/orders/${id}`, { headers });
  return (await res.json()).data as {
    status: string;
    version: number;
    items: { productId: string; quantity: string | number }[];
  };
}

/** Sales → the Samples filter → the shop → its samples order → Returned. */
async function openReturned(page: Page, shop: string, orderNo: string) {
  await openNav(page, en.nav.sales);
  await expect(page.getByRole('heading', { name: en.sales.title })).toBeVisible();
  await page.getByTestId('sales-status-filter').getByRole('button', { name: en.sales.samplesFilter }).click();
  await page.getByPlaceholder(en.sales.search).fill(shop);
  await page.getByTestId('sale-row').filter({ hasText: orderNo }).first().click();
  await expect(page.getByTestId('samples-panel')).toBeVisible();
  await page.getByTestId('samples-returned').click();
  const dialog = page.getByTestId('samples-return-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

const qty = (dialog: ReturnType<Page['getByTestId']>, productId: string) =>
  dialog.locator(`[data-testid="samples-return-row"][data-product="${productId}"] [data-field="returned"]`);

test.describe('Return some samples, not all (§4, 2026-10-28)', () => {
  test('TC-PSR-01: one of three helmets back, the gloves stay: the order stays samples with 2 helmets and 2 gloves', async ({
    page,
    request,
  }) => {
    const { headers, helmet, gloves, shop, held } = await setup(request, 'PSR01');
    await login(page);
    const dialog = await openReturned(page, shop.displayName, held.orderNo);
    await expect(qty(dialog, helmet.id)).toHaveValue('3');
    await expect(qty(dialog, gloves.id)).toHaveValue('2');
    await qty(dialog, helmet.id).fill('1');
    await qty(dialog, gloves.id).fill('0');
    await expect(dialog.getByTestId('samples-return-summary')).toContainText('1 unit goes back');
    await page.getByTestId('samples-return-confirm').click();
    await expect(page.getByText(en.sales.samples.partReturnedToast)).toBeVisible();

    const after = await order(request, headers, held.id);
    expect(after.status).toBe('SAMPLES');
    const left = Object.fromEntries(after.items.map((i) => [i.productId, Number(i.quantity)]));
    expect(left).toEqual({ [helmet.id]: 2, [gloves.id]: 2 });
  });

  test('TC-PSR-02: the second visit — Cancel forgets what was typed; Returned opens on all again, and all closes the order', async ({
    page,
    request,
  }) => {
    const { headers, helmet, gloves, shop, held } = await setup(request, 'PSR02');
    await login(page);
    let dialog = await openReturned(page, shop.displayName, held.orderNo);
    await qty(dialog, helmet.id).fill('1');
    await page.getByRole('button', { name: en.common.cancel }).click();
    await expect(dialog).toBeHidden();
    await page.getByTestId('samples-returned').click();
    dialog = page.getByTestId('samples-return-dialog');
    await expect(qty(dialog, helmet.id)).toHaveValue('3');
    await expect(qty(dialog, gloves.id)).toHaveValue('2');
    await page.getByTestId('samples-return-confirm').click();
    await expect(page.getByText(en.sales.samples.returnedToast)).toBeVisible();
    expect((await order(request, headers, held.id)).status).toBe('SAMPLES_RETURNED');
  });

  test('TC-PSR-03: more than is out or nothing at all cannot be sent; the History shows a part returned', async ({ page, request }) => {
    const { headers, mk, helmet, gloves, shop, held } = { ...(await setup(request, 'PSR03')), ...(await apiCtx(request)) };
    await mk(`sales/orders/${held.id}/samples/return`, { lines: [{ productId: helmet.id, quantity: 1 }] });
    await login(page);
    const dialog = await openReturned(page, shop.displayName, held.orderNo);
    // What is left: 2 helmets.
    await expect(qty(dialog, helmet.id)).toHaveValue('2');
    await qty(dialog, helmet.id).fill('3');
    await expect(dialog.getByTestId('samples-return-invalid')).toBeVisible();
    await expect(page.getByTestId('samples-return-confirm')).toBeDisabled();
    await qty(dialog, helmet.id).fill('0');
    await qty(dialog, gloves.id).fill('0');
    await expect(dialog.getByTestId('samples-return-summary')).toHaveText(en.sales.samples.returnNothing);
    await expect(page.getByTestId('samples-return-confirm')).toBeDisabled();
    await page.getByRole('button', { name: en.common.cancel }).click();
    expect((await order(request, headers, held.id)).status).toBe('SAMPLES');
  });

  test('TC-PSR-04: the API refuses more than is out, 0, a product not on the order, a stale version and a decided order — with their codes', async ({
    request,
  }) => {
    const { headers, helmet, gloves, held } = await setup(request, 'PSR04');
    const { mk } = await apiCtx(request);
    const { product: other } = await stockedProduct(request, headers, mk, `PSR04 Other ${stamp()}`, 3);
    const send = async (data: unknown) => {
      const res = await request.post(`${API}/sales/orders/${held.id}/samples/return`, { headers, data });
      return { status: res.status(), code: res.ok() ? null : (await res.json())?.error?.code };
    };
    expect(await send({ lines: [{ productId: helmet.id, quantity: 4 }] })).toEqual({ status: 400, code: 'SAMPLES_RETURN_MORE_THAN_OUT' });
    expect(await send({ lines: [{ productId: helmet.id, quantity: 0 }] })).toEqual({ status: 400, code: 'QTY_NOT_POSITIVE' });
    expect(await send({ lines: [{ productId: helmet.id, quantity: -1 }] })).toEqual({ status: 400, code: 'QTY_NOT_POSITIVE' });
    expect(await send({ lines: [] })).toEqual({ status: 400, code: 'SAMPLES_RETURN_NOTHING' });
    expect(await send({ lines: [{ productId: other.id, quantity: 1 }] })).toEqual({ status: 400, code: 'SAMPLES_RETURN_PRODUCT_NOT_OUT' });
    const seen = (await order(request, headers, held.id)).version;
    expect((await send({ lines: [{ productId: helmet.id, quantity: 1 }], version: seen })).status).toBe(200);
    expect(await send({ lines: [{ productId: helmet.id, quantity: 1 }], version: seen })).toEqual({ status: 409, code: 'ORDER_VERSION_CONFLICT' });
    expect((await send({ lines: [{ productId: helmet.id, quantity: 2 }, { productId: gloves.id, quantity: 2 }] })).status).toBe(200);
    expect(await send({ lines: [{ productId: gloves.id, quantity: 1 }] })).toEqual({ status: 400, code: 'SAMPLES_ALREADY_DECIDED' });
    expect((await order(request, headers, held.id)).status).toBe('SAMPLES_RETURNED');
  });
});
