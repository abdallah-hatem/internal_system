/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The menu, and the endpoints behind it (U4c, tabs 2026-10-18)
 * ═══════════════════════════════════════════════════════════════════════
 *  The sidebar went from 21 entries to 13 by folding pages into tabs
 *  (lib/page-views.ts): Cycles | Purchases | Shipments, Suppliers | Providers,
 *  Products | Categories, Partners | Settlements, Settings | Exchange rates |
 *  Audit log. Only the three partners use the office app (owner 2026-10-18),
 *  so the per-role menu tests for an investor and for admin support were
 *  removed with them; what stays is the API refusing those roles where it
 *  still does (rule 12) — the guard is the rule, not the menu.
 *
 *  Pages are reached by clicking the sidebar and the tabs, as a person does,
 *  and every API response on the way is watched for a 403.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { API, apiCtx, EMAIL, PASSWORD } from './support/fixtures';
import { WEB as BASE } from './support/env';
import { PAGE_VIEWS } from '../src/lib/page-views';
import en from '../src/i18n/locales/en.json';

const DESKTOP = { width: 1280, height: 900 };

// The partners' sidebar: 13 entries, and Requests where it is switched on
// (the local stack shows it; production hides it for now, lib/features.ts).
const PARTNER_HREFS = [
  '/dashboard', '/analytics',
  '/cycles', '/suppliers',
  '/products', '/inventory',
  '/requests', '/sales', '/customers',
  '/payments', '/lenders', '/ledger',
  '/partners',
  '/settings',
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
  await page.getByPlaceholder('name@company.com').fill(email);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** Every API 403 seen from now on. */
function watchRefusals(page: Page) {
  const seen: string[] = [];
  page.on('response', (res) => {
    if (res.status() === 403) seen.push(res.url());
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

test.describe('The menu', () => {
  test('TC-MENU-03: the books an investor would have read refuse him with a code', async ({ request }) => {
    const email = await accountWithRole(request, 'TEMP_INVESTOR');
    const signedIn = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
    const headers = { Authorization: `Bearer ${(await signedIn.json()).data.accessToken}` };
    for (const path of [
      '/analytics/revenue-by-month', '/order-requests/pending', '/sales/orders', '/customers',
      '/payments', '/lenders', '/ledger', '/users/participation', '/audit-logs',
    ]) {
      const res = await request.get(`${API}${path}`, { headers });
      expect(res.status(), path).toBe(403);
      expect((await res.json()).error.code, path).toBe('ROLE_NOT_ALLOWED');
    }
    const imports = await request.get(`${API}/import-requests`, { headers });
    expect(imports.status(), '/import-requests').toBe(403);
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

  test('TC-MENU-07: a core partner sees the 13 entries (14 with Requests on) and nothing that became a tab', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await login(page, EMAIL);
    const hrefs = await sidebarHrefs(page);
    expect(hrefs.sort()).toEqual([...PARTNER_HREFS].sort());
    for (const gone of ['/purchases', '/shipments', '/providers', '/categories', '/settlements', '/fx-rates', '/audit-logs', '/notifications', '/payment-plans']) {
      expect(hrefs, gone).not.toContain(gone);
    }
  });

  test('TC-MENU-08: every entry and every tab opens by clicking, with no 403', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(DESKTOP);
    await login(page, EMAIL);
    const refusals = watchRefusals(page);
    const nav = en.nav as unknown as Record<string, string>;
    for (const href of PARTNER_HREFS) {
      await page.locator(`aside a[href="/en${href}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/en${href}$`));
      const views = (PAGE_VIEWS as Record<string, readonly { slug: string; navKey: string }[]>)[href.slice(1)];
      for (const v of views?.slice(1) ?? []) {
        await page.getByRole('main').getByRole('tab', { name: nav[v.navKey], exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/en${href}\\?view=${v.slug}$`));
        await expect(page.getByRole('main').getByRole('tab', { name: nav[v.navKey], exact: true })).toHaveAttribute('aria-selected', 'true');
      }
      await page.waitForLoadState('networkidle');
    }
    expect(refusals).toEqual([]);
  });
});
