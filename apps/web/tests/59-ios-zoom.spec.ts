/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: iOS Safari must not zoom when a field takes focus
 * ═══════════════════════════════════════════════════════════════════════
 *  Safari zooms the page in whenever the focused control's font-size is under
 *  16px, and it does not zoom back out. Whoever is using the app is left
 *  scrolled sideways with the chrome off screen and no way back but a pinch —
 *  it reads as the app being broken. Nearly every field in both apps is
 *  `text-sm`, which is 14px, so it fired on every form.
 *
 *  The fix is one unlayered CSS rule per app. It is tested by measuring, not
 *  by grepping the stylesheet: a rule inside `@layer base` is silently beaten
 *  by the `text-sm` utility, which is exactly the mistake that was made first,
 *  and the file would look correct either way.
 */
import { test, expect, devices } from '@playwright/test';

const WEB = 'http://localhost:3000';
const STORE = process.env.STOREFRONT_BASE ?? 'http://localhost:3002';

/** Every font-size, in px, of the controls a person can focus on this page. */
function sizes() {
  return [...document.querySelectorAll<HTMLInputElement>('input, select, textarea')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.type !== 'hidden';
    })
    .map((el) => ({
      tag: el.tagName.toLowerCase() + (el.type ? `[${el.type}]` : ''),
      px: parseFloat(getComputedStyle(el).fontSize),
    }));
}

test.describe('No zoom on focus', () => {
  test('TC-ZOOM-01: office fields are at least 16px on a touch device', async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    await page.goto(`${WEB}/en/login`);
    await page.locator('input').first().waitFor();

    // The media query is `pointer: coarse`; if the emulation does not report
    // that, the test proves nothing and should say so rather than pass.
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    const found = await page.evaluate(sizes);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(f.px, `${f.tag} is ${f.px}px — Safari will zoom`).toBeGreaterThanOrEqual(16);
    await ctx.close();
  });

  test('TC-ZOOM-02: storefront fields are at least 16px on a touch device', async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    const res = await page.goto(STORE);
    test.skip(!res || !res.ok(), 'storefront is not running');
    await page.locator('input').first().waitFor({ timeout: 15000 });

    const found = await page.evaluate(sizes);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(f.px, `${f.tag} is ${f.px}px — Safari will zoom`).toBeGreaterThanOrEqual(16);
    await ctx.close();
  });

  test('TC-ZOOM-03: the desktop layout keeps its 14px fields', async ({ browser }) => {
    // The rule is scoped to coarse pointers on purpose. Bumping every field to
    // 16px on a mouse-driven layout would be a visible design change nobody
    // asked for, and zoom cannot happen there anyway.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`${WEB}/en/login`);
    await page.locator('input').first().waitFor();

    const found = await page.evaluate(sizes);
    expect(found.some((f) => f.px < 16)).toBe(true);
    await ctx.close();
  });
});
