/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The deployed office app, driven in a browser
 * ═══════════════════════════════════════════════════════════════════════
 *  56-production proves the deployed pieces are connected. 60-production-audit
 *  proves the data behind them is coherent, over HTTP. Neither opens most of
 *  the app: between them they visit the dashboard and nothing else.
 *
 *  This walks every screen in a real browser and watches what a person would
 *  not see — the console, the network, and translation keys that reached the
 *  page — because the failures that only happen in production are exactly the
 *  ones that render a plausible-looking empty state instead of an error.
 *
 *  Read-only. Every navigation is a GET; nothing here creates or changes a
 *  record. Stock is checked by making the surfaces that display it agree with
 *  each other and with the API, which is where a wrong figure actually shows up.
 *
 *      npx playwright test --project=production
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';

const OFFICE = 'https://internal-system-web-three.vercel.app';
const STORE = 'https://internal-system-store.vercel.app';
const API = 'https://internal-system-api.vercel.app/api/v1';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

/** A cold serverless function boots Nest and reaches Neon before answering. */
const COLD_START = 90_000;
test.describe.configure({ mode: 'serial', timeout: 240_000 });

/** Every destination in the sidebar, which is every flow the office has. */
const SCREENS = [
  'dashboard', 'analytics', 'cycles', 'purchases', 'suppliers', 'shipments',
  'providers', 'products', 'categories', 'inventory', 'order-requests',
  'import-requests', 'sales', 'customers', 'payments', 'payment-plans',
  'ledger', 'partners', 'settlements', 'notifications', 'audit-logs', 'settings',
];

/**
 * Sign in, insisting the form kept what was typed.
 *
 * Lifted from 56-production, where it was earned: `fill` lands before React has
 * hydrated, the value is set on the DOM node and then thrown away when the
 * component mounts. On a deployed app there is no dev server to tell you the
 * page was not ready.
 */
async function signIn(page: Page) {
  await page.goto(`${OFFICE}/en/login`, { waitUntil: 'domcontentloaded' });
  const email = page.locator('input[type="email"]');
  const password = page.locator('input[type="password"]');
  await expect(email).toBeVisible({ timeout: COLD_START });

  await expect
    .poll(
      async () => {
        await email.click();
        await email.fill('');
        await email.pressSequentially(EMAIL, { delay: 10 });
        await password.fill('');
        await password.pressSequentially(PASSWORD, { delay: 10 });
        return (await email.inputValue()) === EMAIL && (await password.inputValue()) === PASSWORD;
      },
      { timeout: 60_000, message: 'the login form kept discarding what was typed' },
    )
    .toBe(true);

  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/dashboard/, { timeout: COLD_START });
}

/** Console errors and failed requests, collected for the life of the page. */
function watch(page: Page) {
  const consoleErrors: string[] = [];
  const badRequests: string[] = [];

  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // A 401 on the token refresh path is how the app discovers it is signed
    // out; it is noise, not a fault.
    if (/401|Failed to load resource/.test(text)) return;
    consoleErrors.push(text.slice(0, 200));
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const url = r.url();
    if (!url.includes('/api/')) return;
    badRequests.push(`${r.status()} ${url.replace(API, '')}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));

  return { consoleErrors, badRequests };
}

/** Translation keys that reached the screen, e.g. "errors.SOME_CODE". */
async function untranslatedKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const text = document.body.innerText;
    return [...new Set(text.match(/\b[a-z][a-zA-Z]*\.[a-zA-Z][a-zA-Z0-9_]{2,}\b/g) ?? [])].filter(
      (t) => !/\.(com|net|org|app|io|webp|png|jpg|svg|js|css|tech|vercel)$/i.test(t as string),
    ) as string[];
  });
}

async function apiHeaders(request: APIRequestContext) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
    timeout: COLD_START,
  });
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

const num = (v: unknown) => Number(v ?? 0);

test.describe('The deployed office app', () => {
  test('TC-BROW-01: every screen opens, with nothing broken underneath', async ({ page }) => {
    const { consoleErrors, badRequests } = watch(page);
    await signIn(page);

    const broken: string[] = [];

    for (const screen of SCREENS) {
      const before = { c: consoleErrors.length, b: badRequests.length };
      const nav = await page.goto(`${OFFICE}/en/${screen}`, { waitUntil: 'domcontentloaded' });

      // The status, checked first. Break-verifying this sweep with a route that
      // does not exist, it passed: Next's not-found page renders an <h1> like
      // any other and carries none of the error text below, so every check
      // after this one was happy with a 404.
      if (!nav || nav.status() >= 400) {
        broken.push(`${screen}: navigation returned ${nav?.status() ?? 'nothing'}`);
        continue;
      }

      // Wait for the page to stop fetching rather than for a fixed time: by
      // the time this suite is long, a blind wait reads the screen mid-render
      // and the emptiness it reports is its own.
      await page.waitForLoadState('networkidle', { timeout: COLD_START }).catch(() => {});

      const heading = page.locator('h1').first();
      if ((await heading.count()) === 0) {
        broken.push(`${screen}: no heading rendered at all`);
        continue;
      }

      // Inside the app, not merely served by it. The sidebar is what makes a
      // screen one of ours rather than a 200 from an error boundary.
      if ((await page.getByRole('link', { name: /dashboard/i }).count()) === 0) {
        broken.push(`${screen}: rendered outside the app shell`);
        continue;
      }

      const body = await page.evaluate(() => document.body.innerText);
      // Next's error boundary and the app's own crash text. An empty list is
      // legitimate here; an error is not.
      if (/Application error|Unhandled Runtime Error|Something went wrong|An unexpected error/i.test(body)) {
        broken.push(`${screen}: an error is on screen`);
      }

      const keys = await untranslatedKeys(page);
      if (keys.length) broken.push(`${screen}: untranslated ${keys.slice(0, 3).join(', ')}`);

      const newBad = badRequests.slice(before.b);
      if (newBad.length) broken.push(`${screen}: ${[...new Set(newBad)].join(', ')}`);

      const newErrors = consoleErrors.slice(before.c);
      if (newErrors.length) broken.push(`${screen}: console ${[...new Set(newErrors)][0]}`);
    }

    expect(broken, `\n  ${broken.join('\n  ')}\n`).toEqual([]);
  });

  test('TC-BROW-02: the inventory screen shows the stock the API holds', async ({ page, request }) => {
    const h = await apiHeaders(request);
    const stock = (await (await request.get(`${API}/inventory`, { headers: h, timeout: COLD_START })).json()).data;
    test.skip(stock.length === 0, 'production holds no stock');

    await signIn(page);
    await page.goto(`${OFFICE}/en/inventory`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: COLD_START }).catch(() => {});

    // The figure on the page, not the one in the response that produced it —
    // a total can be right in JSON and wrong by the time it is rendered.
    for (const p of stock) {
      const row = page.locator('tr', { hasText: p.productName }).first();
      await expect(row, `${p.productName} is in stock but has no row`).toBeVisible({ timeout: 30_000 });
      const shown = (await row.innerText()).replace(/,/g, '');
      expect(
        new RegExp(`\\b${num(p.totalStock)}\\b`).test(shown),
        `${p.productName}: API says ${p.totalStock}, the row reads "${shown.replace(/\n/g, ' | ')}"`,
      ).toBe(true);
    }
  });

  test('TC-BROW-03: a product page agrees with the inventory page about its stock', async ({ page, request }) => {
    const h = await apiHeaders(request);
    const stock = (await (await request.get(`${API}/inventory`, { headers: h, timeout: COLD_START })).json()).data;
    const held = stock.filter((p: any) => num(p.totalStock) > 0);
    test.skip(held.length === 0, 'no product currently holds stock');

    await signIn(page);
    for (const p of held) {
      await page.goto(`${OFFICE}/en/products/${p.productId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: COLD_START }).catch(() => {});

      const body = (await page.evaluate(() => document.body.innerText)).replace(/,/g, '');
      // Two screens reading one number. When they disagree the business has to
      // guess which is real, and both look equally authoritative.
      expect(
        new RegExp(`\\b${num(p.totalStock)}\\b`).test(body),
        `${p.productName}: inventory says ${p.totalStock}, the product page never shows it`,
      ).toBe(true);
    }
  });

  test('TC-BROW-04: the storefront offers no more than the office is holding', async ({ page, request }) => {
    const h = await apiHeaders(request);
    const stock = (await (await request.get(`${API}/inventory`, { headers: h, timeout: COLD_START })).json()).data;
    test.skip(stock.length === 0, 'production holds no stock');

    // The storefront is the surface that can promise stock to a customer, so
    // it is the one that must never claim more than is physically held.
    await page.goto(`${STORE}/ar`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: COLD_START }).catch(() => {});
    const body = await page.evaluate(() => document.body.innerText);

    for (const p of stock) {
      const available = num(p.availableStock ?? p.totalStock);
      const claimed = body.match(new RegExp(`${p.productName}[^\\d]{0,80}(\\d+)`));
      if (!claimed) continue;
      expect(
        Number(claimed[1]),
        `${p.productName}: the storefront shows ${claimed[1]}, the office holds ${available} available`,
      ).toBeLessThanOrEqual(available);
    }
  });
});
