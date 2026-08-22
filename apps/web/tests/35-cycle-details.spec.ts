/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Cycle details, and the participants nothing could add
 * ═══════════════════════════════════════════════════════════════════════
 *  A cycle had two fates in the list: one still in the wizard opened the
 *  wizard, one past it opened a drawer of counts. Neither showed what a cycle
 *  contained, and a closed cycle — the one you most want to look back at —
 *  showed the least.
 *
 *  Worse, no screen could add a participant. The API had the endpoint and the
 *  settlement maths expected them, so every cycle had none and settling
 *  reported "No participants found for this cycle" with no way to fix it.
 */
import { test, expect, Page, APIRequestContext } from '@playwright/test';
import { apiCtx, API } from './support/fixtures';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

async function aCycle(request: APIRequestContext) {
  const { headers, mk } = await apiCtx(request);
  const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  const users = await (await request.get(`${API}/users`, { headers })).json();
  return { headers, mk, cycle, users: users.data ?? users };
}

test.describe('Cycle details', () => {
  test('TC-CYC-D1: a cycle in any status opens its details', async ({ page, request }) => {
    const { cycle } = await aCycle(request);
    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}/details`);
    await expect(page.getByRole('heading', { name: cycle.code })).toBeVisible({ timeout: 15000 });
  });

  test('TC-CYC-D2: a closed cycle is still readable', async ({ page, request }) => {
    // The point of the complaint. History is exactly what you want to reread.
    const { mk, cycle } = await aCycle(request);
    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION', 'SELLING', 'SETTLEMENT', 'CLOSED']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }

    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}/details`);
    await expect(page.getByRole('heading', { name: cycle.code })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('CLOSED')).toBeVisible();

    // Readable, not editable: a closed cycle is history.
    await expect(page.getByRole('button', { name: /add participant/i })).toHaveCount(0);
  });

  test('TC-CYC-D3: a participant can be added, which nothing could do before', async ({
    page,
    request,
  }) => {
    const { headers, cycle, users } = await aCycle(request);
    await login(page);
    await page.goto(`${BASE}/en/cycles/${cycle.id}/details`);

    await page.getByRole('button', { name: /add participant/i }).click();

    const person = page
      .locator('input[type="hidden"][name="userId"]')
      .locator('..')
      .getByRole('combobox');
    await person.click();
    await page.getByRole('listbox').getByRole('option').first().click();

    await page.locator('input[name="contributionAmount"]').fill('40000');
    await page.getByRole('button', { name: /save/i }).click();

    await expect
      .poll(async () => {
        const res = await request.get(`${API}/cycles/${cycle.id}`, { headers });
        return ((await res.json()).data?.participants ?? []).length;
      }, { timeout: 15000 })
      .toBe(1);

    // And the person is named, not a dash.
    await expect(page.getByText(users[0].partner?.displayName ?? users[0].email)).toBeVisible();
  });

  test('TC-CYC-D4: the cycle payload never carries a password hash', async ({ request }) => {
    // Including the participant's User relation whole sent every partner's
    // bcrypt hash to the browser alongside the cycle.
    const { headers, mk, cycle, users } = await aCycle(request);
    await mk(`cycles/${cycle.id}/participants`, {
      participantType: 'CORE_PARTNER',
      partnerUserId: users[0].id,
      contributionAmount: 1000,
    });

    const res = await request.get(`${API}/cycles/${cycle.id}`, { headers });
    const body = await res.text();
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('$2b$');
  });

  test('TC-CYC-D5: a closed cycle refuses a new participant at the API too', async ({
    request,
  }) => {
    // The button is hidden, which is not the same as the rule existing.
    const { headers, mk, cycle, users } = await aCycle(request);
    for (const status of ['FUNDING', 'PURCHASING', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION', 'SELLING', 'SETTLEMENT', 'CLOSED']) {
      await mk(`cycles/${cycle.id}/transition`, { status });
    }

    const res = await request.post(`${API}/cycles/${cycle.id}/participants`, {
      headers,
      data: {
        participantType: 'CORE_PARTNER',
        partnerUserId: users[0].id,
        contributionAmount: 1000,
      },
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/closed/i);
  });

  test('TC-CYC-D6: a contribution cannot be negative', async ({ request }) => {
    const { headers, cycle, users } = await aCycle(request);
    const res = await request.post(`${API}/cycles/${cycle.id}/participants`, {
      headers,
      data: {
        participantType: 'CORE_PARTNER',
        partnerUserId: users[0].id,
        contributionAmount: -5000,
      },
    });
    expect(res.status()).toBe(400);
  });
});
