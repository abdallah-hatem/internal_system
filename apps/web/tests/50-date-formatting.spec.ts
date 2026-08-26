/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: No raw timestamp ever reaches the screen
 * ═══════════════════════════════════════════════════════════════════════
 *  The shipments page printed `2026-08-13T00:00:00.000Z` — in the table AND in
 *  the mobile card, two renders of the same field. There is a `formatDate`
 *  helper that sixteen files use; these two rendered the field straight.
 *
 *  The sweep exists because a grep for it missed the table row. The fault is
 *  always a field somebody forgot to format, so the check has to be "does any
 *  page show a timestamp" rather than a list of the fields already thought of —
 *  a list only ever catches what is already known.
 *
 *  A second bug was suspected in the edit form — an ISO string in a date input
 *  showing blank — and there isn't one: the DatePicker slices a full timestamp
 *  itself. It looked blank because the first Edit button on the page belonged to
 *  a different shipment. The tests written for it are gone: they depended on
 *  finding one row in a list the API caps, so they passed alone and failed in a
 *  full run, and a flaky test guarding a non-bug is worse than no test. The
 *  round trip they would have covered is TC-RT-03 in 29-edit-round-trip.
 */
import { test, expect, Page } from '@playwright/test';
import { apiCtx, daysAgo, today } from './support/fixtures';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

/** `2026-08-13T00:00:00.000Z`, and the bare `2026-08-13T00:00:00` variant. */
const RAW_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** A cycle carrying a shipping leg with both dates set. */
async function cycleWithDatedLeg(request: any, label: string) {
  const { mk } = await apiCtx(request);
  const product = await mk('products', { name: `${label} Part`, minStock: 0 });
  const supplier = await mk('suppliers', { name: `${label} Supplier`, country: 'AE' });
  const provider = await mk('providers', { name: `${label} Freight` });
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

  await mk(`cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id, currency: 'EGP', fxRateToEgp: 1, orderedOn: today(),
    items: [{ productId: product.id, orderedQty: 5, unitPrice: 100 }],
  });
  await mk(`cycles/${cycle.id}/shipping-legs`, {
    sequence: 1, origin: 'Dubai, UAE', destination: 'Cairo, Egypt',
    providerId: provider.id, provider: provider.name,
    costBasis: 'FLAT', amount: 500, currency: 'EGP', fxRateToEgp: 1,
    departedOn: daysAgo(12), arrivedOn: daysAgo(3),
  });
  return cycle;
}

test.describe('Dates on screen', () => {
  test('TC-DATE-01: the shipments list shows dates, not timestamps', async ({
    page,
    request,
  }) => {
    await cycleWithDatedLeg(request, `Ship${Date.now()}`);

    await login(page);
    await page.goto(`${BASE}/en/shipments`);
    await expect(page.locator('main')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1200);

    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(RAW_TIMESTAMP);
    // And it really is showing the dates, rather than passing because the page
    // renders none at all.
    expect(text).toMatch(/\b[A-Z][a-z]{2} \d{1,2}, \d{4}\b/);
  });

  test('TC-DATE-02: no page anywhere leaks a raw timestamp', async ({
    page,
    request,
  }) => {
    // A sweep, because the bug is always a field nobody remembered to format
    // and it will be a different field next time.
    await cycleWithDatedLeg(request, `Sweep${Date.now()}`);
    await login(page);

    const pages = [
      'dashboard', 'cycles', 'purchases', 'shipments', 'inventory',
      'products', 'sales', 'customers', 'payments', 'payment-plans',
      'ledger', 'partners', 'settlements', 'notifications', 'audit-logs',
      'suppliers', 'providers', 'categories',
    ];

    const leaks: string[] = [];
    for (const slug of pages) {
      await page.goto(`${BASE}/en/${slug}`);
      await page.waitForTimeout(900);
      const text = await page.locator('main').innerText().catch(() => '');
      const found = text.match(RAW_TIMESTAMP);
      if (found) leaks.push(`${slug}: ${found[0]}`);
    }

    expect(leaks).toEqual([]);
  });

});
