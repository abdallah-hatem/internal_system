/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The notification bell
 * ═══════════════════════════════════════════════════════════════════════
 *  Notifications were being written all along — low stock, a shipment
 *  arriving, a cycle changing state — but the bell showed a hardcoded 3 and
 *  did nothing when clicked, so none of them reached anyone.
 */
import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:3000';
const API = 'http://localhost:3001/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

async function auth(request: any) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

const bell = (page: Page) => page.getByRole('button', { name: /notification/i });

/**
 * Raise a real notification.
 *
 * The seed writes cycles straight through Prisma, so it never goes past the
 * service that raises them and a freshly seeded database has none at all —
 * which quietly sent these tests down their empty branches.
 */
async function raiseNotification(request: any, h: any) {
  const res = await request.post(`${API}/cycles`, {
    headers: h,
    data: { originType: 'CHINA', currency: 'USD' },
  });
  expect(res.ok(), 'creating a cycle should raise a notification').toBeTruthy();
}
const badge = (page: Page) => page.getByTestId('notification-badge');

test.describe('Notification bell', () => {
  test('TC-NOT-01: no badge when nothing is unread', async ({ page, request }) => {
    const h = await auth(request);
    await request.post(`${API}/notifications/read-all`, { headers: h });

    await login(page);
    // A badge that is always there stops carrying information; it used to read
    // a hardcoded 3 whatever the truth was.
    await expect(badge(page)).toHaveCount(0);
  });

  test('TC-NOT-01b: the badge counts what is actually unread', async ({ page, request }) => {
    const h = await auth(request);
    await request.post(`${API}/notifications/read-all`, { headers: h });
    await raiseNotification(request, h);

    const all = (await (await request.get(`${API}/notifications`, { headers: h })).json()).data ?? [];
    const unread = all.filter((n: any) => !n.readAt).length;
    expect(unread, 'a new cycle should have raised at least one').toBeGreaterThan(0);

    await login(page);
    await expect(badge(page)).toHaveText(unread > 9 ? '9+' : String(unread));
  });

  test('TC-NOT-02: clicking the bell opens the recent notifications', async ({ page }) => {
    await login(page);
    await bell(page).click();

    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('link', { name: /view all/i })).toBeVisible();
  });

  test('TC-NOT-03: marking all read clears the badge', async ({ page, request }) => {
    const h = await auth(request);
    await raiseNotification(request, h);

    await login(page);
    await expect(badge(page)).toBeVisible();
    await bell(page).click();
    await page.getByRole('button', { name: /mark all/i }).click();

    await expect(badge(page)).toHaveCount(0, { timeout: 10000 });
  });

  test('TC-NOT-04: the panel links through to the full list', async ({ page }) => {
    await login(page);
    await bell(page).click();
    await page.getByRole('link', { name: /view all/i }).click();

    await expect(page).toHaveURL(/\/notifications/, { timeout: 10000 });
  });

  test('TC-NOT-05: the header shows who is actually signed in', async ({ page }) => {
    await login(page);
    // Was a hardcoded "Admin / Core Partner", so every partner saw the same
    // name — on a system where every action is attributed to a person.
    await expect(page.getByText(EMAIL).first()).toBeVisible();
  });
});
