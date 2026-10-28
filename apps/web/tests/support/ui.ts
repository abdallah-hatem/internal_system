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
import { PAGE_VIEWS, pageOfView, type ViewDef } from '../../src/lib/page-views';

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
    await page.locator('button:has(svg.icon-menu)').filter({ visible: true }).first().click();
  }
  const href = await link().getAttribute('href');
  await link().click();
  // Wait for the route itself: a click only starts a client navigation, and
  // the dashboard can name the very shop a test just made (who to collect
  // from; LEARNINGS, 2026-10-11).
  if (href) await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), { timeout: 15000 });
}

/**
 * A view that is a tab of a page (lib/page-views.ts, 2026-10-18) — Shipments
 * under Cycles, Settlements under Partners, Audit log under Settings: the
 * page's entry in the menu, then its tab, as a person clicks them.
 */
export async function openView(page: Page, slug: string, locale: Locale = 'en') {
  const host = pageOfView(slug);
  if (!host) throw new Error(`Not a page view: ${slug}`);
  const nav = messages(locale).nav as unknown as Record<string, string>;
  const first = PAGE_VIEWS[host][0];
  await openNav(page, nav[first.navKey]);
  if (first.slug === slug) return;
  await page.getByRole('main').getByRole('tab', { name: nav[(PAGE_VIEWS[host] as readonly ViewDef[]).find((v) => v.slug === slug)!.navKey], exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${host}\\?(.*&)?view=${slug}(&|$)`), { timeout: 15000 });
}

/**
 * Sales opens on Confirmed + Partially paid (owner 2026-10-28, BUSINESS_LOGIC
 * §3). A person looking for a draft, a paid, a cancelled or a samples order
 * clicks All first, which writes `?status=ALL` to the address.
 */
export async function showAllSales(page: Page, locale: Locale = 'en') {
  const all = page.getByRole('main').getByRole('button', { name: messages(locale).sales.all, exact: true });
  await all.click();
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/[?&]status=ALL(&|$)/, { timeout: 15000 });
}

/**
 * A cycle's page from the Cycles list, by its code: search it, click its row.
 * The list is paged on the server (2026-10-26) and the code sits beside its
 * status badge, so reading the first page for the bare code finds nothing.
 */
export async function openCycleByCode(page: Page, code: string, locale: Locale = 'en') {
  const m = messages(locale);
  await openNav(page, m.nav.cycles);
  const main = page.getByRole('main');
  await main.getByPlaceholder(m.cycles.search).fill(code);
  await main.getByTestId('cycle-row').filter({ hasText: code }).locator('td').first().click();
  await expect(page).toHaveURL(/\/cycles\/[0-9a-f-]{36}\/details$/, { timeout: 15000 });
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

/**
 * A choice card (components/ui/choice-cards.tsx — the cycle wizard's origin and
 * currency, owner 2026-10-24), tapped as a person taps it: by its value
 * ('UAE_DIRECT'), its label ('UAE direct') or its place (0, 1, …).
 */
export async function pickCard(page: Page, name: string, which: string | number) {
  const cards = page.getByTestId(`choice-${name}`).getByTestId('choice-card');
  // Wait for the cards before deciding how to find one: counting too early
  // found no value and fell back to the label.
  await expect(cards.first()).toBeVisible({ timeout: 15000 });
  const card =
    typeof which === 'number'
      ? cards.nth(which)
      : (await cards.filter({ has: page.locator(`[value="${which}"]`) }).count())
        ? cards.filter({ has: page.locator(`[value="${which}"]`) })
        : cards.filter({ hasText: which }).first();
  await card.click();
  await expect(card).toHaveAttribute('data-checked', 'true');
}

/** The value of the picked card in a ChoiceCards group, or '' when none is. */
export async function cardValue(page: Page, name: string) {
  const picked = page.locator(`input[type="radio"][name="${name}"]:checked`);
  return (await picked.count()) ? picked.inputValue() : '';
}
