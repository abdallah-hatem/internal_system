/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Stock, moved through the deployed app in a browser
 * ═══════════════════════════════════════════════════════════════════════
 *  60 audits production's numbers over HTTP and 61 walks its screens. Neither
 *  changes anything, so neither could have caught what this found on its first
 *  run: `POST /receipts/verify` returned 500 on every call in production and
 *  stock could not be received at all. A read-only suite watching an empty
 *  shelf reports an empty shelf.
 *
 *  So this one moves stock, and watches the screens agree at each step:
 *
 *    receive it   → the inventory page shows it
 *    sell it      → the page shows less
 *    cancel       → the page shows it back
 *
 *  The assertions are on what the page renders, not on what the API returned
 *  to produce it — a figure can be right in JSON and wrong by the time someone
 *  reads it, and the screen is where the business makes decisions.
 *
 *  It WRITES to production, deliberately and with the owner's agreement. Every
 *  record it makes is stamped with a run id so what it left behind can be told
 *  apart from real business, and it puts the stock back before it finishes.
 *
 *      API_BASE=https://internal-system-api.vercel.app/api/v1 \
 *        npx playwright test tests/62-production-stock-flow.spec.ts --project=chromium
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { API, EMAIL, PASSWORD, daysAgo, today } from './support/fixtures';

const OFFICE = process.env.OFFICE_BASE ?? 'https://internal-system-web-three.vercel.app';

/** Stamped on everything, so this run's records are identifiable forever. */
const RUN = `E2E-${Date.now().toString().slice(-6)}`;

test.describe.configure({ mode: 'serial' });

async function headers(request: APIRequestContext) {
  const res = await request.post(`${API}/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

async function signIn(page: Page) {
  await page.goto(`${OFFICE}/en/login`, { waitUntil: 'domcontentloaded' });
  const email = page.locator('input[type="email"]');
  const password = page.locator('input[type="password"]');
  await expect(email).toBeVisible();

  // Hydration: `fill` lands before React mounts and the value is discarded.
  await expect
    .poll(async () => {
      await email.click();
      await email.fill('');
      await email.pressSequentially(EMAIL, { delay: 10 });
      await password.fill('');
      await password.pressSequentially(PASSWORD, { delay: 10 });
      return (await email.inputValue()) === EMAIL;
    }, { timeout: 60_000, message: 'the login form kept discarding what was typed' })
    .toBe(true);

  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/dashboard/);
}

/** What the inventory PAGE says this product holds. Null when it has no row. */
async function stockOnScreen(page: Page, productName: string): Promise<number | null> {
  await page.goto(`${OFFICE}/en/inventory`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  const row = page.locator('tr', { hasText: productName }).first();
  if ((await row.count()) === 0) return null;
  // The stock column, read as the first standalone integer after the name.
  const text = (await row.innerText()).replace(/,/g, '');
  const after = text.slice(text.indexOf(productName) + productName.length);
  const m = after.match(/\b(\d+)\b/);
  return m ? Number(m[1]) : null;
}

let ctx: { product: any; cycleId: string; poItemId: string; customerId: string };

test.describe('Stock through the deployed app', () => {
  test('TC-FLOW-01: a cycle can be bought, shipped and landed', async ({ request }) => {
    const h = await headers(request);
    const mk = async (path: string, data: any) => {
      const res = await request.post(`${API}/${path}`, { headers: h, data });
      expect(res.ok(), `${path}: ${await res.text()}`).toBeTruthy();
      const body = await res.json();
      return body.data ?? body;
    };

    // Its own product, supplier and customer. A fixture that owns what it
    // asserts on is exact whatever else production holds.
    const category = (await (await request.get(`${API}/categories`, { headers: h })).json()).data[0];
    const product = await mk('products', {
      sku: `${RUN}-SKU`, name: `${RUN} Test Part`, categoryId: category.id, minStock: 0,
    });
    const supplier = await mk('suppliers', { name: `${RUN} Supplier`, country: 'UAE' });
    const customer = await mk('customers', { displayName: `${RUN} Shop`, type: 'B2B' });

    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });
    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id, currency: 'AED', fxRateToEgp: 13.85, orderedOn: today(),
      items: [{ productId: product.id, orderedQty: 20, unitPrice: 100, discount: 0 }],
    });
    await mk(`cycles/${cycle.id}/shipping-legs`, {
      sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
      costBasis: 'FLAT', amount: 2000, currency: 'EGP', fxRateToEgp: 1,
      departedOn: daysAgo(5), arrivedOn: daysAgo(1),
    });

    // The route a UAE-direct cycle actually takes. Guessed at first, and the
    // API refused: from PURCHASING the goods reach the UAE before they are in
    // transit to Egypt. The stages exist because the business works that way.
    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }

    const detail = (await (await request.get(`${API}/cycles/${cycle.id}`, { headers: h })).json()).data;
    const poItem = detail.purchaseOrders[0].items[0];

    // The call that was returning 500 in production on every attempt.
    await mk('receipts/verify', {
      cycleId: cycle.id,
      items: [{ purchaseOrderItemId: poItem.id, productId: product.id, receivedQty: 20 }],
    });

    ctx = { product, cycleId: cycle.id, poItemId: poItem.id, customerId: customer.id };
  });

  test('TC-FLOW-02: the received stock is on the inventory screen', async ({ page }) => {
    await signIn(page);
    // Twenty were received, so twenty is what the shelf must say.
    expect(await stockOnScreen(page, ctx.product.name), 'the landed stock never reached the page').toBe(20);
  });

  test('TC-FLOW-03: selling reduces what the screen shows', async ({ page, request }) => {
    const h = await headers(request);
    const order = (await (await request.post(`${API}/sales/orders`, {
      headers: h,
      data: {
        customerId: ctx.customerId, channel: 'B2B', currency: 'EGP', orderedOn: today(),
        items: [{ productId: ctx.product.id, quantity: 5, unitPrice: 400, discount: 0 }],
      },
    })).json()).data;
    const confirmed = await request.post(`${API}/sales/orders/${order.id}/confirm`, { headers: h });
    expect(confirmed.ok(), await confirmed.text()).toBeTruthy();

    await signIn(page);
    // Five sold out of twenty. A screen still showing twenty is a promise the
    // business cannot keep, and the storefront reads the same number.
    expect(await stockOnScreen(page, ctx.product.name), 'the sale did not reach the inventory screen').toBe(15);
    (ctx as any).orderId = order.id;
  });

  test('TC-FLOW-04: cancelling puts it back on the screen', async ({ page, request }) => {
    const h = await headers(request);
    const cancelled = await request.post(`${API}/sales/orders/${(ctx as any).orderId}/cancel`, { headers: h });
    expect(cancelled.ok(), await cancelled.text()).toBeTruthy();

    await signIn(page);
    // Back to twenty. Stock that a cancelled order keeps hold of is stock
    // nobody can sell and no screen explains.
    expect(await stockOnScreen(page, ctx.product.name), 'cancelling did not return the stock').toBe(20);
  });
});
