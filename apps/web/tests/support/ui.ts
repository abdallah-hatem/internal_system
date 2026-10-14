/**
 * Reaching a screen the way a person does (CLAUDE.md rule 2): the login page,
 * then the navigation — never `page.goto` to the screen itself, which is a
 * full load that wipes the very cache a bug may live in.
 *
 * The same two steps as specs 79 and 95, shared by the I2 specs.
 */
import { readFileSync } from 'fs';
import { expect, type Page } from '@playwright/test';
import { EMAIL, PASSWORD } from './fixtures';
import { WEB as BASE } from './env';
import en from '../../src/i18n/locales/en.json';
import ar from '../../src/i18n/locales/ar.json';

export { BASE };
export type Locale = 'en' | 'ar';
export const messages = (locale: Locale) => (locale === 'en' ? en : ar);

export async function login(page: Page, locale: Locale = 'en') {
  await page.goto(`${BASE}/${locale}/login`);
  await page.getByPlaceholder('name@company.com').fill(EMAIL);
  await page.getByPlaceholder('StrongPassword@123').fill(PASSWORD);
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

/** A calendar day `n` days from today, local, YYYY-MM-DD. */
export function day(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

/** Open a picker, step to the month, click the day — as a person picks one (as spec 95). */
export async function pickDate(page: Page, name: string, iso: string) {
  await page.locator(`[data-date-picker="${name}"]`).filter({ visible: true }).first().click();
  const grid = page.getByRole('grid');
  await grid.waitFor({ state: 'visible' });
  for (let i = 0; i < 36; i++) {
    const shown = await grid.locator('[data-day]:not([data-outside])').first().getAttribute('data-day');
    const shownMonth = (shown ?? '').slice(0, 7);
    if (shownMonth === iso.slice(0, 7)) break;
    await page.getByTestId(shownMonth < iso.slice(0, 7) ? 'calendar-next' : 'calendar-prev').click();
  }
  await grid.locator(`[data-day="${iso}"]:not([data-outside])`).click();
  await expect(page.locator(`input[type="hidden"][name="${name}"]`)).toHaveValue(iso);
}

/** Click Export and read the file that arrives: [header, ...rows] as cells. */
export async function exportCsv(page: Page, testId: string): Promise<string[][]> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId(testId).click()]);
  const path = await download.path();
  const text = readFileSync(path!, 'utf8').replace(/^﻿/, '');
  return text.split('\r\n').filter(Boolean).map(csvCells);
}

/** One CSV line as its cells, honouring the quoting `lib/export-csv.ts` writes. */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}
