/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Tab summaries
 * ═══════════════════════════════════════════════════════════════════════
 *  A few cards at the top of Cycles, Products and Sales (owner 2026-10-18:
 *  "top-earning cycles on Cycles, top-selling products on Products, the order
 *  with the most revenue and the largest order on Sales").
 *
 *  Every figure on a card must be the API's analytics figure — never a second
 *  sum in the browser (rule 11) — so each test reads the endpoint and checks
 *  the screen says the same. The sales cards are driven: an order is made to
 *  be the biggest, a draft bigger still must not take its place.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, apiCtx, refusedCallers, stockedProduct } from './support/fixtures';
import { login, messages, openNav, openView } from './support/ui';

const en = messages('en');
const stamp = Date.now();

type Headers = Record<string, string>;
const read = async (request: APIRequestContext, headers: Headers, path: string) => {
  const res = await request.get(`${API}/${path}`, { headers });
  expect(res.ok(), `${path}: ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  return body.data ?? body;
};

interface CycleRow { cycleId: string; cycleCode: string; profit: number }
interface ProductRow { productId: string; name: string; totalQuantitySold: number }
interface TopOrder { orderId: string; orderNo: string; revenueEgp: number; units: number }

const cards = (page: Page, testId: string) =>
  page.getByRole('main').getByTestId(testId).getByTestId('summary-card');

test.describe('Tab summaries', () => {
  test('TC-TABSUM-01: Cycles shows the most profitable cycles, in the API order, linked', async ({ page, request }) => {
    const { headers } = await apiCtx(request);
    const rows = (await read(request, headers, 'analytics/cycle-profitability')) as CycleRow[];
    const expected = rows
      .filter((c) => c.profit > 0)
      .sort((a, b) => b.profit - a.profit || a.cycleCode.localeCompare(b.cycleCode))
      .slice(0, 3);

    await login(page);
    await openView(page, 'cycles');
    // Wait for the list itself, so an absent strip means "nothing earned", not "not yet".
    await expect(page.getByRole('main').getByTestId('cycle-row').first().or(page.getByRole('main').getByText(en.cycles.emptyTitle))).toBeVisible({ timeout: 15000 });

    if (expected.length === 0) {
      await expect(page.getByRole('main').getByTestId('cycles-summary')).toHaveCount(0);
      return;
    }
    const shown = cards(page, 'cycles-summary');
    await expect(shown).toHaveCount(expected.length);
    for (const [i, c] of expected.entries()) {
      await expect(shown.nth(i)).toContainText(c.cycleCode);
    }
    await shown.first().click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${expected[0].cycleId}/details$`), { timeout: 15000 });
  });

  test('TC-TABSUM-02: Products shows the best sellers by units, none that sold nothing', async ({ page, request }) => {
    const { headers } = await apiCtx(request);
    const rows = (await read(request, headers, 'analytics/top-products?limit=3&by=units')) as ProductRow[];
    const expected = rows.filter((p) => p.totalQuantitySold > 0);

    await login(page);
    await openView(page, 'products');
    await expect(page.getByRole('main').getByTestId('products-summary-skeleton')).toHaveCount(0, { timeout: 15000 });
    if (expected.length === 0) {
      await expect(page.getByRole('main').getByTestId('products-summary')).toHaveCount(0);
      return;
    }
    const shown = cards(page, 'products-summary');
    await expect(shown).toHaveCount(expected.length, { timeout: 15000 });
    for (const [i, p] of expected.entries()) {
      await expect(shown.nth(i)).toContainText(p.name);
      await expect(shown.nth(i)).toHaveAttribute('href', new RegExp(`/products/${p.productId}$`));
    }
  });

  test('TC-TABSUM-03: Sales — the biggest sale and the largest order, a draft never counted', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const before = (await read(request, headers, 'analytics/top-orders')) as {
      mostRevenue: TopOrder | null;
      mostUnits: TopOrder | null;
    };
    const unitsToBeat = Math.ceil(before.mostUnits?.units ?? 0) + 1;
    const revenueToBeat = Math.ceil(before.mostRevenue?.revenueEgp ?? 0) + 100000;

    const { product } = await stockedProduct(request, headers, mk, `TabSum ${stamp}`, unitsToBeat + 5);
    const customer = await mk('customers', { displayName: `TabSum Shop ${stamp}`, type: 'B2B' });
    const sell = async (quantity: number, unitPrice: number, confirm: boolean) => {
      const order = await mk('sales/orders', {
        customerId: customer.id, channel: 'B2B', currency: 'EGP',
        items: [{ productId: product.id, quantity, unitPrice, discount: 0 }],
      });
      if (confirm) await mk(`sales/orders/${order.id}/confirm`, { version: order.version });
      return order;
    };
    // One unit worth more than every sale so far; many units at a modest price.
    const big = await sell(1, revenueToBeat, true);
    const many = await sell(unitsToBeat, 20, true);
    // A draft bigger than both on each measure: a quote, not a sale.
    await sell(4, revenueToBeat * 10, false);

    const after = (await read(request, headers, 'analytics/top-orders')) as {
      mostRevenue: TopOrder;
      mostUnits: TopOrder;
    };
    expect(after.mostRevenue.orderNo).toBe(big.orderNo);
    expect(after.mostRevenue.revenueEgp).toBe(revenueToBeat);
    expect(after.mostUnits.orderNo).toBe(many.orderNo);
    expect(after.mostUnits.units).toBe(unitsToBeat);

    await login(page);
    await openNav(page, en.nav.sales);
    const shown = cards(page, 'sales-summary');
    await expect(shown).toHaveCount(2, { timeout: 15000 });
    await expect(shown.nth(0)).toContainText(en.tabSummary.mostRevenue);
    await expect(shown.nth(0)).toContainText(big.orderNo);
    await expect(shown.nth(1)).toContainText(en.tabSummary.mostUnits);
    await expect(shown.nth(1)).toContainText(many.orderNo);

    // A card opens its order, as a row does.
    await shown.nth(0).click();
    await expect(page.getByRole('dialog')).toContainText(big.orderNo, { timeout: 15000 });
  });

  test('TC-TABSUM-04: top orders is refused to anyone but the partners and support', async ({ request }) => {
    for (const { who, headers, code } of await refusedCallers(request, `TabSum${stamp}`)) {
      const res = await request.get(`${API}/analytics/top-orders`, { headers });
      expect(res.status(), who).toBe(403);
      expect((await res.json()).error?.code, who).toBe(code);
    }
  });

  test('TC-TABSUM-05: on a phone in Arabic the strip scrolls in its own row, the page does not', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, 'ar');
    // On a phone the sidebar is off screen; Sales is on the phone bar, as a person taps it.
    await page.getByTestId('phone-bar').getByRole('link', { name: messages('ar').nav.sales, exact: true }).click();
    await expect(page).toHaveURL(/\/ar\/sales$/, { timeout: 15000 });
    const strip = page.getByRole('main').getByTestId('sales-summary');
    await expect(page.getByRole('main').getByTestId('sales-summary-skeleton')).toHaveCount(0, { timeout: 15000 });
    // Only meaningful with sales; TC-TABSUM-03 makes some in a full run.
    if ((await strip.count()) === 0) return;
    await expect(strip).toContainText(messages('ar').tabSummary.mostRevenue);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // RTL: the first card starts at the right edge.
    const first = await strip.getByTestId('summary-card').first().boundingBox();
    const box = await strip.boundingBox();
    expect(first && box && first.x + first.width).toBeGreaterThan((box?.x ?? 0) + (box?.width ?? 0) - 24);
  });
});
