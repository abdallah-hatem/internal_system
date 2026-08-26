/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The cycle wizard is translated
 * ═══════════════════════════════════════════════════════════════════════
 *  The wizard had no useTranslations at all — every label, placeholder and
 *  toast was a hardcoded English string, while a `wizard` namespace sat in both
 *  locale files fully written and unused.
 *
 *  The failure this guards against is quiet. next-intl renders a missing key as
 *  the key itself, so an Arabic screen degrades to "wizard.qty" rather than
 *  breaking — nobody reading English notices, and the suite stays green. So the
 *  checks below are about absence: no key that the component asks for missing
 *  from either locale, no English left on an Arabic screen, no raw key names.
 */
import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';
const DRAFT_KEY = 'cycle-wizard-draft';

const root = join(__dirname, '..');
const component = readFileSync(
  join(root, 'src/components/cycles/CycleWizard.tsx'),
  'utf8',
);
const en = JSON.parse(readFileSync(join(root, 'src/i18n/locales/en.json'), 'utf8'));
const ar = JSON.parse(readFileSync(join(root, 'src/i18n/locales/ar.json'), 'utf8'));

/** Every t('…') the wizard asks for. */
const usedKeys = [...component.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);

async function login(page: Page, locale: 'en' | 'ar') {
  await page.goto(`${BASE}/${locale}/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button').filter({ hasText: /.+/ }).last().click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test.describe('Cycle wizard translations', () => {
  test('TC-I18N-01: every key the wizard uses exists in both locales', async () => {
    expect(usedKeys.length).toBeGreaterThan(30);

    const missingEn = usedKeys.filter((k) => !(k in en.wizard));
    const missingAr = usedKeys.filter((k) => !(k in ar.wizard));

    expect({ missingEn, missingAr }).toEqual({ missingEn: [], missingAr: [] });
  });

  test('TC-I18N-02: the two locales carry the same keys', async () => {
    // A key added to en alone renders as "wizard.thatKey" in Arabic, which
    // reads as a broken screen rather than a missing translation.
    const onlyEn = Object.keys(en.wizard).filter((k) => !(k in ar.wizard));
    const onlyAr = Object.keys(ar.wizard).filter((k) => !(k in en.wizard));

    expect({ onlyEn, onlyAr }).toEqual({ onlyEn: [], onlyAr: [] });
  });

  test('TC-I18N-03: no Arabic value is still English', async () => {
    // Copying the English across to unblock a build is the easy mistake, and it
    // looks translated in the key listing.
    // Strip ICU control syntax so only the words a reader sees are checked.
    //
    // Doing that by listing argument names — count, leg — was wrong twice over:
    // it needed extending for every new placeholder, and until someone did,
    // `{amount}` left the bare word "amount" behind and a perfectly good Arabic
    // string was reported as untranslated. Placeholders are removed by shape
    // now, and only the plural/select KEYWORDS are named, because those are
    // fixed by the ICU spec.
    const strip = (text: string) =>
      text
        // A whole simple placeholder: {amount}, {customer}.
        .replace(/\{\s*[A-Za-z_]\w*\s*\}/g, '')
        // The header of a plural or select, leaving its translated bodies.
        .replace(/\{\s*[A-Za-z_]\w*\s*,\s*(?:plural|selectordinal|select)\s*,/g, '')
        // Branch keywords and the punctuation that frames them.
        .replace(/\b(?:zero|one|two|few|many|other|offset)\b|[{}#=,]/g, '');

    const untranslated = Object.entries(ar.wizard as Record<string, string>)
      .filter(([k, v]) => v === en.wizard[k] || /[A-Za-z]/.test(strip(v)))
      .map(([k]) => k);

    expect(untranslated).toEqual([]);
  });

  test('TC-I18N-04: the Arabic wizard shows no English and no raw keys', async ({
    page,
  }) => {
    await login(page, 'ar');
    await page.evaluate((k) => localStorage.removeItem(k), DRAFT_KEY);
    await page.goto(`${BASE}/ar/cycles/new`);
    await expect(page.locator('form')).toBeVisible({ timeout: 15000 });

    const body = (await page.locator('main, form').first().innerText()).trim();

    // The tell-tale of a key that resolved to nothing.
    expect(body).not.toContain('wizard.');

    // And the English the wizard used to be built from.
    for (const english of [
      'Cycle Information',
      'Origin Type',
      'Save & Continue',
      'Select origin type',
    ]) {
      expect(body).not.toContain(english);
    }

    expect(body).toContain(ar.wizard.cycleInformation);
  });

  test('TC-I18N-05: the step titles are translated, not just the fields', async ({
    page,
  }) => {
    // The progress bar read from a module-level constant, which no hook can
    // reach — the easiest part of the wizard to leave in English.
    await login(page, 'ar');
    await page.goto(`${BASE}/ar/cycles/new`);
    await expect(page.locator('form')).toBeVisible({ timeout: 15000 });

    const bar = await page.locator('main').first().innerText();
    for (const title of ['Cycle Info', 'Purchase Order', 'Shipping Leg', 'Receive Inventory']) {
      expect(bar).not.toContain(title);
    }
    expect(bar).toContain(ar.wizard.step1Title);
    expect(bar).toContain(ar.wizard.step4Title);
  });

  test('TC-I18N-06: a draft survives a change of language', async ({ page }) => {
    // The draft is stored under one key for the whole app, so switching locale
    // must not read past it or drop it — the work is the same work.
    await login(page, 'en');
    await page.evaluate((k) => localStorage.removeItem(k), DRAFT_KEY);
    await page.goto(`${BASE}/en/cycles/new`);
    await expect(page.locator('form')).toBeVisible({ timeout: 15000 });

    const originPicker = page
      .locator('input[type="hidden"][name="originType"]')
      .locator('..')
      .getByRole('combobox');
    await originPicker.click();
    await page.getByRole('listbox').getByRole('option').first().click();
    await page.waitForFunction((k) => !!localStorage.getItem(k), DRAFT_KEY);

    const before = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k)!).state.draft.originType,
      DRAFT_KEY,
    );
    expect(before).toBeTruthy();

    await page.goto(`${BASE}/ar/cycles/new`);
    await expect(page.locator('form')).toBeVisible({ timeout: 15000 });

    await expect(page.locator('input[type="hidden"][name="originType"]')).toHaveValue(
      before,
    );
  });
});
