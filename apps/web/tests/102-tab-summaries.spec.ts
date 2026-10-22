/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Tab summaries
 * ═══════════════════════════════════════════════════════════════════════
 *  A few cards at the top of Cycles, Products, Inventory, Sales, Customers and
 *  Payments (owner 2026-10-18; reshaped 2026-10-22: products and units in
 *  stock on Products and Inventory, customers and who paid the most, the
 *  largest payment, "products" on the largest order, an icon on every card),
 *  and the ledger's By column.
 *
 *  Every figure on a card must be the API's analytics figure — never a second
 *  sum in the browser (rule 11) — so each test reads the endpoint and checks
 *  the screen says the same. The sales cards are driven: an order is made to
 *  be the biggest, a draft bigger still must not take its place.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, apiCtx, owedOrder, refusedCallers, stockedProduct } from './support/fixtures';
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

  for (const view of ['products', 'inventory'] as const) {
    test(`TC-TABSUM-02 (${view}): products and units in stock — the dashboard’s own figures, each card with its icon`, async ({ page, request }) => {
      const { headers } = await apiCtx(request);
      const dash = await read(request, headers, 'analytics/dashboard');
      const stock = await read(request, headers, 'analytics/stock-summary');
      expect(stock.totalProducts).toBe(dash.totalProducts);
      expect(stock.unitsInStock).toBe(dash.unitsInStock);

      await login(page);
      if (view === 'products') await openView(page, 'products');
      else await openNav(page, en.nav.inventory);
      const shown = cards(page, `${view}-summary`);
      await expect(shown).toHaveCount(2, { timeout: 15000 });
      await expect(shown.nth(0)).toContainText(en.tabSummary.products);
      await expect(shown.nth(0)).toContainText(new Intl.NumberFormat('en-US').format(stock.totalProducts));
      await expect(shown.nth(1)).toContainText(en.tabSummary.unitsInStock);
      await expect(shown.nth(1)).toContainText(new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(stock.unitsInStock));
      await expect(page.getByRole('main').getByTestId(`${view}-summary`).getByTestId('summary-card-icon')).toHaveCount(2);
      // The best sellers are gone from Products (owner 2026-10-22).
      await expect(page.getByRole('main').getByText(/best seller/i)).toHaveCount(0);
    });
  }

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
    // Kinds of product, not lines (owner 2026-10-22: "products instead").
    await expect(shown.nth(1)).toContainText(/\d+ products?/);
    await expect(shown.nth(1)).not.toContainText(/\blines?\b/);

    // A card opens its order, as a row does.
    await shown.nth(0).click();
    await expect(page.getByRole('dialog')).toContainText(big.orderNo, { timeout: 15000 });
  });

  test('TC-TABSUM-04: every summary is refused to anyone but the partners and support', async ({ request }) => {
    const callers = await refusedCallers(request, `TabSum${stamp}`);
    for (const path of ['top-orders', 'stock-summary', 'customer-summary', 'payment-summary']) {
      for (const { who, headers, code } of callers) {
        const res = await request.get(`${API}/analytics/${path}`, { headers });
        expect(res.status(), `${path} ${who}`).toBe(403);
        expect((await res.json()).error?.code, `${path} ${who}`).toBe(code);
      }
    }
  });

  test('TC-TABSUM-06: Customers — how many, and who paid the most, as the API says; the card opens that customer', async ({ page, request }) => {
    const { headers } = await apiCtx(request);
    const summary = await read(request, headers, 'analytics/customer-summary');
    expect(summary.totalCustomers).toBe((await read(request, headers, 'analytics/dashboard')).totalCustomers);

    await login(page);
    await openNav(page, en.nav.customers);
    const shown = cards(page, 'customers-summary');
    await expect(shown).toHaveCount(summary.topPayer ? 2 : 1, { timeout: 15000 });
    await expect(shown.nth(0)).toContainText(String(summary.totalCustomers));
    if (!summary.topPayer) return;
    await expect(shown.nth(1)).toContainText(en.tabSummary.topPayer);
    await expect(shown.nth(1)).toContainText(summary.topPayer.displayName);
    await shown.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${summary.topPayer.customerId}$`), { timeout: 15000 });
  });

  test('TC-TABSUM-07: Payments — the largest payment standing and who paid it; a larger reversed one never takes the card', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const before = await read(request, headers, 'analytics/payment-summary');
    const top = Number(before.largest?.amount ?? 0);
    // A shop that owes, as a payment needs (§7): one sale worth more than both.
    const shop = await mk('customers', { displayName: `Big payer ${stamp}`, type: 'B2B' });
    const { product } = await stockedProduct(request, headers, mk, `Big payer ${stamp}`, 2);
    const order = await owedOrder(mk, shop.id, product.id, top + 5000);
    const bigger = await mk('payments', { customerId: shop.id, amount: top + 2000, currency: 'EGP', method: 'CASH', orderId: order.id });
    await mk(`payments/${bigger.id}/reverse`, { reason: 'Entered twice' });
    await mk('payments', { customerId: shop.id, amount: top + 1000, currency: 'EGP', method: 'CASH', orderId: order.id });

    const after = await read(request, headers, 'analytics/payment-summary');
    expect(after.largest.amount).toBe(top + 1000);
    expect(after.largest.customer.displayName).toBe(`Big payer ${stamp}`);

    await login(page);
    await openNav(page, en.nav.payments);
    const shown = cards(page, 'payments-summary');
    await expect(shown).toHaveCount(1, { timeout: 15000 });
    await expect(shown.first()).toContainText(`Big payer ${stamp}`);
    await expect(shown.first()).toContainText(new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(top + 1000));
  });

  test('TC-TABSUM-08: the ledger names who recorded each row', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const reason = `By column check ${stamp}`;
    await mk('ledger', { kind: 'EXPENSE', category: 'packaging', amount: 123, currency: 'EGP', note: reason });
    const rows = (await read(request, headers, 'ledger?limit=50')) as { reason?: string; actor?: { email: string; partner?: { displayName: string } | null } | null }[];
    const row = rows.find((r) => r.reason?.includes(reason));
    expect(row?.actor, 'the API says who').toBeTruthy();
    const name = row!.actor!.partner?.displayName ?? row!.actor!.email;

    await login(page);
    await openNav(page, en.nav.ledger);
    const table = page.getByRole('main').locator('table');
    await expect(table.getByRole('columnheader', { name: en.ledger.by, exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByRole('main').getByPlaceholder(en.ledger.search).fill(reason);
    await expect(table.locator('tbody tr')).toHaveCount(1, { timeout: 15000 });
    await expect(table.locator('tbody tr').first()).toContainText(name);
    // The table still fits a 1440px page with the column added.
    await page.setViewportSize({ width: 1440, height: 900 });
    const fits = await table.evaluate((t) => t.parentElement!.scrollWidth <= t.parentElement!.clientWidth + 1);
    expect(fits).toBe(true);
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
