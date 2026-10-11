/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The menu by role (U4c)
 * ═══════════════════════════════════════════════════════════════════════
 *  The menu used to show all 22 entries (23 since the Lenders page, §18) to every role, so a temporary
 *  investor was offered Sales, Payments, the ledger and the audit log, and
 *  each one opened onto a 403. Now an entry is shown exactly when the API
 *  endpoint its page lists from lets the role in (nav-model.ts mirrors the
 *  controllers' @Roles; unit/nav-roles.test.mjs checks the mirror).
 *
 *  Pages are reached by clicking the sidebar, as a person does, and every
 *  API response on the way is watched for a 403.
 *
 *  Not yet run at the time of writing (U4c was told not to run Playwright).
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { API, apiCtx, EMAIL, PASSWORD } from './support/fixtures';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** The dashboard's recent-activity panel still reads /audit-logs until U4
 *  switches it to /analytics/recent-activity — and both refuse an investor by
 *  design (U4b, U4c). U4 hides the panel for that role; until then its 403 is
 *  the one expected refusal. Nothing else may 403. */
const EXPECTED_REFUSALS = [/\/audit-logs\?limit=5/, /\/analytics\/recent-activity/];

// R1 (owner, 2026-10-10): an investor sees only their own cycles — no
// analytics, customers or payment plans; their cycles' settlements, scoped.
const INVESTOR_HREFS = [
  '/dashboard',
  '/cycles', '/purchases', '/suppliers', '/shipments', '/providers',
  '/products', '/categories', '/inventory',
  '/settlements',
  '/notifications', '/settings',
];
const PARTNER_ONLY_HREFS = [
  '/analytics', '/order-requests', '/import-requests', '/sales', '/customers',
  '/payments', '/payment-plans', '/lenders', '/ledger', '/partners', '/audit-logs',
];

/** A fresh account with the given role, created by a partner. */
async function accountWithRole(request: APIRequestContext, role: string) {
  const { headers } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(performance.now() % 1000)}`;
  const email = `menu-${role.toLowerCase()}-${stamp}@motoparts.com`;
  const made = await request.post(`${API}/auth/register`, {
    headers,
    data: { email, password: PASSWORD, displayName: `Menu ${stamp}`, role },
  });
  expect(made.ok(), `create ${role}: ${await made.text()}`).toBeTruthy();
  return email;
}

async function login(page: Page, email: string) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** Every API 403 seen from now on, other than the expected ones. */
function watchRefusals(page: Page) {
  const seen: string[] = [];
  page.on('response', (res) => {
    if (res.status() !== 403) return;
    if (EXPECTED_REFUSALS.some((r) => r.test(res.url()))) return;
    seen.push(res.url());
  });
  return seen;
}

const sidebarHrefs = async (page: Page) => [
  ...new Set(
    (await page.locator('aside a[href]').evaluateAll((as) =>
      as.map((a) => new URL((a as HTMLAnchorElement).href).pathname.replace(/^\/en/, '')),
    )).filter((h) => h !== '' && h !== '/'),
  ),
];

test.describe('The menu by role', () => {
  test('TC-MENU-01: a temporary investor is offered exactly the pages their role may read', async ({ page, request }) => {
    const email = await accountWithRole(request, 'TEMP_INVESTOR');
    await page.setViewportSize(DESKTOP);
    await login(page, email);
    expect((await sidebarHrefs(page)).sort()).toEqual([...INVESTOR_HREFS].sort());
  });

  test('TC-MENU-02: every entry an investor is offered opens with no 403', async ({ page, request }) => {
    const email = await accountWithRole(request, 'TEMP_INVESTOR');
    await page.setViewportSize(DESKTOP);
    await login(page, email);
    const refusals = watchRefusals(page);
    for (const href of INVESTOR_HREFS) {
      await page.locator(`aside a[href="/en${href}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/en${href}$`));
      await page.waitForLoadState('networkidle');
    }
    expect(refusals).toEqual([]);
  });

  test('TC-MENU-03: every entry hidden from an investor is one whose endpoint refuses them', async ({ request }) => {
    const email = await accountWithRole(request, 'TEMP_INVESTOR');
    const signedIn = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
    const headers = { Authorization: `Bearer ${(await signedIn.json()).data.accessToken}` };
    const endpoints: Record<string, string> = {
      '/analytics': '/analytics/revenue-by-month',
      '/order-requests': '/order-requests/pending',
      '/import-requests': '/import-requests',
      '/sales': '/sales/orders',
      '/customers': '/customers',
      '/payments': '/payments',
      '/payment-plans': '/payment-plans',
      '/lenders': '/lenders',
      '/ledger': '/ledger',
      '/partners': '/users/participation',
      '/audit-logs': '/audit-logs',
    };
    for (const href of PARTNER_ONLY_HREFS) {
      const res = await request.get(`${API}${endpoints[href]}`, { headers });
      expect(res.status(), href).toBe(403);
      expect((await res.json()).error.code, href).toBe('ROLE_NOT_ALLOWED');
    }
  });

  test('TC-MENU-04: the audit log refuses an investor with a code, and lets a partner and support in', async ({ request }) => {
    const investor = await accountWithRole(request, 'TEMP_INVESTOR');
    const support = await accountWithRole(request, 'ADMIN_SUPPORT');
    const tokenFor = async (email: string) => {
      const r = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
      return { Authorization: `Bearer ${(await r.json()).data.accessToken}` };
    };
    const refused = await request.get(`${API}/audit-logs`, { headers: await tokenFor(investor) });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error.code).toBe('ROLE_NOT_ALLOWED');

    for (const email of [EMAIL, support]) {
      const ok = await request.get(`${API}/audit-logs?limit=5`, { headers: await tokenFor(email) });
      expect(ok.status(), email).toBe(200);
    }
  });

  test('TC-MENU-05: admin support sees the full menu and every entry opens with no 403', async ({ page, request }) => {
    const email = await accountWithRole(request, 'ADMIN_SUPPORT');
    await page.setViewportSize(DESKTOP);
    await login(page, email);
    const hrefs = await sidebarHrefs(page);
    expect(hrefs.sort()).toEqual([...INVESTOR_HREFS, ...PARTNER_ONLY_HREFS].sort());
    const refusals = watchRefusals(page);
    for (const href of PARTNER_ONLY_HREFS) {
      await page.locator(`aside a[href="/en${href}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/en${href}$`));
      await page.waitForLoadState('networkidle');
    }
    expect(refusals).toEqual([]);
  });

  test('TC-MENU-06: on a phone, an investor\'s bar drops Sales and More follows the same filter', async ({ page, request }) => {
    const email = await accountWithRole(request, 'TEMP_INVESTOR');
    await page.setViewportSize(PHONE);
    await login(page, email);
    const bar = page.getByTestId('phone-bar');
    await expect(bar.getByRole('link')).toHaveText(['Dashboard', 'Inventory', 'Cycles']);
    await bar.getByRole('button', { name: 'More' }).click();
    const aside = page.locator('aside');
    await expect(aside.getByRole('link', { name: 'Settlements' })).toBeInViewport();
    for (const name of ['Sales', 'Customers', 'Payments', 'Payment Plans', 'Lenders', 'Ledger', 'Audit Logs']) {
      await expect(aside.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
  });

  test('TC-MENU-07: a core partner still sees all 23 entries', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await login(page, EMAIL);
    expect((await sidebarHrefs(page)).length).toBe(23);
  });
});
