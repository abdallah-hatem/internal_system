/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Moving between tabs does not reload the app
 * ═══════════════════════════════════════════════════════════════════════
 *  The sidebar was built from plain `<a href>`, so every tab click was a full
 *  document navigation: the bundle re-parsed, React remounted, and the React
 *  Query cache went with it. Every page refetched everything from scratch, and
 *  the sidebar — a new DOM node each time — lost its scroll position, which on
 *  a twenty-item list means scrolling back down after every move.
 *
 *  It looked like ordinary slowness rather than a bug, which is why it survived:
 *  the right page did appear, just after a white flash and a round of spinners.
 *
 *  Measured before the fix: four clicks, four document loads. After: zero.
 */
import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

/** Sidebar entries that exist in every build of this app. */
const TABS = ['Products', 'Customers', 'Sales', 'Import Cycles'];

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
  await expect(page.getByRole('link', { name: 'Products', exact: true }).first()).toBeVisible({
    timeout: 15000,
  });
}

test.describe('Sidebar navigation', () => {
  test('TC-NAV-01: clicking through tabs never reloads the document', async ({ page }) => {
    await login(page);

    // A value on `window` survives a client-side route change and nothing else.
    // Counting 'load' events alone would miss a reload that happened before the
    // listener attached, so both are checked.
    await page.evaluate(() => {
      (window as any).__navProbe = 'alive';
    });

    let documentLoads = 0;
    page.on('load', () => documentLoads++);

    for (const tab of TABS) {
      await page.getByRole('link', { name: tab, exact: true }).first().click();
      await expect(page).toHaveURL(new RegExp(`/en/`), { timeout: 10000 });
      await page.waitForTimeout(400);
    }

    expect(documentLoads).toBe(0);
    expect(await page.evaluate(() => (window as any).__navProbe)).toBe('alive');
  });

  test('TC-NAV-02: the sidebar keeps its scroll position across tabs', async ({ page }) => {
    // The visible half of the same bug. A remounted sidebar starts at the top,
    // so anything below the fold had to be scrolled back to after every move.
    await login(page);

    const nav = page.locator('nav').first();
    const scrollable = await nav.evaluate(
      (el) => el.scrollHeight > el.clientHeight + 10,
    );
    test.skip(!scrollable, 'sidebar fits without scrolling at this viewport');

    await nav.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const before = await nav.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(0);

    await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
    await page.waitForTimeout(600);

    expect(await page.locator('nav').first().evaluate((el) => el.scrollTop)).toBe(before);
  });

  test('TC-NAV-03: the shell does not refetch its own data on every tab', async ({
    page,
  }) => {
    // What the reload actually cost, measured on something only the shell owns.
    //
    // An earlier version of this test counted product requests and passed
    // either way: react-query revalidates on mount regardless, so one fetch
    // looks the same whether the app remounted or not. The notification bell
    // lives in the persistent layout — with client-side routing it never
    // remounts and never refetches; with a document load it pays again on
    // every single tab.
    await login(page);

    let notificationCalls = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/notifications')) notificationCalls++;
    });

    for (const tab of TABS) {
      await page.getByRole('link', { name: tab, exact: true }).first().click();
      await page.waitForTimeout(700);
    }

    // Polling on a timer would add the odd extra call, so this is not zero —
    // but it must be nothing like one per tab.
    expect(notificationCalls).toBeLessThan(TABS.length);
  });

  test('TC-NAV-04: every sidebar entry is a real link', async ({ page }) => {
    // Keyboard and middle-click both depend on a genuine href. A div with an
    // onClick would pass the reload check above while breaking open-in-new-tab.
    await login(page);

    for (const tab of TABS) {
      const link = page.getByRole('link', { name: tab, exact: true }).first();
      const href = await link.getAttribute('href');
      expect(href, `${tab} has no href`).toBeTruthy();
      // The locale belongs in the path exactly once — the i18n Link adds it, so
      // an href that carries it too lands on /en/en/....
      expect(href).toMatch(/^\/en\/[a-z-]+/);
      expect(href).not.toMatch(/^\/en\/en\//);
    }
  });
});
