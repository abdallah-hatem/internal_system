import { test, expect } from '@playwright/test';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';

/**
 * Every clickable thing shows a hand.
 *
 * The owner has raised this twice, and both times it was fixed on the screen he
 * was looking at rather than as a rule. It is a rule, so it gets a test that
 * sweeps rather than an assertion on one button.
 *
 * There was no cursor test in this app at all, and two separate defects were
 * sitting behind that. Tailwind v4's preflight drops the browser default, so
 * `globals.css` restores it — but the selector list named `button, a,
 * [role="button"]` and the Select is built from Radix and cmdk, which render a
 * `div` with `role="option"`. Every row of every dropdown in the app was
 * missed. And `command.tsx` shipped shadcn's `cursor-default`, a utility class,
 * which beats a base rule even once the selector is right. Either one alone was
 * enough to produce an arrow.
 */

async function login(page: any) {
  await page.goto(`${BASE}/en/login`);
  await page.fill('input[type="email"]', 'partner.a@motoparts.com');
  await page.fill('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/dashboard/, { timeout: 10_000 });
}

/** Cursors of everything visible, enabled and clickable on the current screen. */
async function arrowCursors(page: any) {
  return page.evaluate(() => {
    const bad: string[] = [];
    const nodes = document.querySelectorAll(
      'button, a, [role="button"], [role="option"], [role="menuitem"]',
    );
    nodes.forEach((el) => {
      const node = el as HTMLElement;
      if (node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true') return;
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      const cursor = getComputedStyle(node).cursor;
      if (cursor !== 'pointer') {
        bad.push(`${node.tagName.toLowerCase()}[${node.getAttribute('role') ?? '-'}] "${(node.textContent ?? '').trim().slice(0, 30)}" → ${cursor}`);
      }
    });
    return bad;
  });
}

test.describe('Cursors', () => {
  test('TC-CURSOR-01: every clickable element on the main screens shows a hand', async ({ page }) => {
    await login(page);

    const screens = ['dashboard', 'products', 'customers', 'sales', 'cycles', 'inventory'];
    const problems: string[] = [];

    for (const slug of screens) {
      await page.goto(`${BASE}/en/${slug}`);
      await page
        .locator('main .animate-spin')
        .waitFor({ state: 'detached', timeout: 15_000 })
        .catch(() => {});

      // Assert the screen actually rendered before asserting nothing is wrong
      // with it — an empty page has no bad cursors and would pass silently.
      const count = await page.locator('button, a').count();
      expect(count, `${slug} rendered nothing to check`).toBeGreaterThan(3);

      for (const bad of await arrowCursors(page)) problems.push(`${slug}: ${bad}`);
    }

    expect(problems).toEqual([]);
  });

  test('TC-CURSOR-02: the rows of an open dropdown show a hand, not an arrow', async ({ page }) => {
    // The specific case both fixes were about. A Select renders its options as
    // divs with `role="option"`, so it is missed by any selector written around
    // `button` — and it is the control the owner is most often clicking.
    await login(page);
    await page.goto(`${BASE}/en/products`);
    await page
      .locator('main .animate-spin')
      .waitFor({ state: 'detached', timeout: 15_000 })
      .catch(() => {});

    // The category filter on the page itself, not the one inside the create
    // form. The first attempt opened the modal and then clicked
    // `[role=combobox]`.first(), which resolved to the filter *behind* it — a
    // real element, visible and enabled, and covered by the modal's backdrop.
    // Playwright said so plainly ("subtree intercepts pointer events"); the
    // lesson is that `.first()` is a guess about ordering, and a modal makes
    // that guess wrong without making it look wrong.
    const trigger = page.locator('#category-filter');
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();

    const options = page.locator('[role="option"]');
    await expect(options.first()).toBeVisible({ timeout: 10_000 });

    // Positive assertion first: there are rows to be wrong about.
    const n = await options.count();
    expect(n, 'the dropdown opened with no options to check').toBeGreaterThan(0);

    expect(await arrowCursors(page)).toEqual([]);
  });
});
