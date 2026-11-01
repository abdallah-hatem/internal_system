/**
 * Visual regression for the storefront: the screens a shop owner opens first,
 * on the phone the `storefront` project emulates. The office half, and why
 * this is opt-in (`VISUAL=1`) and how it stays deterministic, is in
 * visual.spec.ts; this file only runs in the `storefront` project because its
 * name ends in `storefront.spec.ts`.
 *
 * Read-only: nothing here signs in or writes, so the seeded catalogue is all
 * it shows.
 */
import { test, expect, type Page } from '@playwright/test';
import { STORE } from './support/env';

const FROZEN_NOW = new Date('2026-11-01T08:00:00Z');

test.use({ timezoneId: 'Africa/Cairo' });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.addInitScript(() => {
    const style = () => {
      const s = document.createElement('style');
      s.textContent = [
        'nextjs-portal { display: none !important }',
        '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important }',
      ].join('\n');
      document.head.appendChild(s);
    };
    if (document.head) style();
    else document.addEventListener('DOMContentLoaded', style);
  });
});

async function snap(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-slot="skeleton"], [class*="animate-pulse"]')).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  // Images arrive after networkidle on a slow first compile; wait for each to decode.
  await page.evaluate(() => Promise.all([...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null)))));
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true, threshold: 0.01 }); // near-exact: see visual.spec.ts snap()
}

test('storefront catalogue · ar', async ({ page }) => {
  await page.goto(`${STORE}/ar`);
  await snap(page, 'store-home-ar');
});

test('storefront catalogue · en', async ({ page }) => {
  await page.goto(`${STORE}/en`);
  await snap(page, 'store-home-en');
});

test('storefront product · ar', async ({ page }) => {
  await page.goto(`${STORE}/ar`);
  await page.waitForLoadState('networkidle');
  await page.locator('a[href*="/p/"]').first().click();
  await expect(page).toHaveURL(/\/p\//);
  await snap(page, 'store-product-ar');
});

test('storefront sign-in · ar', async ({ page }) => {
  await page.goto(`${STORE}/ar/login`);
  await snap(page, 'store-login-ar');
});
