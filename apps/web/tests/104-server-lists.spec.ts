/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: search, filters, sorting and pages on the server, and the
 *  Sales list's customer filter (owner 2026-10-25)
 * ═══════════════════════════════════════════════════════════════════════
 *  "This is the purpose of pagination, how can you do it client from the
 *  first place." Fourteen office lists loaded every row and searched, filtered
 *  and paged them in the browser. Now each sends page, pageSize, search, sort
 *  and its filters to its endpoint, which filters, counts and pages in the
 *  query (apps/api/src/common/list-query.ts).
 *
 *  The fixtures make more rows than a page holds, so a list that still paged
 *  in the browser — or an endpoint that ignored `page` — gives a different
 *  answer from the one asserted. Every row is built the way the business
 *  makes it (CLAUDE.md §4): an order needs stock from a received cycle.
 *
 *  The Sales list's customer filter is reached as a person reaches it: the
 *  menu, the picker, the option; and asserted on the rows they see.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import en from '../src/i18n/locales/en.json';
import { API, apiCtx, owedOrder, stockedProduct } from './support/fixtures';
import { login, openNav } from './support/ui';
import { WEB } from './support/env';

test.describe.configure({ timeout: 300_000 });

type Body = { data?: unknown; meta?: Record<string, unknown>; error?: { code: string } };

async function get(
  request: APIRequestContext,
  headers: Record<string, string>,
  path: string,
  params: Record<string, string | number>,
) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await request.get(`${API}/${path}?${qs}`, { headers });
  return { status: res.status(), body: (await res.json()) as Body };
}

const rowsOf = (b: Body) => (b.data ?? []) as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any -- list rows differ per endpoint

/** Every list the office pages, its endpoint, and whether it offers a sort beyond its default. */
const LISTS = [
  'sales/orders',
  'customers',
  'payments',
  'ledger',
  'inventory',
  'notifications',
  'suppliers',
  'cycles',
  'categories',
  'shipping/legs',
  'providers',
  'audit-logs',
  'products',
  'purchases',
] as const;

test.describe('every list endpoint pages, counts and refuses the same way', () => {
  for (const path of LISTS) {
    test(`TC-SL-01 ${path}: a page has at most pageSize rows and says the total; bad paging is refused with a code`, async ({ request }) => {
      const { headers } = await apiCtx(request);

      const first = await get(request, headers, path, { page: 1, pageSize: 2 });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(rowsOf(first.body).length).toBeLessThanOrEqual(2);
      expect(typeof first.body.meta?.total).toBe('number');
      expect(first.body.meta?.totalPages).toBe(Math.ceil(Number(first.body.meta?.total) / 2));

      // A search runs against every column the list searches — a column named
      // wrong in the SQL is a 500 here, whatever the search finds.
      for (const search of ['zz', 'خوذه', '50']) {
        const searched = await get(request, headers, path, { page: 1, search });
        expect(searched.status, `${path} ?search=${search}: ${JSON.stringify(searched.body)}`).toBe(200);
        expect(typeof searched.body.meta?.total).toBe('number');
      }

      // Limits: a page from 1, a size from 1 to 200, a search of at most 100,
      // an order the list offers. Each a 400 with a code, never a 500.
      for (const [params, code] of [
        [{ page: 0 }, 'LIST_PAGE_INVALID'],
        [{ page: -1 }, 'LIST_PAGE_INVALID'],
        [{ page: 'two' }, 'LIST_PAGE_INVALID'],
        [{ page: 1, pageSize: 201 }, 'LIST_PAGE_SIZE_INVALID'],
        [{ page: 1, pageSize: 0 }, 'LIST_PAGE_SIZE_INVALID'],
        [{ page: 1, sort: 'password' }, 'LIST_SORT_UNKNOWN'],
        [{ page: 1, search: 'x'.repeat(101) }, 'LIST_SEARCH_TOO_LONG'],
      ] as const) {
        const refused = await get(request, headers, path, params);
        expect(refused.status, `${path} ${JSON.stringify(params)}`).toBe(400);
        expect(refused.body.error?.code, `${path} ${JSON.stringify(params)}`).toBe(code);
      }

      // Past the end: no rows, and still the total.
      const past = await get(request, headers, path, { page: 100000, pageSize: 2 });
      expect(past.status).toBe(200);
      expect(rowsOf(past.body)).toEqual([]);
      expect(past.body.meta?.total).toBe(first.body.meta?.total);
    });
  }
});

test.describe('more rows than a page: the server filters, counts and pages', () => {
  test('TC-SL-02 suppliers: 12 matches over two pages of 10, each row once; an Arabic spelling finds its twin', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const tag = `SL02${Date.now()}`;
    for (let i = 0; i < 12; i++) await mk('suppliers', { name: `${tag} Supplier ${i}`, country: 'CN' });
    await mk('suppliers', { name: `خوذة ${tag}`, country: 'AE' });

    const p1 = await get(request, headers, 'suppliers', { page: 1, pageSize: 10, search: `${tag} Supplier` });
    const p2 = await get(request, headers, 'suppliers', { page: 2, pageSize: 10, search: `${tag} Supplier` });
    expect(p1.body.meta?.total).toBe(12);
    expect(rowsOf(p1.body)).toHaveLength(10);
    expect(rowsOf(p2.body)).toHaveLength(2);
    const names = [...rowsOf(p1.body), ...rowsOf(p2.body)].map((r) => r.name);
    expect(new Set(names).size).toBe(12);

    // ة and ه are one letter to a search (§3); typed the other way, it is found.
    const ar = await get(request, headers, 'suppliers', { page: 1, search: `خوذه ${tag}` });
    expect(rowsOf(ar.body).map((r) => r.name)).toEqual([`خوذة ${tag}`]);
    // A country by part of its name, in either language.
    const china = await get(request, headers, 'suppliers', { page: 1, pageSize: 200, search: 'صين' });
    expect(rowsOf(china.body).some((r) => String(r.name).startsWith(tag))).toBe(true);
  });

  test('TC-SL-03 customers ?sort=balance: whoever owes the most first, across pages, not within one', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const tag = `SL03${Date.now()}`;
    const { product } = await stockedProduct(request, headers, mk, tag, 50);
    const owing = [100, 900, 300, 700, 500];
    for (const [i, amount] of owing.entries()) {
      const c = await mk('customers', { displayName: `${tag} Shop ${i}`, type: 'B2B' });
      await owedOrder(mk, c.id, product.id, amount);
    }
    const page1 = await get(request, headers, 'customers', { page: 1, pageSize: 2, search: tag, sort: 'balance' });
    const page2 = await get(request, headers, 'customers', { page: 2, pageSize: 2, search: tag, sort: 'balance' });
    const page3 = await get(request, headers, 'customers', { page: 3, pageSize: 2, search: tag, sort: 'balance' });
    const balances = [page1, page2, page3].flatMap((p) => rowsOf(p.body).map((r) => Number(r.outstandingBalance)));
    expect(balances).toEqual([900, 700, 500, 300, 100]);
    expect(page1.body.meta?.total).toBe(5);
  });

  test('TC-SL-04 ledger: a type name standing for several codes; a type that is not a code is refused', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const both = await get(request, headers, 'ledger', { page: 1, pageSize: 200, type: 'PURCHASE,PURCHASE_PAYMENT' });
    expect(both.status).toBe(200);
    expect(rowsOf(both.body).every((r) => ['PURCHASE', 'PURCHASE_PAYMENT'].includes(String(r.type)))).toBe(true);
    const bad = await get(request, headers, 'ledger', { page: 1, type: "PURCHASE'; --" });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe('LIST_FILTER_INVALID');
    const dir = await get(request, headers, 'ledger', { page: 1, direction: 'SIDEWAYS' });
    expect(dir.body.error?.code).toBe('LIST_FILTER_INVALID');
  });
});

// ── The Sales list's customer filter ──────────────────────────────────
/** Two shops, one with more orders than a page; a walk-in sale. */
async function salesFixture(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const tag = `SLF${Date.now()}`;
  const { product } = await stockedProduct(request, headers, mk, tag, 100);
  // Made in the office, so verified (§7).
  const shop = (name: string) => mk('customers', { displayName: name, type: 'B2B' });
  const many = await shop(`${tag} Many Orders`);
  const other = await shop(`${tag} Other Shop`);
  const manyOrders = [];
  for (let i = 0; i < 12; i++) manyOrders.push(await owedOrder(mk, many.id, product.id, 100 + i));
  const otherOrder = await owedOrder(mk, other.id, product.id, 999);
  const walkIn = await mk('sales/orders', {
    walkIn: true,
    currency: 'EGP',
    items: [{ productId: product.id, quantity: 1, unitPrice: 50, discount: 0 }],
  });
  return { headers, tag, many, other, manyOrders, otherOrder, walkIn };
}

test.describe('Sales: filter by customer (owner 2026-10-25)', () => {
  test('TC-SL-05 API: customerId pages that shop\'s orders only; walk-in is its own choice; nonsense is refused', async ({ request }) => {
    const f = await salesFixture(request);
    const { headers } = f;

    const p1 = await get(request, headers, 'sales/orders', { page: 1, pageSize: 10, customerId: f.many.id });
    const p2 = await get(request, headers, 'sales/orders', { page: 2, pageSize: 10, customerId: f.many.id });
    expect(p1.body.meta?.total).toBe(12);
    expect(rowsOf(p1.body)).toHaveLength(10);
    expect(rowsOf(p2.body)).toHaveLength(2);
    const all = [...rowsOf(p1.body), ...rowsOf(p2.body)];
    expect(all.every((o) => o.customerId === f.many.id)).toBe(true);
    expect(new Set(all.map((o) => o.orderNo))).toEqual(new Set(f.manyOrders.map((o) => o.orderNo)));

    // With a status too: both apply.
    const paid = await get(request, headers, 'sales/orders', { page: 1, customerId: f.many.id, status: 'PAID' });
    expect(paid.body.meta?.total).toBe(0);

    // The walk-in buyer: every walk-in sale, and nobody else's.
    const walk = await get(request, headers, 'sales/orders', { page: 1, pageSize: 200, customerId: 'walk-in' });
    expect(rowsOf(walk.body).length).toBeGreaterThan(0);
    expect(rowsOf(walk.body).every((o) => o.customer?.isWalkIn === true)).toBe(true);
    expect(rowsOf(walk.body).some((o) => o.id === f.walkIn.id)).toBe(true);

    // Things that do not exist: a clear 400 / 404, never a 500 (CLAUDE.md §1).
    const notId = await get(request, headers, 'sales/orders', { page: 1, customerId: 'abc' });
    expect(notId.status).toBe(400);
    expect(notId.body.error?.code).toBe('VALIDATION_FAILED');
    const nobody = await get(request, headers, 'sales/orders', { page: 1, customerId: '00000000-0000-4000-8000-000000000999' });
    expect(nobody.status).toBe(404);
    expect(nobody.body.error?.code).toBe('NOT_FOUND');
    const status = await get(request, headers, 'sales/orders', { page: 1, status: 'paid' });
    expect(status.body.error?.code).toBe('LIST_FILTER_INVALID');
  });

  test('TC-SL-06 UI: the picker sends ?customer= to the API, the rows and pages are that shop\'s, a refresh keeps it, Clear lets go', async ({ page, request }) => {
    const f = await salesFixture(request);
    await login(page);
    await openNav(page, en.nav.sales);

    const sent = page.waitForRequest(
      (r) => r.url().includes('/sales/orders?') && new URL(r.url()).searchParams.get('customerId') === f.many.id,
    );
    await pickCustomer(page, f.many.displayName);
    await expect(page).toHaveURL(new RegExp(`[?&]customer=${f.many.id}(&|$)`));
    await sent;

    const table = page.getByTestId('sales-table');
    await expect(table.getByTestId('sale-row')).toHaveCount(10);
    await expect(table.getByText(f.other.displayName)).toHaveCount(0);
    // The total is the shop's 12, not what one page holds.
    await expect(page.getByText(/Showing 1 – 10 of 12/)).toBeVisible();
    await page.getByRole('button', { name: en.pagination.next }).click();
    await expect(table.getByTestId('sale-row')).toHaveCount(2);
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);

    // The second visit: a refresh keeps the shop chosen, and the picker says so.
    await page.reload();
    await expect(page.getByTestId('sales-customer-filter')).toContainText(f.many.displayName);
    await expect(table.getByTestId('sale-row')).toHaveCount(2);

    // Walk-in is a choice of its own.
    await pickCustomer(page, en.sales.walkInCustomer);
    await expect(page).toHaveURL(/[?&]customer=walk-in(&|$)/);
    await expect(page).not.toHaveURL(/[?&]page=/);
    await expect(table.getByText(f.many.displayName)).toHaveCount(0);
    await expect(table.getByTestId('sale-row').first()).toContainText(en.sales.walkInCustomer);

    // Clear: every shop again.
    await page.getByTestId('sales-customer-filter').getByRole('button', { name: 'Clear' }).dispatchEvent('pointerdown');
    await expect(page).not.toHaveURL(/customer=/);
    await expect(page.getByTestId('sales-customer-filter')).toContainText(en.placeholders.allCustomers);
  });

  test('TC-SL-07 UI: a shop\'s New Order still opens the form on that shop, and the list underneath is that shop\'s', async ({ page, request }) => {
    const f = await salesFixture(request);
    await login(page);
    await page.goto(`${WEB}/en/customers/${f.other.id}`);
    await page.getByRole('button', { name: en.sales.create }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText(f.other.displayName);
    await expect(page).toHaveURL(new RegExp(`[?&]customer=${f.other.id}(&|$)`));
    await expect(page).not.toHaveURL(/new=1/);
  });
});

test.describe('Sales: filter by branch, for a customer with branches (§7, owner 2026-10-25)', () => {
  test("TC-SL-08 API and UI: a branch's orders, the owner's own, another customer's branch refused; a new customer drops the branch", async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const tag = `SLB${Date.now()}`;
    const { product } = await stockedProduct(request, headers, mk, tag, 100);
    const shop = await mk('customers', { displayName: `${tag} Owner`, type: 'B2B' });
    const plain = await mk('customers', { displayName: `${tag} Plain`, type: 'B2B' });
    // Two orders before the branches: on the owner.
    for (let i = 0; i < 2; i++) await owedOrder(mk, shop.id, product.id, 200 + i);
    const mokattam = await mk(`customers/${shop.id}/branches`, { name: 'Mokattam' });
    const master = await mk(`customers/${shop.id}/branches`, { name: 'Master' });
    const sell = (branchId: string, price: number) =>
      mk('sales/orders', {
        customerId: shop.id,
        branchId,
        channel: 'B2B',
        currency: 'EGP',
        confirm: true,
        items: [{ productId: product.id, quantity: 1, unitPrice: price, discount: 0 }],
      });
    for (let i = 0; i < 11; i++) await sell(master.id, 300 + i);
    await sell(mokattam.id, 400);

    // The API: Master's 11 over two pages, the owner's 2, refusals with codes.
    const m1 = await get(request, headers, 'sales/orders', { page: 1, customerId: shop.id, branchId: master.id });
    expect(m1.body.meta?.total).toBe(11);
    expect(rowsOf(m1.body).every((o) => o.branch?.id === master.id)).toBe(true);
    const none = await get(request, headers, 'sales/orders', { page: 1, customerId: shop.id, branchId: 'none' });
    expect(none.body.meta?.total).toBe(2);
    const wrong = await get(request, headers, 'sales/orders', { page: 1, customerId: plain.id, branchId: master.id });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error?.code).toBe('BRANCH_NOT_THIS_CUSTOMER');
    const alone = await get(request, headers, 'sales/orders', { page: 1, branchId: master.id });
    expect(alone.body.error?.code).toBe('LIST_FILTER_INVALID');

    // The screen: the branch picker appears for this owner only.
    await login(page);
    await openNav(page, en.nav.sales);
    await expect(page.getByTestId('sales-branch-filter')).toHaveCount(0);
    await pickCustomer(page, shop.displayName);
    await page.getByTestId('sales-branch-filter').getByRole('combobox').click();
    await page.getByRole('option', { name: 'Master' }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]branch=${master.id}(&|$)`));
    const table = page.getByTestId('sales-table');
    await expect(table.getByTestId('sale-row')).toHaveCount(10);
    await expect(page.getByText(/Showing 1 – 10 of 11/)).toBeVisible();
    await expect(table.getByTestId('sale-branch-cell').filter({ hasText: 'Mokattam' })).toHaveCount(0);

    // "On the owner": the two from before the branches.
    await page.getByTestId('sales-branch-filter').getByRole('combobox').click();
    await page.getByRole('option', { name: en.branches.noBranch }).click();
    await expect(table.getByTestId('sale-row')).toHaveCount(2);

    // Another customer: the branch goes with the old one, and no refusal shows.
    await pickCustomer(page, plain.displayName);
    await expect(page).not.toHaveURL(/[?&]branch=/);
    await expect(page.getByTestId('sales-branch-filter')).toHaveCount(0);
    await expect(page.getByTestId('sales-range-error')).toHaveCount(0);
  });
});

/** Open the Sales list's customer picker, type the name, choose it. */
async function pickCustomer(page: Page, name: string) {
  await page.getByTestId('sales-customer-filter').getByRole('combobox').click();
  const search = page.getByPlaceholder(en.placeholders.searchCustomers);
  if (await search.isVisible()) await search.fill(name);
  await page.getByRole('option', { name, exact: false }).first().click();
}
