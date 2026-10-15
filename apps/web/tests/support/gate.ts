/**
 * Holding the API so a loading screen can be looked at while it is certainly
 * loading, and reaching screens through the menu at any width — shared by the
 * skeleton specs (99-skeletons, 99-table-columns).
 */
import { expect, type Page } from '@playwright/test';
import { messages, openNav, type Locale } from './ui';

/** Holds every GET to the API until released; logins and saves pass. */
export async function gateApi(page: Page) {
  let open: () => void = () => {};
  let gate = Promise.resolve();
  let holding = false;
  await page.route(/\/api\/v1\//, async (route) => {
    const req = route.request();
    if (holding && req.method() === 'GET' && !/\/auth\//.test(req.url())) await gate;
    await route.continue().catch(() => {});
  });
  return {
    hold() {
      holding = true;
      gate = new Promise<void>((resolve) => (open = resolve));
    },
    release() {
      holding = false;
      open();
    },
  };
}
export type Gate = Awaited<ReturnType<typeof gateApi>>;

/**
 * Through the menu, as a person does: the sidebar on a desktop; on a phone
 * the bottom bar, or More and the drawer for a screen the bar does not hold
 * (spec 74).
 */
export async function go(page: Page, label: string, locale: Locale = 'en') {
  if ((page.viewportSize()?.width ?? 1440) >= 768) return openNav(page, label);
  const bar = page.getByTestId('phone-bar');
  let link = bar.getByRole('link', { name: label, exact: true });
  if ((await link.count()) === 0) {
    await bar.getByRole('button', { name: messages(locale).nav.more }).click();
    link = page.locator('aside').getByRole('link', { name: label, exact: true });
  }
  const href = await link.getAttribute('href');
  await link.click();
  if (href) await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), { timeout: 15000 });
}
