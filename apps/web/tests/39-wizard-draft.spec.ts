/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The new-cycle wizard survives a reload
 * ═══════════════════════════════════════════════════════════════════════
 *  The wizard creates records as it goes — the cycle in step 1, the purchase
 *  order in step 2 — but the URL stays /cycles/new throughout. A reload used
 *  to throw away the only reference to what had just been created.
 *
 *  The draft now persists to localStorage. Most of what follows is about the
 *  ways that can go wrong rather than the way it should work: a draft that
 *  leaks into a different cycle, one that outlives the work it belongs to, one
 *  that cannot be dismissed, and — the expensive one — a restored cycleId that
 *  gets ignored, leaving a second cycle behind on every reload.
 */
import { test, expect, Page } from '@playwright/test';
import { apiCtx, API } from './support/fixtures';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';
const DRAFT_KEY = 'cycle-wizard-draft';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

const pickerFor = (page: Page, name: string) =>
  page.locator(`input[type="hidden"][name="${name}"]`).locator('..').getByRole('combobox');

const hidden = (page: Page, name: string) =>
  page.locator(`input[type="hidden"][name="${name}"]`);

async function choose(page: Page, name: string, index = 0) {
  await pickerFor(page, name).click();
  await page.getByRole('listbox').getByRole('option').nth(index).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

const banner = (page: Page) => page.getByTestId('wizard-draft-restored');

/** How many cycles exist right now. */
async function cycleCount(request: any) {
  const { headers } = await apiCtx(request);
  const res = await request.get(`${API}/cycles`, { headers });
  const body = await res.json();
  const list = body.data?.items ?? body.data ?? [];
  return Array.isArray(list) ? list.length : 0;
}

const readDraft = (page: Page) =>
  page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw).state : null;
  }, DRAFT_KEY);

/**
 * Walk step 1 of a fresh wizard, leaving it on the purchase order step with a
 * cycle already created server-side.
 */
async function startNewCycle(page: Page) {
  await page.goto(`${BASE}/en/cycles/new`);
  await expect(pickerFor(page, 'originType')).toBeVisible({ timeout: 15000 });
  await choose(page, 'originType', 0);
  await choose(page, 'currency', 0);
  await page.getByRole('button', { name: /next|continue|create/i }).first().click();
  await expect(pickerFor(page, 'supplierId')).toBeVisible({ timeout: 15000 });
}

test.describe('New-cycle wizard draft', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.evaluate((k) => localStorage.removeItem(k), DRAFT_KEY);
  });

  test('TC-DRAFT-01: a reload comes back to the step it was on', async ({ page }) => {
    await startNewCycle(page);
    await choose(page, 'supplierId', 0);
    const supplier = await hidden(page, 'supplierId').inputValue();

    await page.reload();

    // Still on the purchase order step, with the supplier that was chosen.
    await expect(pickerFor(page, 'supplierId')).toBeVisible({ timeout: 15000 });
    await expect(hidden(page, 'supplierId')).toHaveValue(supplier);
    await expect(banner(page)).toBeVisible();
  });

  test('TC-DRAFT-02: reloading does not leave a second cycle behind', async ({
    page,
    request,
  }) => {
    // The reason the draft carries a cycleId at all. If a reload dropped it,
    // finishing the wizard would create a duplicate cycle — and the first,
    // abandoned one would sit in the list looking real.
    await startNewCycle(page);
    const after = await cycleCount(request);
    const draft = await readDraft(page);
    expect(draft.draft.cycleId).toBeTruthy();

    await page.reload();
    await expect(pickerFor(page, 'supplierId')).toBeVisible({ timeout: 15000 });

    expect(await cycleCount(request)).toBe(after);
    expect((await readDraft(page)).draft.cycleId).toBe(draft.draft.cycleId);
  });

  test('TC-DRAFT-03: a draft never leaks into a different cycle', async ({ page, request }) => {
    // A draft is scoped to /cycles/new. Resuming a saved cycle must show that
    // cycle, not whatever was left half-typed somewhere else.
    await startNewCycle(page);
    await choose(page, 'supplierId', 0);
    const draftSupplier = await hidden(page, 'supplierId').inputValue();

    const { mk } = await apiCtx(request);
    const other = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'AED' });

    await page.goto(`${BASE}/en/cycles/${other.id}`);
    await expect(pickerFor(page, 'supplierId')).toBeVisible({ timeout: 15000 });

    await expect(banner(page)).toHaveCount(0);
    expect(await hidden(page, 'supplierId').inputValue()).not.toBe(draftSupplier);
    expect(await hidden(page, 'currency').inputValue()).toBe('AED');
  });

  test('TC-DRAFT-04: an untouched wizard saves nothing', async ({ page }) => {
    // Reopening a blank form and being told work was restored is worse than
    // saying nothing at all.
    await page.goto(`${BASE}/en/cycles/new`);
    await expect(pickerFor(page, 'originType')).toBeVisible({ timeout: 15000 });

    await page.reload();
    await expect(pickerFor(page, 'originType')).toBeVisible({ timeout: 15000 });

    await expect(banner(page)).toHaveCount(0);
    // Either no key at all or a key holding no draft — both mean "saved nothing".
    expect((await readDraft(page))?.draft ?? null).toBeNull();
  });

  test('TC-DRAFT-05: "Start over" really discards, across a reload', async ({ page }) => {
    // Clearing the screen but leaving the draft in storage would bring it all
    // back on the next load — the discard has to reach localStorage.
    await startNewCycle(page);
    await choose(page, 'supplierId', 0);

    await page.reload();
    await expect(banner(page)).toBeVisible({ timeout: 15000 });
    await banner(page).getByRole('button', { name: /start over/i }).click();
    await expect(banner(page)).toHaveCount(0);
    await expect(pickerFor(page, 'originType')).toBeVisible();

    await page.reload();
    await expect(pickerFor(page, 'originType')).toBeVisible({ timeout: 15000 });
    await expect(banner(page)).toHaveCount(0);

    // And nothing is left in storage to come back later.
    //
    // The banner alone was not enough. This test failed once inside a full run
    // and passed six times in a row on its own, because whether the banner
    // appears depends on when the save effect happens to fire relative to the
    // reload. The stored value does not depend on that timing, so assert on it.
    //
    // What was actually wrong: `handleStartAnother` reset seventeen fields and
    // missed `originType` and `maxStepReached`, and `draftIsWorthKeeping`
    // returns true on `originType` alone — so the effect that saves on any
    // field change wrote the draft back immediately after it was discarded.
    const stored = await page.evaluate((k) => localStorage.getItem(k), DRAFT_KEY);
    const draft = stored ? JSON.parse(stored)?.state?.draft : null;
    expect(draft, `Start over left a draft behind: ${JSON.stringify(draft)}`).toBeFalsy();
  });

  test('TC-DRAFT-06: a draft older than a week is not offered', async ({ page }) => {
    await startNewCycle(page);
    await choose(page, 'supplierId', 0);

    // Age it past the cap.
    await page.evaluate((k) => {
      const parsed = JSON.parse(localStorage.getItem(k)!);
      parsed.state.savedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
      localStorage.setItem(k, JSON.stringify(parsed));
    }, DRAFT_KEY);

    await page.reload();
    await expect(pickerFor(page, 'originType')).toBeVisible({ timeout: 15000 });
    await expect(banner(page)).toHaveCount(0);
  });

  test('TC-DRAFT-07: a corrupt draft does not break the wizard', async ({ page }) => {
    // Asserting only that step 1 renders is not enough: it rendered even while
    // the restore effect was throwing on a bad shape, because React paints
    // before effects run. Watch for the error itself.
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    // localStorage is editable by hand and survives deploys that change the
    // shape. A wizard that throws on load cannot be recovered from the UI.
    await page.evaluate((k) => {
      // A fresh timestamp on purpose. Dated in the past the age check would
      // drop it first and the corrupt field would never be read.
      const state = { draft: { lineItems: null }, savedAt: Date.now() };
      localStorage.setItem(k, JSON.stringify({ state, version: 0 }));
    }, DRAFT_KEY);

    await page.goto(`${BASE}/en/cycles/new`);

    // The wizard still opens, on step 1, with nothing thrown behind it.
    await expect(pickerFor(page, 'originType')).toBeVisible({ timeout: 15000 });

    // React paints before it runs effects, so the form is on screen a moment
    // before the restore effect would throw. Asserting straight after the
    // picker appears checks an empty list that has not been filled in yet, and
    // passes whether or not the guard is there — let the effect run first.
    await page.waitForTimeout(2000);
    expect(pageErrors).toEqual([]);
  });
});
