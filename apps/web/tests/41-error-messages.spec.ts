/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: API refusals reach the reader, in their language
 * ═══════════════════════════════════════════════════════════════════════
 *  Two separate faults met here.
 *
 *  The API answers `{ error: { code, message, … } }`, but 36 call sites read
 *  `err.response.data.message` — one level too shallow. That is always
 *  undefined, so every refusal fell through to a generic "Failed to save"
 *  written at the call site, and the API's actual explanation reached nobody.
 *  Nothing looked broken: a toast still appeared, it just never said anything.
 *
 *  And those messages were English sentences thrown from services, so even once
 *  they arrived, an Arabic screen showed an Arabic form and an English
 *  explanation of what went wrong.
 *
 *  Services now name each refusal with a stable code and the client translates
 *  it. What follows checks the parts that can rot quietly: a code with no
 *  translation, a translation for a code nothing throws, and a message that
 *  arrives but says the wrong thing.
 */
import { test, expect, Page } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { apiCtx, API } from './support/fixtures';
import { resolveApiError } from '../src/lib/api-error';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

const web = join(__dirname, '..');
const api = join(web, '../api/src');
const en = JSON.parse(readFileSync(join(web, 'src/i18n/locales/en.json'), 'utf8'));
const ar = JSON.parse(readFileSync(join(web, 'src/i18n/locales/ar.json'), 'utf8'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') && !p.includes('.spec.') ? [p] : [];
  });
}

/** Every code the services actually throw. */
const thrownCodes = (() => {
  const found = new Set<string>(['NOT_FOUND']);
  for (const file of walk(api)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\b(?:badRequest|conflict|forbidden|unauthorized)\(\s*/g)) {
      const rest = src.slice(m.index! + m[0].length, m.index! + m[0].length + 160);
      const ternary = rest.match(/^[^,]*?'([A-Z_0-9]+)'\s*:\s*'([A-Z_0-9]+)'/);
      if (ternary) {
        found.add(ternary[1]);
        found.add(ternary[2]);
        continue;
      }
      const one = rest.match(/^'([A-Z_0-9]+)'/);
      if (one) found.add(one[1]);
    }
  }
  return found;
})();

async function login(page: Page, locale: 'en' | 'ar') {
  await page.goto(`${BASE}/${locale}/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button').filter({ hasText: /.+/ }).last().click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

test.describe('API error messages', () => {
  test('TC-ERR-01: every thrown code has a translation in both locales', async () => {
    expect(thrownCodes.size).toBeGreaterThan(60);

    const missingEn = [...thrownCodes].filter((c) => !(c in en.errors)).sort();
    const missingAr = [...thrownCodes].filter((c) => !(c in ar.errors)).sort();

    // An untranslated code is not visibly broken — the client falls back to the
    // server's English — so only a check like this one ever notices.
    expect({ missingEn, missingAr }).toEqual({ missingEn: [], missingAr: [] });
  });

  test('TC-ERR-02: no translation is left for a code nothing throws', async () => {
    // The other direction: a code renamed in the service leaves its old
    // translation behind, and the message it used to produce silently reverts
    // to English.
    const structural = new Set(['entity', 'generic']);
    const orphans = Object.keys(en.errors)
      .filter((k) => !structural.has(k))
      .filter((c) => !thrownCodes.has(c))
      .sort();

    expect(orphans).toEqual([]);
  });

  test('TC-ERR-03: the API sends a code and the English alongside it', async ({
    request,
  }) => {
    const { headers } = await apiCtx(request);
    const res = await request.post(`${API}/cycles`, { headers, data: {} });
    const body = (await res.json()).error;

    expect(body.code).toBe('ORIGIN_TYPE_REQUIRED');
    // The English has to survive too — it is what a client that has never
    // heard of this code falls back to.
    expect(body.message).toBeTruthy();
  });

  test('TC-ERR-04: a not-found names the entity as a key', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const res = await request.get(
      `${API}/cycles/00000000-0000-0000-0000-000000000000`,
      { headers },
    );
    const body = (await res.json()).error;

    expect(body.code).toBe('NOT_FOUND');
    expect(body.params).toEqual({ entity: 'cycle' });
  });

  test('TC-ERR-05: a refusal reaches the screen in Arabic', async ({ page, request }) => {
    // The whole point, end to end. Before this the toast showed a generic
    // English fallback written at the call site, because the message was read
    // one level too shallow and was always undefined.
    //
    // The duplicate name comes from the API rather than being hardcoded: an
    // earlier version typed 'Brakes', which the seed does not contain, so the
    // create SUCCEEDED and the test was asserting on a toast that could never
    // appear.
    const { headers } = await apiCtx(request);
    const listed = await (await request.get(`${API}/categories`, { headers })).json();
    const existing = (listed.data?.items ?? listed.data ?? [])[0];
    expect(existing?.name).toBeTruthy();

    await login(page, 'ar');
    await page.goto(`${BASE}/ar/categories`);

    await page.getByRole('button', { name: ar.categories.create }).first().click();
    const name = page.locator('input[name="name"]');
    await expect(name).toBeVisible({ timeout: 15000 });
    await name.fill(existing.name);
    await page.locator('form').getByRole('button', { name: ar.common.create }).click();

    await expect(page.getByText(ar.errors.CATEGORY_NAME_TAKEN)).toBeVisible({
      timeout: 15000,
    });
  });

  test('TC-ERR-06: resolving a refusal never leaves the reader with nothing', async () => {
    // Exercises the real resolver rather than restating its logic, which is
    // what an earlier version of this test did — it asserted on a copy of the
    // rules and would have passed against any implementation at all.
    const dict: Record<string, string> = {
      NOT_ENOUGH_STOCK: 'Only {available} of {product} is in stock.',
      'entity.cycle': 'Cycle',
      NOT_FOUND: '{entity} not found',
    };
    const t = (key: string, values?: Record<string, string | number>) => {
      const found = dict[key];
      if (found === undefined) return `errors.${key}`;  // how next-intl misses
      return found.replace(/\{(\w+)\}/g, (whole, k) =>
        values && k in values ? String(values[k]) : whole,
      );
    };
    const err = (error: any) => ({ response: { data: { error } } });

    // A code this build has never heard of: the server's English, not a blank.
    expect(
      resolveApiError(
        err({ code: 'A_CODE_FROM_THE_FUTURE', message: 'Server said no' }),
        t,
        'fallback',
      ),
    ).toBe('Server said no');

    // A known code: translated, with its params filled in.
    expect(
      resolveApiError(
        err({
          code: 'NOT_ENOUGH_STOCK',
          message: 'english',
          params: { available: '3.000', product: 'Brake Pad Set' },
        }),
        t,
        'fallback',
      ),
    ).toBe('Only 3.000 of Brake Pad Set is in stock.');

    // The entity of a not-found is itself a key, so it gets declined too
    // rather than an English noun landing inside an Arabic sentence.
    expect(
      resolveApiError(err({ code: 'NOT_FOUND', params: { entity: 'cycle' } }), t, 'fb'),
    ).toBe('Cycle not found');

    // Nothing usable anywhere: the call site's own fallback, never ''.
    expect(resolveApiError({}, t, 'fallback')).toBe('fallback');
    expect(resolveApiError(undefined, t, 'fallback')).toBe('fallback');

    // A translator that throws must not take the screen down — the reader is
    // already looking at an error.
    const throwing = () => {
      throw new Error('missing message');
    };
    expect(
      resolveApiError(err({ code: 'NOT_ENOUGH_STOCK', message: 'english' }), throwing, 'fb'),
    ).toBe('english');
  });
});
