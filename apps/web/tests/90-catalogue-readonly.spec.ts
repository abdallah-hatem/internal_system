/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The catalogue pages offer an investor nothing to write (R1c)
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC, roles (owner, 2026-10-10): a temporary investor reads, they
 *  don't act. R1b took the actions off the cycle, shipment, settlement and
 *  inventory screens; this checks the catalogue: products (and a product's
 *  prices and photos), categories, suppliers, providers, purchases (new order,
 *  record refund) and shipments (new leg, edit leg). Every one of those writes
 *  is CORE_PARTNER on the API.
 *
 *  Both directions, on the same records: a core partner still sees every
 *  action, so a guard that hid them from everyone fails here too (rule 12).
 *  Pages are reached by clicking, and every API response on the way is watched
 *  for a 403 or 5xx.
 *
 *  Not run at the time of writing (R1c was told not to run Playwright).
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { API, apiCtx, EMAIL, PASSWORD, today, aCorePartnerUser } from './support/fixtures';
import en from '../src/i18n/locales/en.json';
import { WEB as BASE } from './support/env';

const INVESTOR_EMAIL = 'investor@motoparts.com';

/** Every write a catalogue list can offer, by test id. */
const LIST_WRITES = ['create-action', 'edit-action', 'delete-action'];

async function investorId(request: APIRequestContext) {
  const r = await request.post(`${API}/auth/login`, { data: { email: INVESTOR_EMAIL, password: PASSWORD } });
  expect(r.ok(), `investor login: ${await r.text()}`).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await r.json()).data.accessToken}` };
  const me = await (await request.get(`${API}/auth/profile`, { headers })).json();
  return (me.data?.data ?? me.data ?? me).id as string;
}

/**
 * A cycle the investor is on, with one purchase order and one shipping leg, so
 * their purchases and shipments lists are not empty; and a product, category,
 * supplier and provider of its own, with a price, so every list has a row to
 * edit. Built through the API as a core partner (rule 4).
 */
async function theInvestorsCatalogue(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const investor = await investorId(request);
  const partner = await aCorePartnerUser(request, headers);
  const tag = `R1C-${Date.now()}`;
  const category = await mk('categories', { name: `${tag} Category` });
  const product = await mk('products', { name: `${tag} Part`, minStock: 0, categoryId: category.id });
  await mk(`products/${product.id}/prices`, { channel: 'B2B', currency: 'EGP', amount: 100 });
  const supplier = await mk('suppliers', { name: `${tag} Supplier`, country: 'AE' });
  const provider = await mk('providers', { name: `${tag} Freight` });

  // A new cycle starts with every active core partner on it, unless the
  // participants are named when it is created (BUSINESS_LOGIC §8, "Naming
  // participants when creating a cycle overrides the default entirely"); adding
  // the partner afterwards is refused with ALREADY_A_PARTICIPANT.
  const cycle = await mk('cycles', {
    originType: 'UAE_DIRECT', currency: 'EGP',
    participants: [
      { participantType: 'TEMP_INVESTOR', investorUserId: investor, contributionAmount: 400, investorFeePct: 10 },
      { participantType: 'CORE_PARTNER', partnerUserId: partner.id, contributionAmount: 600 },
    ],
  });
  const po = await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: today(),
    items: [{ productId: product.id, orderedQty: 10, unitPrice: 20 }],
  });
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    // A UAE_DIRECT leg must leave from the UAE (UAE_DIRECT_LEG_ROUTE).
    sequence: 1, origin: `${tag} Dubai, UAE`, destination: 'Cairo, Egypt',
    provider: provider.name, providerId: provider.id, costBasis: 'FLAT', amount: 0, currency: 'EGP', fxRateToEgp: 1,
  });
  return { tag, cycle, product, category, supplier, provider, po };
}

async function login(page: Page, email: string) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(email);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** Every API 403 and 5xx seen from now on. */
function watchRefusals(page: Page) {
  const seen: string[] = [];
  page.on('response', (res) => {
    if (!res.url().includes('/api/')) return;
    if (res.status() === 403 || res.status() >= 500) seen.push(`${res.status()} ${res.url()}`);
  });
  return seen;
}

/** From the menu to a list, by clicking, and wait for the row to show. */
async function openList(page: Page, href: string, row: string) {
  await page.locator(`aside a[href="/en${href}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/en${href}$`));
  await page.getByRole('textbox').first().fill(row);
  await expect(page.getByText(row).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

const LISTS = (d: Awaited<ReturnType<typeof theInvestorsCatalogue>>) => [
  { href: '/products', row: d.product.name, create: en.products.create },
  { href: '/categories', row: d.category.name, create: en.categories.create },
  { href: '/suppliers', row: d.supplier.name, create: en.suppliers.create },
  { href: '/providers', row: d.provider.name, create: en.providers.create },
  { href: '/purchases', row: d.po.reference, create: en.purchases.create },
  { href: '/shipments', row: `${d.tag} Dubai`, create: en.shipments.create },
];

test.describe('R1c — the catalogue is read-only for an investor', () => {
  test('TC-CAT-01: each catalogue list shows the investor its rows and no create, edit or delete — and nothing is refused on the way', async ({ page, request }) => {
    const d = await theInvestorsCatalogue(request);
    await login(page, INVESTOR_EMAIL);
    const refusals = watchRefusals(page);
    for (const list of LISTS(d)) {
      await openList(page, list.href, list.row);
      for (const id of LIST_WRITES) await expect(page.getByTestId(id), `${list.href} ${id}`).toHaveCount(0);
      await expect(page.getByRole('button', { name: list.create }), list.href).toHaveCount(0);
    }
    expect(refusals).toEqual([]);
  });

  test('TC-CAT-02: a core partner, on the same rows, is offered create and edit on every list', async ({ page, request }) => {
    const d = await theInvestorsCatalogue(request);
    await login(page, EMAIL);
    for (const list of LISTS(d)) {
      await openList(page, list.href, list.row);
      await expect(page.getByTestId('create-action'), list.href).toBeVisible();
      if (list.href !== '/purchases') {
        await expect(page.getByTestId('edit-action').first(), list.href).toBeVisible();
      }
    }
  });

  test('TC-CAT-03: the investor opens a purchase order — its refunds show, "Record refund" does not', async ({ page, request }) => {
    const d = await theInvestorsCatalogue(request);
    await login(page, INVESTOR_EMAIL);
    const refusals = watchRefusals(page);
    await openList(page, '/purchases', d.po.reference);
    await page.locator('tr', { hasText: d.po.reference }).getByRole('button', { name: en.common.view }).click();
    // The refunds section heading; UF7's empty line "No refunds from the supplier" also contains the word.
    await expect(page.getByRole('heading', { name: en.purchases.refunds })).toBeVisible();
    await expect(page.getByTestId('record-refund-action')).toHaveCount(0);
    expect(refusals).toEqual([]);
  });

  test('TC-CAT-04: a core partner, on the same order, still has "Record refund"', async ({ page, request }) => {
    const d = await theInvestorsCatalogue(request);
    await login(page, EMAIL);
    await openList(page, '/purchases', d.po.reference);
    await page.locator('tr', { hasText: d.po.reference }).getByRole('button', { name: en.common.view }).click();
    await expect(page.getByTestId('record-refund-action')).toBeVisible();
  });

  test('TC-CAT-05: the investor opens a product — the price reads, but cannot be set, and no photo can be added', async ({ page, request }) => {
    const d = await theInvestorsCatalogue(request);
    await login(page, INVESTOR_EMAIL);
    const refusals = watchRefusals(page);
    await openList(page, '/products', d.product.name);
    await page.getByRole('link', { name: d.product.name }).first().click();
    await expect(page).toHaveURL(new RegExp(`/en/products/${d.product.id}$`));
    await expect(page.getByTestId('price-readonly').first()).toContainText('100.00');
    await expect(page.getByTestId('set-price-action')).toHaveCount(0);
    await expect(page.getByTestId('add-photo-action')).toHaveCount(0);
    expect(refusals).toEqual([]);
  });

  test('TC-CAT-06: a core partner, on the same product, can set either price and add a photo', async ({ page, request }) => {
    const d = await theInvestorsCatalogue(request);
    await login(page, EMAIL);
    await openList(page, '/products', d.product.name);
    await page.getByRole('link', { name: d.product.name }).first().click();
    await expect(page.getByTestId('set-price-action')).toHaveCount(2);
    await expect(page.getByTestId('add-photo-action')).toBeVisible();
    await expect(page.getByTestId('price-readonly')).toHaveCount(0);
  });
});
