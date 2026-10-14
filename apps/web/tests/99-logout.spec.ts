/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Signing out (owner, 2026-10-14)
 * ═══════════════════════════════════════════════════════════════════════
 *  There was no way to log out: logout() existed and nothing on any screen
 *  called it. When it was called it sent everybody to /en/login and left
 *  the query cache behind.
 *
 *  Everything is reached by clicking, as a person does — the header's
 *  account menu on a wide screen, "More" on a phone.
 */
import { test, expect, Page } from '@playwright/test';
import { PASSWORD } from './support/fixtures';
import { WEB as BASE } from './support/env';

const PARTNER_A = 'partner.a@motoparts.com';
const PARTNER_B = 'partner.b@motoparts.com';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/**
 * `next dev` mounts `<nextjs-portal>` over the bottom-left corner — under
 * Arabic, exactly where "More" sits on the phone bar. Hidden rather than
 * clicked through with `force`, which would also hide a real element in the way
 * (54-storefront does the same).
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const hide = () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal { display: none !important }';
      document.head.appendChild(style);
    };
    if (document.head) hide();
    else document.addEventListener('DOMContentLoaded', hide);
  });
});

/**
 * After sign-out the login page is a fresh load, and a `fill` that lands
 * before React hydrates is thrown away (56-production). Type, and check it
 * stuck, before submitting.
 */
async function signIn(page: Page, email: string, locale: 'en' | 'ar' = 'en') {
  const emailBox = page.getByPlaceholder('partner.a@motoparts.com');
  const passwordBox = page.getByPlaceholder('••••••••');
  await expect
    .poll(
      async () => {
        await emailBox.fill(email);
        await passwordBox.fill(PASSWORD);
        await page.waitForTimeout(100);
        return (await emailBox.inputValue()) === email && (await passwordBox.inputValue()) === PASSWORD;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/dashboard`), { timeout: 15000 });
}

async function openLogin(page: Page, locale: 'en' | 'ar' = 'en') {
  await page.goto(`${BASE}/${locale}/login`);
}

const trigger = (page: Page) => page.getByTestId('account-menu-trigger');
const menu = (page: Page) => page.getByTestId('account-menu');
const token = (page: Page) => page.evaluate(() => window.localStorage.getItem('token'));

async function logOutFromHeader(page: Page, label = 'Log out') {
  await trigger(page).click();
  await expect(menu(page)).toBeVisible();
  await menu(page).getByRole('button', { name: label }).click();
}

test.describe('Signing out', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP);
  });

  test('TC-OUT-01: the header menu shows who is signed in, and Log out lands on the login page', async ({ page }) => {
    await openLogin(page);
    await signIn(page, PARTNER_A);

    await expect(trigger(page)).toHaveAttribute('type', 'button');
    await expect(trigger(page)).toHaveCSS('cursor', 'pointer');
    await trigger(page).click();
    await expect(menu(page)).toContainText('Partner A');
    await expect(menu(page)).toContainText(PARTNER_A);
    await expect(menu(page)).toContainText(/core partner/i);

    await menu(page).getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/en\/login$/);
    await expect(page.getByPlaceholder('••••••••')).toBeVisible();
    expect(await token(page)).toBeNull();
    expect(await page.evaluate(() => window.localStorage.getItem('user'))).toBeNull();
  });

  test('TC-OUT-02: an Arabic reader lands on the Arabic login page', async ({ page }) => {
    await openLogin(page, 'ar');
    await signIn(page, PARTNER_A, 'ar');

    await logOutFromHeader(page, 'تسجيل الخروج');
    await expect(page).toHaveURL(/\/ar\/login$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    expect(await token(page)).toBeNull();
  });

  test('TC-OUT-03: Enter opens the menu and Escape closes it without signing out', async ({ page }) => {
    await openLogin(page);
    await signIn(page, PARTNER_A);

    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    expect(await token(page)).toBeTruthy();
    await expect(page).toHaveURL(/\/en\/dashboard/);
  });

  test('TC-OUT-04: Back after signing out shows no protected screen', async ({ page }) => {
    await openLogin(page);
    await signIn(page, PARTNER_A);
    // Somewhere with data, reached by clicking.
    await page.getByRole('link', { name: 'Customers', exact: true }).first().click();
    await expect(page).toHaveURL(/\/en\/customers$/);

    await logOutFromHeader(page);
    await expect(page).toHaveURL(/\/en\/login$/);

    await page.goBack();
    // Wherever Back lands, it ends at the login page with nothing of the
    // office drawn: no header, no menu, no list.
    await expect(page).toHaveURL(/\/en\/login$/, { timeout: 10000 });
    await expect(page.locator('[data-app-frame]')).toHaveCount(0);
    await expect(trigger(page)).toHaveCount(0);
    expect(await token(page)).toBeNull();

    await page.goBack();
    await expect(page).toHaveURL(/\/en\/login$/, { timeout: 10000 });
    await expect(page.locator('[data-app-frame]')).toHaveCount(0);
  });

  test('TC-OUT-05: the next partner to sign in sees no figure before their own data arrives', async ({ page }) => {
    await openLogin(page);
    await signIn(page, PARTNER_A);
    await expect(page.getByTestId('tile-totalRevenue').or(page.locator('[data-testid^="tile-"]').first())).toBeVisible();
    await logOutFromHeader(page);
    await expect(page).toHaveURL(/\/en\/login$/);

    // Hold Partner B's dashboard figures at the network.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const seenTokens: string[] = [];
    await page.route('**/analytics/dashboard*', async (route) => {
      seenTokens.push(route.request().headers()['authorization'] ?? '');
      await held;
      await route.continue();
    });

    await signIn(page, PARTNER_B);
    await expect(trigger(page)).toContainText('Partner B');
    // While B's request is held, nothing may be drawn from what A loaded.
    await expect(page.locator('[data-testid^="tile-"]')).toHaveCount(0);
    expect(seenTokens.length).toBeGreaterThan(0);

    const bToken = await token(page);
    expect(seenTokens.every((h) => h === `Bearer ${bToken}`)).toBe(true);

    release();
    await expect(page.locator('[data-testid^="tile-"]').first()).toBeVisible();
  });

  test('TC-OUT-06: signing out and back in as the same partner works the second time', async ({ page }) => {
    await openLogin(page);
    await signIn(page, PARTNER_A);
    await logOutFromHeader(page);
    await expect(page).toHaveURL(/\/en\/login$/);
    await signIn(page, PARTNER_A);
    await logOutFromHeader(page);
    await expect(page).toHaveURL(/\/en\/login$/);
    expect(await token(page)).toBeNull();
  });

  test('TC-OUT-07: on a phone (390), Log out is in the More menu', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openLogin(page);
    await signIn(page, PARTNER_A);

    await page.getByTestId('phone-bar').getByRole('button', { name: 'More' }).click();
    const out = page.getByTestId('drawer-logout');
    await expect(out).toBeVisible();
    await expect(out).toHaveAttribute('type', 'button');
    await expect(out).toHaveCSS('cursor', 'pointer');
    await out.click();

    await expect(page).toHaveURL(/\/en\/login$/);
    expect(await token(page)).toBeNull();
  });

  test('TC-OUT-08: on a phone in Arabic, More → Log out lands on the Arabic login page', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openLogin(page, 'ar');
    await signIn(page, PARTNER_A, 'ar');

    await page.getByTestId('phone-bar').getByRole('button', { name: 'المزيد' }).click();
    await page.getByTestId('drawer-logout').click();
    await expect(page).toHaveURL(/\/ar\/login$/);
  });

  test('TC-OUT-09: the drawer’s Log out stays out of the wide-screen sidebar', async ({ page }) => {
    await openLogin(page);
    await signIn(page, PARTNER_A);
    await expect(page.getByTestId('drawer-logout')).toBeHidden();
  });
});
