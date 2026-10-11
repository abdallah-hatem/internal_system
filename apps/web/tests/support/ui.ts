/**
 * Reaching a screen the way a person does (CLAUDE.md rule 2): the login page,
 * then the navigation — never `page.goto` to the screen itself, which is a
 * full load that wipes the very cache a bug may live in.
 *
 * The same two steps as specs 79 and 95, shared by the I2 specs.
 */
import { expect, type Page } from '@playwright/test';
import { EMAIL, PASSWORD } from './fixtures';
import en from '../../src/i18n/locales/en.json';
import ar from '../../src/i18n/locales/ar.json';

export const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
export type Locale = 'en' | 'ar';
export const messages = (locale: Locale) => (locale === 'en' ? en : ar);

export async function login(page: Page, locale: Locale = 'en') {
  await page.goto(`${BASE}/${locale}/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: messages(locale).auth.login, exact: true }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** Through the navigation — the sidebar, or behind the menu on a phone. */
export async function openNav(page: Page, name: string) {
  const link = () => page.getByRole('link', { name, exact: true }).filter({ visible: true }).first();
  if ((await link().count()) === 0) {
    await page.locator('button:has(svg.lucide-menu)').filter({ visible: true }).first().click();
  }
  const href = await link().getAttribute('href');
  await link().click();
  // Wait for the route itself: a click only starts a client navigation, and
  // the dashboard's recent activity names the very shop a test just made
  // (LEARNINGS, 2026-10-11).
  if (href) await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), { timeout: 15000 });
}

/** A shop's own page, from the Customers list, by its name. */
export async function openCustomer(page: Page, name: string, locale: Locale = 'en') {
  const m = messages(locale);
  await openNav(page, m.nav.customers);
  const main = page.getByRole('main');
  await main.getByPlaceholder(m.customers.search).fill(name);
  await main.getByRole('link', { name, exact: true }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await expect(main.getByRole('heading', { name, level: 1 })).toBeVisible();
}
