/**
 * Holding the API so a loading screen can be looked at while it is certainly
 * loading, and reaching screens through the menu at any width — shared by the
 * skeleton specs (99-skeletons, 99-table-columns).
 */
import { expect, type Page } from '@playwright/test';
import { messages, openNav, type Locale } from './ui';

/**
 * Holds every GET to the API until released; logins and saves pass.
 *
 * `rewrite` changes a response's body on its way to the page — for a screen
 * whose height depends on a figure the test cannot otherwise choose (the
 * dashboard's profit pill, 99-skeletons TC-SKEL-21). It is given the URL and
 * the parsed body, and returns the body to send, or undefined to send it as is.
 */
export async function gateApi(page: Page, opts: { rewrite?: (url: string, body: unknown) => unknown } = {}) {
  let open: () => void = () => {};
  let gate = Promise.resolve();
  let holding = false;
  await page.route(/\/api\/v1\//, async (route) => {
    const req = route.request();
    if (holding && req.method() === 'GET' && !/\/auth\//.test(req.url())) await gate;
    if (opts.rewrite && req.method() === 'GET') {
      try {
        const response = await route.fetch();
        const body: unknown = await response.json().catch(() => undefined);
        const changed = body === undefined ? undefined : opts.rewrite(req.url(), body);
        if (changed !== undefined) await route.fulfill({ response, json: changed });
        else await route.fulfill({ response });
      } catch {
        // The page closed while the request was out.
      }
      return;
    }
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
