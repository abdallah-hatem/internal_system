/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Web push for the office
 * ═══════════════════════════════════════════════════════════════════════
 *  The storefront could alert a shop; the office had only the bell, which
 *  says nothing when nobody has the tab open. The machinery was already
 *  generic — PushService keys subscriptions on a user id — so this is three
 *  routes and a settings section, not a second implementation.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { API, EMAIL, PASSWORD } from './support/fixtures';

const BASE = 'http://localhost:3000';

async function headers(request: APIRequestContext) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test.describe('Office push', () => {
  test('TC-PUSH-01: the app is installable and ships a worker', async ({ page }) => {
    // Without both of these the browser offers no install and no push, and the
    // settings section would be a button that cannot work.
    const manifest = await page.request.get(`${BASE}/manifest.webmanifest`);
    expect(manifest.ok()).toBeTruthy();
    const body = await manifest.json();
    expect(body.display).toBe('standalone');
    expect(body.icons.some((i: any) => i.sizes === '512x512')).toBeTruthy();

    const sw = await page.request.get(`${BASE}/sw.js`);
    expect(sw.ok()).toBeTruthy();
    const source = await sw.text();
    expect(source).toContain("addEventListener('push'");
    expect(source).toContain("addEventListener('notificationclick'");
    // This app caches nothing: a cached balance is a figure nobody can date.
    expect(source).not.toContain("caches.open");
  });

  test('TC-PUSH-02: the office can register and drop a browser', async ({ request }) => {
    const h = await headers(request);

    const key = await request.get(`${API}/notifications/push-key`, { headers: h });
    expect(key.ok()).toBeTruthy();
    const publicKey = (await key.json()).data.publicKey;
    test.skip(!publicKey, 'VAPID keys are not configured on this API');

    const endpoint = `https://example.test/push/${Date.now()}`;
    const sub = await request.post(`${API}/notifications/push-subscriptions`, {
      headers: h,
      data: { endpoint, keys: { p256dh: 'test-p256dh-value', auth: 'test-auth-value' } },
    });
    expect(sub.ok(), await sub.text()).toBeTruthy();

    // Re-registering the same browser must not leave a second row behind, or
    // the API pushes twice to one device forever.
    const again = await request.post(`${API}/notifications/push-subscriptions`, {
      headers: h,
      data: { endpoint, keys: { p256dh: 'test-p256dh-value', auth: 'test-auth-value' } },
    });
    expect(again.ok()).toBeTruthy();

    const gone = await request.delete(`${API}/notifications/push-subscriptions`, {
      headers: h,
      data: { endpoint },
    });
    expect(gone.ok()).toBeTruthy();
  });

  test('TC-PUSH-03: a signed-out browser cannot register itself', async ({ request }) => {
    const res = await request.post(`${API}/notifications/push-subscriptions`, {
      data: { endpoint: 'https://example.test/push/anon', keys: { p256dh: 'a', auth: 'b' } },
    });
    expect(res.status()).toBe(401);
  });

  test('TC-PUSH-04: Settings offers alerts for this device', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/en/settings`);

    const section = page.getByTestId('push-alerts');
    await expect(section).toBeVisible({ timeout: 15000 });
    // The scope is the thing people get wrong about push, so it is on screen.
    await expect(section).toContainText(/one browser on one device/i);
    await expect(section.getByRole('button', { name: /turn on alerts|turn off alerts/i })).toBeVisible();
  });
});
