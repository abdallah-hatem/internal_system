/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The catalogue pages offer a partner every write (R1c)
 *  Only the three partners use the office app (owner 2026-10-18): the
 *  investor's own screens were dropped from this suite; a partner on rows an
 *  investor is on still sees every action. The API refuses an investor in 87.
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
import { apiCtx, EMAIL, PASSWORD, today, aCorePartnerUser, investorSession } from './support/fixtures';
import en from '../src/i18n/locales/en.json';
import { WEB as BASE } from './support/env';
import { openView } from './support/ui';
import { pageOfView } from '../src/lib/page-views';

/**
 * A fresh investor's id, to put on the cycle. An investor cannot sign in at the
 * office since 2026-10-19, so fixtures `investorSession` makes one.
 */
async function investorId(request: APIRequestContext) {
  return (await investorSession(request, 'r1c')).user.id;
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

/** From the menu to a list, by clicking, and wait for the row to show. */
async function openList(page: Page, href: string, row: string) {
  // Categories, providers, purchases and shipments are tabs since 2026-10-18.
  if (pageOfView(href.slice(1))) {
    await openView(page, href.slice(1));
  } else {
    await page.locator(`aside a[href="/en${href}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/en${href}$`));
  }
  const main = page.getByRole('main');
  await main.getByRole('textbox').first().fill(row);
  await expect(main.getByText(row).first()).toBeVisible();
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

test.describe('R1c — the catalogue offers a partner every write, on rows an investor is on', () => {

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

  test('TC-CAT-04: a core partner, on the same order, still has "Record refund"', async ({ page, request }) => {
    const d = await theInvestorsCatalogue(request);
    await login(page, EMAIL);
    await openList(page, '/purchases', d.po.reference);
    await page.locator('tr', { hasText: d.po.reference }).getByRole('button', { name: en.common.view }).click();
    await expect(page.getByTestId('record-refund-action')).toBeVisible();
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
