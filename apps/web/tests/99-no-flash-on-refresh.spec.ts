/**
 * A refresh draws the signed-in screen from the first paint (owner,
 * 2026-10-15): the header's account card and the buttons a role may use do not
 * vanish and come back.
 *
 * The token lives in the browser's storage, which the server cannot read, so
 * the server used to draw every page signed out; the flash was the moment
 * between that paint and the scripts reading storage. Now a cookie carries who
 * is signed in (lib/session-cookie.ts) and the server draws their screen.
 * These tests stop the scripts after the refresh — which freezes the page at
 * the server's paint — and look at what a person would see there.
 */
import { test, expect, Page } from '@playwright/test';
import { WEB as BASE } from './support/env';

const PASSWORD = 'password123';
const PARTNER = 'abdallah@motoparts.com';
/** The second partner: "someone else" now that only the partners sign in (2026-10-19). */
const OTHER_PARTNER = 'shady@motoparts.com';
const COOKIE = 'sf_session_user';

async function login(page: Page, email: string) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('name@company.com').fill(email);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** Reload with every script refused: the page exactly as the server drew it. */
async function reloadFrozen(page: Page) {
  await page.route(/\/_next\/static\/.*\.js(\?|$)/, (route) => route.abort());
  await page.reload();
}

const sessionCookie = async (page: Page) =>
  (await page.context().cookies()).find((c) => c.name === COOKIE);

test.describe('No flash on refresh', () => {
  for (const width of [1440, 390]) {
    test(`TC-FLASH-01 (${width}): the server's paint of Products already has New Product`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await login(page, PARTNER);
      await page.goto(`${BASE}/en/products`);
      await expect(page.getByTestId('create-action')).toBeVisible();

      await reloadFrozen(page);
      await expect(page.getByTestId('create-action')).toBeVisible();
    });
  }

  test('TC-FLASH-02: the server\'s paint has the account card with the partner\'s own name, in the same place', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, PARTNER);
    const trigger = page.getByTestId('account-menu-trigger');
    const name = (await trigger.innerText()).trim();
    const real = await trigger.boundingBox();

    await reloadFrozen(page);
    await expect(page.getByTestId('account-menu-skeleton')).toHaveCount(0);
    await expect(trigger).toBeVisible();
    expect((await trigger.innerText()).trim()).toBe(name);
    const frozen = await trigger.boundingBox();
    expect(Math.abs(frozen!.x - real!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(frozen!.height - real!.height)).toBeLessThanOrEqual(1);
  });

  test('TC-FLASH-03: the server\'s paint has the same sidebar menu as after the scripts run', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, PARTNER);
    const before = await page.getByRole('navigation').first().getByRole('link').allTextContents();
    expect(before.length).toBeGreaterThan(5);

    await reloadFrozen(page);
    expect(await page.getByRole('navigation').first().getByRole('link').allTextContents()).toEqual(before);
  });

  // TC-FLASH-04 (an investor's paint is the investor's screen) removed (owner 2026-10-19):
  // only the partners use the office; investors are refused at the door.

  test('TC-FLASH-05: the cookie follows the session — set at sign-in, gone at sign-out, back after a sign-in as someone else', async ({ page }) => {
    await login(page, PARTNER);
    const first = await sessionCookie(page);
    expect(first, 'no session cookie after sign-in').toBeTruthy();
    expect(decodeURIComponent(first!.value)).toContain('"role":"CORE_PARTNER"');
    expect(first!.value).not.toMatch(/token|eyJ/); // never the token

    await page.getByTestId('account-menu-trigger').click();
    await page.getByTestId('account-menu').getByRole('button').last().click();
    await expect(page).toHaveURL(/login/);
    expect(await sessionCookie(page)).toBeUndefined();

    await login(page, OTHER_PARTNER);
    const second = decodeURIComponent((await sessionCookie(page))!.value);
    expect(second).toContain(`"email":"${OTHER_PARTNER}"`);
    expect(second).not.toContain(PARTNER);
  });

  test('TC-FLASH-06: a session from before the cookie existed draws a placeholder card for that first paint, then writes the cookie', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, PARTNER);
    const real = await page.getByTestId('account-menu-trigger').boundingBox();
    await page.context().clearCookies({ name: COOKIE });

    await reloadFrozen(page);
    const placeholder = page.getByTestId('account-menu-skeleton');
    await expect(placeholder).toBeAttached();
    const box = await placeholder.boundingBox();
    expect(Math.abs(box!.height - real!.height)).toBeLessThanOrEqual(1);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.reload();
    await expect(page.getByTestId('account-menu-trigger')).toBeVisible();
    await expect.poll(async () => !!(await sessionCookie(page))).toBe(true);
  });

  // TC-FLASH-07 (a cookie edited to say partner changes nothing the investor can do) removed
  // (owner 2026-10-19): only the partners use the office; investors are refused at the door.
});
