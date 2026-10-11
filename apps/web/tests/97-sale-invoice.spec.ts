/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: a confirmed sale's invoice / delivery note (I2, item 2)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §4 (2026-10-11): a confirmed sale prints as an invoice in
 *  the reader's language — the shop, the order number and date, every line,
 *  the order total, what was paid on it and what it still owes, and the shop's
 *  balance before and after this sale. A draft is not a sale and a cancelled
 *  order never happened: neither has one.
 *
 *  Reached by clicking (CLAUDE.md §2): the menu, the order, its Invoice
 *  button. Print is checked with the print media emulated — what the paper
 *  would carry, not what the screen shows. Stock comes through a cycle (§4).
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { API, apiCtx, owedOrder, refusedCallers, stockedProduct } from './support/fixtures';
import { login, messages, openNav, type Locale } from './support/ui';

const stamp = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;

/** A shop that already owes 1,000, then buys 2 × 1,500 less 200 and 1 × 500 (3,300), and pays 1,000 of it. */
async function invoiced(request: APIRequestContext, label: string) {
  const { headers, mk } = await apiCtx(request);
  const tag = `${label} ${stamp()}`;
  const { product: brake } = await stockedProduct(request, headers, mk, `${tag} Brake`, 20);
  const { product: chain } = await stockedProduct(request, headers, mk, `${tag} Chain`, 20);
  const shop = await mk('customers', { displayName: `${tag} Shop`, type: 'B2B', phone: '+201000000123' });
  const earlier = await owedOrder(mk, shop.id, brake.id, 1000);
  const order = await mk('sales/orders', {
    customerId: shop.id, channel: 'B2B', currency: 'EGP', confirm: true,
    items: [
      { productId: brake.id, quantity: 2, unitPrice: 1500, discount: 200 },
      { productId: chain.id, quantity: 1, unitPrice: 500, discount: 0 },
    ],
  });
  await mk('payments', { customerId: shop.id, amount: 1000, currency: 'EGP', orderId: order.id });
  return { headers, mk, shop, earlier, order, brake, chain };
}

async function openInvoice(page: Page, orderNo: string, locale: Locale = 'en') {
  const m = messages(locale);
  await openNav(page, m.nav.sales);
  await page.getByPlaceholder(m.sales.search).fill(orderNo);
  await page.getByTestId('sale-row').filter({ hasText: orderNo }).locator('td').nth(6).click();
  await expect(page.getByRole('heading', { name: orderNo })).toBeVisible();
  await page.getByTestId('order-invoice').click();
  await expect(page).toHaveURL(/\/sales\/[0-9a-f-]{36}\/invoice$/, { timeout: 15000 });
  await expect(page.getByTestId('invoice')).toBeVisible();
}

test.describe('Sale invoice / delivery note (§4, 2026-10-11)', () => {
  test('TC-IV-01: from the order, the invoice shows the lines, the total, paid, still owed, and the shop balance before and after', async ({ page, request }) => {
    const { shop, order } = await invoiced(request, 'IV01');
    await login(page);
    await openInvoice(page, order.orderNo);

    const inv = page.getByTestId('invoice');
    await expect(inv.getByTestId('invoice-number')).toHaveText(order.orderNo);
    await expect(inv.getByTestId('invoice-customer')).toHaveText(shop.displayName);
    await expect(inv.getByText('+201000000123')).toBeVisible();
    await expect(inv.getByTestId('invoice-line')).toHaveCount(2);
    await expect(inv.getByTestId('invoice-line').first()).toContainText('2,800.00');
    await expect(inv.getByTestId('invoice-total')).toHaveText('3,300.00 EGP');
    await expect(inv.getByTestId('invoice-paid')).toHaveText('1,000.00 EGP');
    await expect(inv.getByTestId('invoice-owes')).toHaveText('2,300.00 EGP');
    await expect(inv.getByTestId('invoice-credited')).toHaveCount(0);
    const account = inv.getByTestId('invoice-account');
    await expect(account).toContainText('1,000.00');
    await expect(inv.getByTestId('invoice-balance-after')).toHaveText('4,300.00 EGP');
  });

  test('TC-IV-02: a draft and a cancelled order offer no invoice, and the server refuses one either way', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const tag = `IV02 ${stamp()}`;
    const { product } = await stockedProduct(request, headers, mk, tag, 5);
    const shop = await mk('customers', { displayName: `${tag} Shop`, type: 'B2B' });
    const draft = await mk('sales/orders', {
      customerId: shop.id, channel: 'B2B', currency: 'EGP',
      items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
    });
    const cancelled = await owedOrder(mk, shop.id, product.id, 200);
    await mk(`sales/orders/${cancelled.id}/cancel`, {});

    for (const [o, code] of [[draft, 'INVOICE_DRAFT'], [cancelled, 'INVOICE_CANCELLED']] as const) {
      const res = await request.get(`${API}/sales/orders/${o.id}/invoice`, { headers });
      expect(res.status(), code).toBe(400);
      expect((await res.json()).error.code).toBe(code);
    }

    await login(page);
    await openNav(page, messages('en').nav.sales);
    for (const o of [draft, cancelled]) {
      await page.getByPlaceholder(messages('en').sales.search).fill(o.orderNo);
      await page.getByTestId('sale-row').filter({ hasText: o.orderNo }).locator('td').nth(6).click();
      await expect(page.getByRole('heading', { name: o.orderNo })).toBeVisible();
      await expect(page.getByTestId('order-invoice')).toHaveCount(0);
      await page.getByRole('button', { name: messages('en').common.close }).click();
    }

    // A link kept from before the order was cancelled says why, translated.
    await page.goto(`/en/sales/${cancelled.id}/invoice`);
    await expect(page.getByTestId('invoice-refused')).toContainText(`Order ${cancelled.orderNo} was cancelled`);
  });

  test('TC-IV-03: on paper — no menu, no top bar, no buttons; the whole invoice on A4', async ({ page, request }) => {
    const { order } = await invoiced(request, 'IV03');
    await login(page);
    await openInvoice(page, order.orderNo);

    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('aside')).toBeHidden();
    await expect(page.locator('header[data-print-hide]')).toBeHidden();
    await expect(page.getByTestId('invoice-print')).toBeHidden();
    await expect(page.getByTestId('back-link')).toBeHidden();
    const inv = page.getByTestId('invoice');
    await expect(inv).toBeVisible();
    // Unit price and discount are columns on paper, not tucked under the name.
    await expect(inv.locator('th', { hasText: messages('en').sales.invoice.unitPrice })).toBeVisible();
    // The page is not clipped to one screen: the frame lets the document flow.
    const main = await page.locator('main').evaluate((el) => getComputedStyle(el).overflowY);
    expect(main).toBe('visible');
  });

  test('TC-IV-04: in Arabic the invoice reads right to left, in Arabic, with the numbers whole', async ({ page, request }) => {
    const { order } = await invoiced(request, 'IV04');
    await login(page, 'ar');
    await openInvoice(page, order.orderNo, 'ar');

    const ar = messages('ar').sales.invoice;
    await expect(page.getByRole('heading', { name: ar.title })).toBeVisible();
    expect(await page.getByTestId('invoice').evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    await expect(page.getByTestId('invoice-number')).toHaveText(order.orderNo);
    await expect(page.getByTestId('invoice-total')).toHaveText('3,300.00 EGP');
    await page.emulateMedia({ media: 'print' });
    expect(await page.getByTestId('invoice').evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
  });

  test('TC-IV-05: the second time — paid in full later, the invoice says so; the balance after this sale stays what it was then', async ({ page, request }) => {
    const { mk, shop, order } = await invoiced(request, 'IV05');
    await login(page);
    await openInvoice(page, order.orderNo);
    await expect(page.getByTestId('invoice-owes')).toHaveText('2,300.00 EGP');

    await mk('payments', { customerId: shop.id, amount: 2300, currency: 'EGP', orderId: order.id });
    await page.getByTestId('back-link').click();
    await openInvoice(page, order.orderNo);
    await expect(page.getByTestId('invoice-paid')).toHaveText('3,300.00 EGP');
    await expect(page.getByTestId('invoice-owes')).toHaveText('0.00 EGP');
    await expect(page.getByTestId('invoice-balance-after')).toHaveText('4,300.00 EGP');
  });

  test('TC-IV-08: after a credit-note return the invoice shows what it took off, so total, paid, returns and still owed add up', async ({ page, request }) => {
    const { headers, mk, order } = await invoiced(request, 'IV08');
    const chainLine = (await (await request.get(`${API}/sales/orders/${order.id}`, { headers })).json()).data.items[1];
    await mk('returns', { saleOrderId: order.id, reason: 'not needed', refundMethod: 'CREDIT_NOTE', items: [{ saleItemId: chainLine.id, qty: 1 }] });

    await login(page);
    await openInvoice(page, order.orderNo);
    await expect(page.getByTestId('invoice-total')).toHaveText('3,300.00 EGP');
    await expect(page.getByTestId('invoice-paid')).toHaveText('1,000.00 EGP');
    await expect(page.getByTestId('invoice-credited')).toContainText('500.00 EGP');
    await expect(page.getByTestId('invoice-owes')).toHaveText('1,800.00 EGP');
  });

  test('TC-IV-06: a walk-in sale prints as paid on the spot, with no account', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const { product } = await stockedProduct(request, headers, mk, `IV06 ${stamp()}`, 3);
    const sale = await mk('sales/orders', {
      walkIn: true, currency: 'EGP', items: [{ productId: product.id, quantity: 1, unitPrice: 450, discount: 0 }],
    });
    const inv = (await (await request.get(`${API}/sales/orders/${sale.id}/invoice`, { headers })).json()).data;
    expect(inv).toMatchObject({ total: '450.00', paid: '450.00', owes: '0.00', account: null });
    expect(inv.customer.isWalkIn).toBe(true);
  });

  test('TC-IV-07: an invoice is the office\'s — investor and shop owner refused; a stranger id is not found', async ({ request }) => {
    const { headers, order } = await invoiced(request, 'IV07');
    for (const who of await refusedCallers(request, 'iv07')) {
      const res = await request.get(`${API}/sales/orders/${order.id}/invoice`, { headers: who.headers });
      expect(res.status(), who.who).toBe(403);
      expect((await res.json()).error.code, who.who).toBe(who.code);
    }
    expect((await request.get(`${API}/sales/orders/00000000-0000-0000-0000-000000000000/invoice`, { headers })).status()).toBe(404);
    expect((await request.get(`${API}/sales/orders/SO-1/invoice`, { headers })).status()).toBe(404);
  });
});

test.describe('The shop’s phone reads left to right in Arabic, on screen and on paper (I3 follow-up)', () => {
  /** Where the phone's first and second characters are drawn: "+" must sit left of the "2". */
  const plusIsFirst = (page: Page) =>
    page.getByTestId('invoice-phone').evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Text | null = null;
      while (walker.nextNode()) {
        const n = walker.currentNode as Text;
        if ((n.textContent ?? '').startsWith('+')) {
          node = n;
          break;
        }
      }
      if (!node) return { found: false, plusLeft: 0, nextLeft: 0 };
      const at = (i: number) => {
        const r = document.createRange();
        r.setStart(node!, i);
        r.setEnd(node!, i + 1);
        return r.getBoundingClientRect().left;
      };
      return { found: true, plusLeft: at(0), nextLeft: at(1) };
    });

  test('TC-IV-PHONE: the "+" of the phone is drawn before its digits, not after, on an Arabic invoice — screen and print', async ({ page, request }) => {
    const { order } = await invoiced(request, 'IVPH');
    await login(page, 'ar');
    await openInvoice(page, order.orderNo, 'ar');
    for (const media of ['screen', 'print'] as const) {
      await page.emulateMedia({ media });
      const r = await plusIsFirst(page);
      expect(r.found, media).toBe(true);
      expect(r.plusLeft, `${media}: "+" at ${r.plusLeft}, the next digit at ${r.nextLeft}`).toBeLessThan(r.nextLeft);
    }
  });

  test('TC-IV-SHOT: the Arabic invoice as a real A4 PDF (I3_SHOTS=1)', async ({ page, request }) => {
    test.skip(process.env.I3_SHOTS !== '1', 'screenshots only on request');
    const { order } = await invoiced(request, 'IVSHOT');
    await login(page, 'ar');
    await openInvoice(page, order.orderNo, 'ar');
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: '../../.ui-audit/i3/invoice-print-ar.pdf', preferCSSPageSize: true, printBackground: true });
  });
});
