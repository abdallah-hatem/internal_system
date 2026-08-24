/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: A draft never restores onto records that are gone
 * ═══════════════════════════════════════════════════════════════════════
 *  The wizard draft lives in localStorage, so it outlives the database it was
 *  written against: a reset, a cycle someone else deleted, a switch between
 *  environments. It then restored ids for rows that no longer existed.
 *
 *  What that looked like: the wizard reopened on the shipping step holding a
 *  leg id from the old database, and Save & Continue tried to UPDATE that leg —
 *  "Shipping leg not found", on a step the person had not touched yet, with no
 *  way past it and nothing on screen explaining why.
 *
 *  Two defences, and both are tested: the draft is dropped when its cycle has
 *  gone, and a leg id that no longer resolves falls back to creating rather
 *  than refusing to save.
 */
import { test, expect, Page } from '@playwright/test';
import { apiCtx, API } from './support/fixtures';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';
const DRAFT_KEY = 'cycle-wizard-draft';

const GONE_CYCLE = '11111111-1111-4111-8111-111111111111';
const GONE_LEG = '22222222-2222-4222-8222-222222222222';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

const pickerFor = (page: Page, name: string) =>
  page.locator(`input[type="hidden"][name="${name}"]`).locator('..').getByRole('combobox');

const banner = (page: Page) => page.getByTestId('wizard-draft-restored');

/** A draft written against a database that no longer exists. */
function staleDraft(overrides: Record<string, unknown> = {}) {
  return {
    currentStep: 2,
    maxStepReached: 2,
    cycleId: GONE_CYCLE,
    cycleCode: 'CYC-GONE-0001',
    poId: null,
    poReference: null,
    legIds: { 1: GONE_LEG },
    shippingLegId: null,
    originType: 'UAE_DIRECT',
    poSupplierId: '',
    poCurrency: 'EGP',
    poFxRate: '1',
    poOrderedOn: '',
    lineItems: [],
    receiveItems: [],
    shippingProvider: '',
    shippingOrigin: '',
    shippingDestination: '',
    shippingTrackingRef: '',
    shippingDepartedOn: '',
    shippingArrivedOn: '',
    shippingAmount: '',
    ...overrides,
  };
}

const seedDraft = (page: Page, draft: Record<string, unknown>) =>
  page.evaluate(
    ([k, d]) =>
      localStorage.setItem(
        k as string,
        JSON.stringify({ state: { draft: d, savedAt: Date.now() }, version: 0 }),
      ),
    [DRAFT_KEY, draft] as const,
  );

test.describe('A draft whose records are gone', () => {
  test('TC-STALE-01: is discarded rather than restored', async ({ page }) => {
    await login(page);
    await seedDraft(page, staleDraft());

    await page.goto(`${BASE}/en/cycles/new`);

    // Step 1, clean — not step 3 holding a cycle that does not exist.
    await expect(pickerFor(page, 'originType')).toBeVisible({ timeout: 15000 });
    await expect(banner(page)).toHaveCount(0);
  });

  test('TC-STALE-02: does not come back on the next load', async ({ page }) => {
    // Clearing it on screen but leaving it in storage would resurrect it, and
    // the person would meet the same dead end again tomorrow.
    await login(page);
    await seedDraft(page, staleDraft());

    await page.goto(`${BASE}/en/cycles/new`);
    await expect(pickerFor(page, 'originType')).toBeVisible({ timeout: 15000 });

    // The guard confirms the cycle over the network before dropping the draft,
    // so step 1 is on screen a moment before storage is cleared. Reloading
    // straight away raced it.
    await page.waitForFunction(
      ([k, gone]) => {
        const raw = localStorage.getItem(k as string);
        return !raw || JSON.parse(raw).state.draft?.cycleId !== gone;
      },
      [DRAFT_KEY, GONE_CYCLE] as const,
      { timeout: 15000 },
    );

    await page.reload();
    await expect(pickerFor(page, 'originType')).toBeVisible({ timeout: 15000 });
    await expect(banner(page)).toHaveCount(0);

    const stored = await page.evaluate((k) => {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw).state.draft : null;
    }, DRAFT_KEY);
    expect(stored?.cycleId ?? null).not.toBe(GONE_CYCLE);
  });

  test('TC-STALE-03: a draft whose cycle still exists is kept', async ({
    page,
    request,
  }) => {
    // The guard must not throw away good drafts — that would undo the whole
    // point of persisting one.
    const { mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });

    await login(page);
    await seedDraft(
      page,
      staleDraft({
        currentStep: 1,
        maxStepReached: 1,
        cycleId: cycle.id,
        cycleCode: cycle.code,
        legIds: {},
      }),
    );

    await page.goto(`${BASE}/en/cycles/new`);
    await expect(banner(page)).toBeVisible({ timeout: 15000 });
    await expect(pickerFor(page, 'supplierId')).toBeVisible();
  });

  test('TC-STALE-04: a draft that never reached the server is kept', async ({
    page,
  }) => {
    // Nothing saved yet means nothing can have gone stale, and there is no
    // cycle to check — this must not be treated as a dead draft.
    await login(page);
    await seedDraft(
      page,
      staleDraft({ currentStep: 0, maxStepReached: 0, cycleId: null, legIds: {} }),
    );

    await page.goto(`${BASE}/en/cycles/new`);
    await expect(banner(page)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('input[type="hidden"][name="originType"]')).toHaveValue(
      'UAE_DIRECT',
    );
  });
});

test.describe('A shipping leg that is no longer there', () => {
  test('TC-STALE-05: saving creates it instead of refusing', async ({
    page,
    request,
  }) => {
    // The exact failure reported: Save & Continue answered "Shipping leg not
    // found" and there was no way forward. A leg id can outlive the leg —
    // deleted in another tab, or carried in from an older database — and the
    // person still wants this leg recorded.
    const { mk, headers } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const supplier = await mk('suppliers', { name: `Stale Co ${Date.now()}`, country: 'AE' });
    const product = await mk('products', { name: `Stale Part ${Date.now()}`, minStock: 0 });
    await mk(`cycles/${cycle.id}/purchases`, {
      supplierId: supplier.id,
      currency: 'EGP',
      fxRateToEgp: 1,
      orderedOn: new Date().toISOString().slice(0, 10),
      items: [{ productId: product.id, orderedQty: 4, unitPrice: 25 }],
    });

    await login(page);
    // A live cycle, but the leg it thinks it saved is not there.
    await seedDraft(
      page,
      staleDraft({ cycleId: cycle.id, cycleCode: cycle.code, legIds: { 1: GONE_LEG } }),
    );

    await page.goto(`${BASE}/en/cycles/new`);
    await expect(pickerFor(page, 'leg1_providerId')).toBeVisible({ timeout: 20000 });

    await pickerFor(page, 'leg1_providerId').click();
    await page.getByRole('listbox').getByRole('option').first().click();

    // The cost fields are required. Left empty the browser blocks the submit
    // and nothing is sent — an earlier version of this test asserted on a
    // request that was never made.
    await page.locator('input[data-field="leg1_ratePerUnit"]').fill('12');
    await page.locator('input[name="leg1_chargeablePieces"]').fill('4');

    const legPost = page.waitForResponse(
      (r) => r.url().includes('shipping-leg') && r.request().method() === 'POST',
      { timeout: 15000 },
    );
    await page.getByRole('button', { name: /save & continue/i }).click();
    await legPost;

    // No refusal, and the leg exists afterwards.
    await expect(page.getByText(/not found/i)).toHaveCount(0, { timeout: 8000 });

    const detail = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const legs = (detail.data ?? detail).shippingLegs ?? [];
    expect(legs.length).toBe(1);
    expect(legs[0].id).not.toBe(GONE_LEG);
  });
});
