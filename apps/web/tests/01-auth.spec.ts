/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Authentication
 * ═══════════════════════════════════════════════════════════════════════
 *  Login, session persistence, and the route guard that keeps an
 *  unauthenticated visitor out of the internal application.
 */
import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:3000';
const API = 'http://localhost:3001/api/v1';

const VALID_EMAIL = 'partner.a@motoparts.com';
const VALID_PASSWORD = 'password123';

const emailBox = (page: Page) => page.getByPlaceholder('partner.a@motoparts.com');
const passwordBox = (page: Page) => page.getByPlaceholder('••••••••');
const loginButton = (page: Page) => page.getByRole('button', { name: /login/i });

async function submitLogin(page: Page, email: string, password: string) {
  await emailBox(page).fill(email);
  await passwordBox(page).fill(password);
  await loginButton(page).click();
}

/** The token the app stores on a successful sign-in. */
const storedToken = (page: Page) =>
  page.evaluate(() => window.localStorage.getItem('token'));

test.describe('Authentication', () => {
  test('TC-AUTH-01: the login form renders', async ({ page }) => {
    await page.goto(`${BASE}/en/login`);
    await expect(emailBox(page)).toBeVisible();
    await expect(passwordBox(page)).toBeVisible();
    await expect(loginButton(page)).toBeVisible();
    await expect(passwordBox(page)).toHaveAttribute('type', 'password');
  });

  test('TC-AUTH-02: valid credentials reach the dashboard and store a token', async ({ page }) => {
    await page.goto(`${BASE}/en/login`);
    await submitLogin(page, VALID_EMAIL, VALID_PASSWORD);

    await expect(page).toHaveURL(/\/en\/dashboard/, { timeout: 10000 });
    expect(await storedToken(page)).toBeTruthy();
  });

  test('TC-AUTH-03: wrong credentials stay on login and store nothing', async ({ page }) => {
    await page.goto(`${BASE}/en/login`);
    await submitLogin(page, VALID_EMAIL, 'definitely-not-the-password');

    // The important assertions are the ones a bug would break: we must not be
    // let through, and no session may be written. Matching the wording of the
    // message would just make the test brittle.
    await expect(page).toHaveURL(/\/login/);
    await expect(page).not.toHaveURL(/dashboard/);
    expect(await storedToken(page)).toBeNull();
  });

  test('TC-AUTH-04: an unknown account is refused', async ({ page }) => {
    await page.goto(`${BASE}/en/login`);
    await submitLogin(page, 'nobody@motoparts.com', VALID_PASSWORD);

    await expect(page).toHaveURL(/\/login/);
    expect(await storedToken(page)).toBeNull();
  });

  test('TC-AUTH-05: the session survives a reload', async ({ page }) => {
    await page.goto(`${BASE}/en/login`);
    await submitLogin(page, VALID_EMAIL, VALID_PASSWORD);
    await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });

    await page.reload();
    await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
    await expect(page).not.toHaveURL(/login/);
    expect(await storedToken(page)).toBeTruthy();
  });

  test('TC-AUTH-06: an unauthenticated visitor is sent to login, not the dashboard', async ({ page }) => {
    // This is the assertion that matters: the previous version accepted
    // /login OR /dashboard, so it passed even when the guard let someone
    // straight through and could never have caught a regression.
    await page.goto(`${BASE}/en/login`);
    await page.evaluate(() => window.localStorage.clear());

    await page.goto(`${BASE}/en/dashboard`);
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
    await expect(emailBox(page)).toBeVisible();
  });

  test('TC-AUTH-07: dropping the token ends the session on the next navigation', async ({ page }) => {
    await page.goto(`${BASE}/en/login`);
    await submitLogin(page, VALID_EMAIL, VALID_PASSWORD);
    await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });

    await page.evaluate(() => {
      window.localStorage.removeItem('token');
      window.localStorage.removeItem('user');
    });
    await page.goto(`${BASE}/en/inventory`);

    await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
  });

  test('TC-AUTH-08: the guard keeps the chosen locale', async ({ page }) => {
    await page.goto(`${BASE}/ar/login`);
    await page.evaluate(() => window.localStorage.clear());

    await page.goto(`${BASE}/ar/settlements`);
    // Being bounced to the English login would silently switch language.
    // The guard and the locale middleware can each move the URL, so wait for
    // it to settle rather than sampling it mid-flight.
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 10000 })
      .toBe('/ar/login');
  });

  test('TC-AUTH-09: every internal page is guarded, not just the dashboard', async ({ page }) => {
    await page.goto(`${BASE}/en/login`);
    await page.evaluate(() => window.localStorage.clear());

    for (const path of ['inventory', 'sales', 'settlements', 'ledger', 'audit-logs']) {
      await page.goto(`${BASE}/en/${path}`);
      await expect(page, `/${path} should be guarded`).toHaveURL(/\/login/, { timeout: 10000 });
    }
  });
});

test.describe('Authentication API', () => {
  test('TC-AUTH-10: valid credentials return a token', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, {
      data: { email: VALID_EMAIL, password: VALID_PASSWORD },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).data.accessToken).toBeTruthy();
  });

  test('TC-AUTH-11: a wrong password is rejected without leaking which field failed', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, {
      data: { email: VALID_EMAIL, password: 'wrong-but-long-enough' },
    });
    expect(res.status()).toBe(401);

    const body = JSON.stringify(await res.json()).toLowerCase();
    expect(body).not.toContain('accesstoken');
    // Saying "no such user" versus "wrong password" tells an attacker which
    // addresses are real.
    expect(body).not.toMatch(/password is (incorrect|wrong)|user not found/);
  });

  test('TC-AUTH-12: an unknown account is refused the same way', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, {
      data: { email: 'nobody@motoparts.com', password: VALID_PASSWORD },
    });
    expect(res.status()).toBe(401);
  });

  test('TC-AUTH-13: protected endpoints refuse a missing or tampered token', async ({ request }) => {
    const auth = await request.post(`${API}/auth/login`, {
      data: { email: VALID_EMAIL, password: VALID_PASSWORD },
    });
    const token = (await auth.json()).data.accessToken;

    const none = await request.get(`${API}/cycles`);
    expect(none.status()).toBe(401);

    // Flip the last character of the signature: a token that looks right but
    // was not signed by this server must not be accepted.
    const tampered = token.slice(0, -1) + (token.at(-1) === 'A' ? 'B' : 'A');
    const forged = await request.get(`${API}/cycles`, {
      headers: { Authorization: `Bearer ${tampered}` },
    });
    expect(forged.status()).toBe(401);

    const good = await request.get(`${API}/cycles`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(good.status()).toBe(200);
  });

  test('TC-AUTH-14: the password is never echoed back', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, {
      data: { email: VALID_EMAIL, password: VALID_PASSWORD },
    });
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(VALID_PASSWORD);
    expect(body.toLowerCase()).not.toContain('passwordhash');
  });
});
