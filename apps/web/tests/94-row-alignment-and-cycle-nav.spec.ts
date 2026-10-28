/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Field rows stay level; a cycle opens its page (owner, 2026-10-11)
 * ═══════════════════════════════════════════════════════════════════════
 *  Two owner reports, one branch:
 *
 *  1. Fields side by side drifted apart the moment one showed its error: a
 *     row aligned to the bottom, so the field with "Required" under it rose
 *     and its neighbours (and the `+` beside a picker) did not. Every row is a
 *     `.field-row` now — top-aligned, one box height — and this measures the
 *     boxes on screen with an error showing, at a desktop and a phone width.
 *
 *  2. Clicking a cycle opened the wizard whenever it was still being set up,
 *     and the only road from the wizard to the cycle's page was Finish. A row
 *     now always opens the details page; "Continue setup" is the named way
 *     back into the wizard, for wizard statuses and for a role that may write
 *     the cycle; changing status is a button on the details page.
 *
 *  Reached by clicking, as a person does (CLAUDE.md §2). Both directions on
 *  roles (§12): an investor is refused, a partner still gets it. Only the
 *  partners use the office since 2026-10-19 (investors are refused at the
 *  door), so the investor's side is the API's alone, with investorSession's
 *  hand-signed token.
 */
import { test, expect, Page, APIRequestContext, Locator } from '@playwright/test';
import en from '../src/i18n/locales/en.json';
import ar from '../src/i18n/locales/ar.json';
import { API, apiCtx, PASSWORD, EMAIL, aCorePartnerUser, investorSession, orderSomething } from './support/fixtures';
import { measureFieldRows, worst } from './support/row-alignment';
import { WEB as BASE } from './support/env';

const MSG = { en, ar } as const;

async function login(page: Page, locale: 'en' | 'ar' = 'en') {
  await page.goto(`${BASE}/${locale}/login`);
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 20000 });
}

async function statusOf(request: APIRequestContext, headers: Record<string, string>, id: string) {
  const r = await (await request.get(`${API}/cycles/${id}`, { headers })).json();
  return (r.data ?? r).status as string;
}

/** From the menu to the cycles list, by clicking. */
async function openCycles(page: Page, locale: 'en' | 'ar' = 'en') {
  await page.locator(`aside a[href="/${locale}/cycles"]`).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/cycles$`), { timeout: 15000 });
  await expect(page.getByTestId('cycle-row').first()).toBeVisible({ timeout: 15000 });
}

const rowOf = (page: Page, code: string) => page.getByTestId('cycle-row').filter({ hasText: code });

/** The top and height of a locator's box, as drawn. */
async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b, 'element has no box').not.toBeNull();
  return b!;
}

/**
 * A PLANNING cycle (setup still to do), a CANCELLED one (nothing left to set
 * up, nowhere to move), both with a fresh investor on them so the investor can
 * see them. Built through the API as a partner (rule 4).
 */
async function cycles(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const partner = await aCorePartnerUser(request, headers);
  const investor = await investorSession(request, 'nav');
  const participants = [
    { participantType: 'TEMP_INVESTOR', investorUserId: investor.user.id, contributionAmount: 400, investorFeePct: 10 },
    { participantType: 'CORE_PARTNER', partnerUserId: partner.id, contributionAmount: 600 },
  ];
  const cancelled = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP', participants });
  await mk(`cycles/${cancelled.id}/transition`, { status: 'CANCELLED' });
  const planning = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP', participants });
  return { headers, planning, cancelled, investor: investor.headers };
}

// ─── 1. Field rows ──────────────────────────────────────────────────────

test.describe('Field rows stay level when one shows its error', () => {
  for (const [vp, size] of [
    ['1440', { width: 1440, height: 900 }],
    ['390', { width: 390, height: 844 }],
  ] as const) {
    for (const locale of ['en', 'ar'] as const) {
      test(`TC-ROW-01 (${vp}, ${locale}): the purchase form saved empty: every row, every + and the item line stay level`, async ({ page }) => {
        const m = MSG[locale];
        await page.setViewportSize(size);
        await login(page, locale);
        // Straight to the page: nothing cached matters to the layout, and on a
        // phone the menu is a drawer.
        // Purchases are a tab of Cycles since 2026-10-18; the old address lands on it.
        await page.goto(`${BASE}/${locale}/purchases`);
        await expect(page).toHaveURL(new RegExp(`/${locale}/cycles\\?view=purchases$`), { timeout: 15000 });
        await page.getByRole('button', { name: m.purchases.create }).first().click();
        await page.getByRole('button', { name: m.purchases.addItem }).first().click();

        const line = page.locator('form .field-row').filter({ has: page.locator('[data-quick-create="product"]') }).first();
        await expect(line).toBeVisible();

        // Save it empty: Cycle, Supplier and Ordered date show "Required", twice over —
        // the second submit is where a margin guessing the error line doubled.
        for (const attempt of [1, 2]) {
          await page.locator('[role="dialog"] button[type="submit"]:visible').last().click();
          await expect(page.locator('form [role="alert"]:visible').first(), `attempt ${attempt}`).toBeVisible();

          const lines = await measureFieldRows(page, 'form');
          const w = worst(lines);
          expect(w.lines, 'no field rows were measured').toBeGreaterThan(0);
          expect(w.topDelta, JSON.stringify(lines)).toBeLessThanOrEqual(1);
          expect(w.heightDelta, JSON.stringify(lines)).toBeLessThanOrEqual(1);
          expect(w.actionDelta, JSON.stringify(lines)).toBeLessThanOrEqual(1);
        }

        // The supplier shows "Required" under itself; its + stays level with
        // the picker, not with the error line, and so does the cycle beside it.
        const supplierPlus = page.locator('form [data-quick-create="supplier"]');
        const supplierRow = supplierPlus.locator('xpath=..');
        const sp = await box(supplierPlus);
        const sb = await box(supplierRow.locator('[data-slot="select-trigger"]').first());
        expect(Math.abs(sp.y - sb.y), 'supplier + vs picker').toBeLessThanOrEqual(1);
        expect(Math.abs(sp.height - sb.height)).toBeLessThanOrEqual(1);

        // The + sits level with the product picker it creates for.
        const plus = await box(line.locator('[data-quick-create="product"]'));
        const picker = await box(line.locator('[data-slot="select-trigger"]').first());
        expect(Math.abs(plus.y - picker.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(plus.height - picker.height)).toBeLessThanOrEqual(1);

        // The quantity box is level with the product box on a desktop, where
        // they share a line; on a phone the product takes the whole line.
        const qty = await box(line.locator('input[type="number"]').first());
        const row = await box(line);
        if (vp === '1440') {
          expect(Math.abs(qty.y - picker.y), 'qty drifted from the product box').toBeLessThanOrEqual(1);
        } else {
          // basis-full: the product field is (nearly) the row's width, and the
          // numbers wrap beneath it rather than squeezing it to a sliver.
          const field = await box(line.locator('> div').first());
          expect(field.width).toBeGreaterThan(row.width * 0.8);
          expect(qty.y).toBeGreaterThan(picker.y + picker.height);
        }
      });
    }
  }

  test('TC-ROW-02: the category + over a half-filled product form: its own empty save shows "Required", cancel leaves the product form as typed', async ({ page }) => {
    await login(page);
    await page.locator('aside a[href="/en/products"]').click();
    await page.getByRole('button', { name: en.products.create }).first().click();
    const name = page.locator('input[name="name"]').first();
    await expect(name).toBeVisible();

    await page.locator('[role="dialog"] button[type="submit"]:visible').last().click();
    await expect(page.locator('[role="alert"]:visible').first()).toBeVisible();
    let w = worst(await measureFieldRows(page));
    expect(w.lines).toBeGreaterThan(0);
    expect(Math.max(w.topDelta, w.heightDelta, w.actionDelta)).toBeLessThanOrEqual(1);

    // Type a name, then open the category's own form on top and break it too.
    await name.fill('Typed before the +');
    await page.locator('[data-quick-create="category"]').first().click();
    const dialog = page.locator('[data-quick-create-dialog="category"]');
    await expect(dialog).toBeVisible();
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog.locator('[role="alert"]').first()).toBeVisible();
    w = worst(await measureFieldRows(page, '[data-quick-create-dialog="category"]'));
    expect(w.topDelta).toBeLessThanOrEqual(1);
    expect(w.heightDelta).toBeLessThanOrEqual(1);

    // Cancel: the form underneath kept what was typed.
    await dialog.getByRole('button', { name: en.common.cancel, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(name).toHaveValue('Typed before the +');
  });
});

// ─── 2. Opening a cycle ─────────────────────────────────────────────────

test.describe('A cycle opens its page; Continue setup resumes the wizard', () => {
  test('TC-NAV-01: clicking a cycle still in setup opens its details, not the wizard — and again on the second visit', async ({ page, request }) => {
    const { planning } = await cycles(request);
    await login(page);
    for (const visit of [1, 2]) {
      await openCycles(page);
      await rowOf(page, planning.code).locator('td').first().click();
      await expect(page, `visit ${visit}`).toHaveURL(new RegExp(`/cycles/${planning.id}/details$`), { timeout: 15000 });
      await expect(page.getByRole('heading', { name: planning.code })).toBeVisible();
    }
  });

  test('TC-NAV-02: Continue setup is on a setup cycle only, opens the wizard, and the wizard leads back to the cycle', async ({ page, request }) => {
    const { planning, cancelled } = await cycles(request);
    await login(page);
    await openCycles(page);

    // Not on a cycle with nothing left to set up — on its row or its page.
    await expect(rowOf(page, cancelled.code).getByTestId('continue-setup')).toHaveCount(0);
    await rowOf(page, cancelled.code).getByTestId('cycle-details').click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${cancelled.id}/details$`));
    await expect(page.getByTestId('cycle-status')).toBeVisible();
    await expect(page.getByTestId('continue-setup')).toHaveCount(0);

    // On the setup cycle's row: the wizard, not the details (the row's own
    // click must not fire as well).
    await openCycles(page);
    await rowOf(page, planning.code).getByTestId('continue-setup').click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${planning.id}$`), { timeout: 15000 });
    await expect(page.getByRole('button', { name: en.wizard.backToCycle })).toBeVisible({ timeout: 15000 });

    // Out of the wizard without finishing it, to the cycle's page — and from
    // there back in by the header's Continue setup.
    await page.getByRole('button', { name: en.wizard.backToCycle }).click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${planning.id}/details$`), { timeout: 15000 });
    await page.getByTestId('continue-setup').click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${planning.id}$`), { timeout: 15000 });
  });

  for (const locale of ['en', 'ar'] as const) {
    test(`TC-NAV-03 (${locale}): Details sits at the same place in every row, with or without Continue setup`, async ({ page, request }) => {
      const { planning, cancelled } = await cycles(request);
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page, locale);
      await openCycles(page, locale);

      const withSetup = await box(rowOf(page, planning.code).getByTestId('cycle-details'));
      const without = await box(rowOf(page, cancelled.code).getByTestId('cycle-details'));
      await expect(rowOf(page, planning.code).getByTestId('continue-setup')).toBeVisible();
      // The column's end: right in English, left in Arabic. Both edges are
      // checked, so a Details that moved by its own width still fails.
      expect(Math.abs(withSetup.x - without.x), `${locale}: Details x`).toBeLessThanOrEqual(1);
      expect(Math.abs(withSetup.x + withSetup.width - (without.x + without.width))).toBeLessThanOrEqual(1);

      // And every Details on the page agrees with them.
      const all = page.getByTestId('cycle-details');
      for (let i = 0; i < (await all.count()); i++) {
        const b = await box(all.nth(i));
        expect(Math.abs(b.x - without.x), `${locale}: row ${i}`).toBeLessThanOrEqual(1);
      }
    });
  }

  // TC-NAV-04's screen half (the investor opens the page, is offered no setup or
  // status change) removed (owner 2026-10-19): only the partners use the office;
  // investors are refused at the door. The server's refusal stays.
  test('TC-NAV-04: the server refuses an investor on the cycle a status change', async ({ request }) => {
    const { headers, planning, investor } = await cycles(request);
    const refused = await request.post(`${API}/cycles/${planning.id}/transition`, {
      headers: investor,
      data: { status: 'FUNDING' },
    });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error?.code).toBe('ROLE_NOT_ALLOWED');
    expect(await statusOf(request, headers, planning.id)).toBe('PLANNING');
  });
});

test.describe('The wizard stops when the goods leave (owner, 2026-10-12)', () => {
  test('TC-NAV-05: a cycle past Purchasing offers no Continue setup, and the wizard\'s address lands on its page', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const { planning } = await cycles(request);
    // A UAE-direct cycle arrives in the UAE with nothing asked of its leg:
    // the shortest honest way past Purchasing — once something is ordered,
    // which Preparing needs (§1, 2026-10-27).
    await orderSomething(mk, planning.id, 'NAV-05');
    for (const status of ['FUNDING', 'PURCHASING', 'PREPARING', 'ARRIVED_UAE']) {
      await mk(`cycles/${planning.id}/transition`, { status });
    }
    expect(await statusOf(request, headers, planning.id)).toBe('ARRIVED_UAE');

    await login(page);
    await openCycles(page);
    const row = rowOf(page, planning.code);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('continue-setup')).toHaveCount(0);
    await row.locator('td').first().click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${planning.id}/details$`), { timeout: 15000 });
    await expect(page.getByTestId('cycle-status')).toBeVisible();
    await expect(page.getByTestId('continue-setup')).toHaveCount(0);

    // Typed by hand, the wizard sends it to its page and offers nothing to finish.
    await page.goto(`${BASE}/en/cycles/${planning.id}`);
    await expect(page).toHaveURL(new RegExp(`/cycles/${planning.id}/details$`), { timeout: 15000 });
    await expect(page.getByRole('button', { name: /^finish$/i })).toHaveCount(0);
  });
});

// ─── 3. Change status, on the details page ──────────────────────────────

test.describe('Change status lives on the cycle\'s page', () => {
  test('TC-STAT-01: a partner moves a cycle on, the page says so, and cancel sends nothing', async ({ page, request }) => {
    const { headers, planning } = await cycles(request);
    await login(page);
    await openCycles(page);
    await rowOf(page, planning.code).locator('td').first().click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${planning.id}/details$`), { timeout: 15000 });

    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/transition')) posts.push(r.url());
    });

    // Open and cancel: the same options, nothing sent.
    await page.getByTestId('change-status').click();
    const dialog = page.getByTestId('change-status-dialog');
    await expect(dialog).toBeVisible();
    // Only the moves the server allows from PLANNING.
    await expect(dialog.locator('[data-status]')).toHaveCount(2);
    await expect(dialog.locator('[data-status="FUNDING"]')).toBeVisible();
    await expect(dialog.locator('[data-status="CANCELLED"]')).toBeVisible();
    await dialog.getByRole('button', { name: en.common.cancel, exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(posts).toEqual([]);
    expect(await statusOf(request, headers, planning.id)).toBe('PLANNING');

    // Now move it.
    await page.getByTestId('change-status').click();
    await dialog.locator('[data-status="FUNDING"]').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(en.cycles.statusUpdated)).toBeVisible();
    await expect(page.getByTestId('cycle-status')).toHaveText(en.codes.cycleStatus.FUNDING);
    expect(posts).toHaveLength(1);
    expect(await statusOf(request, headers, planning.id)).toBe('FUNDING');

    // The second visit offers FUNDING's moves, not PLANNING's.
    await page.getByTestId('change-status').click();
    await expect(dialog.locator('[data-status="FUNDING"]')).toHaveCount(0);
    await expect(dialog.locator('[data-status="PURCHASING"]')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('TC-STAT-02: a cancelled cycle offers no status change — there is nowhere to go', async ({ page, request }) => {
    const { cancelled } = await cycles(request);
    await login(page);
    await openCycles(page);
    await rowOf(page, cancelled.code).getByTestId('cycle-details').click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${cancelled.id}/details$`));
    await expect(page.getByTestId('cycle-status')).toBeVisible();
    await expect(page.getByTestId('change-status')).toHaveCount(0);
  });

  test('TC-STAT-03: the server refuses a move the table does not allow, a cycle that is not there, and an id that is not one', async ({ request }) => {
    const { headers, planning } = await cycles(request);
    const skip = await request.post(`${API}/cycles/${planning.id}/transition`, { headers, data: { status: 'SELLING' } });
    expect(skip.status()).toBe(400);
    // The table's refusal, not a later check that happens to refuse as well.
    expect((await skip.json()).error?.code).toBe('BAD_STATUS_TRANSITION');
    expect(await statusOf(request, headers, planning.id)).toBe('PLANNING');

    const nobody = await request.post(`${API}/cycles/00000000-0000-4000-8000-000000000000/transition`, {
      headers,
      data: { status: 'FUNDING' },
    });
    expect(nobody.status()).toBe(404);
    expect((await nobody.json()).error?.code).toBe('NOT_FOUND');

    const junk = await request.post(`${API}/cycles/not-a-uuid/transition`, { headers, data: { status: 'FUNDING' } });
    expect(junk.status()).toBe(400);
  });
});
