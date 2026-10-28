/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: the Funding card's new investor and its Change split
 *  (BUSINESS_LOGIC §8, 2026-10-27)
 * ═══════════════════════════════════════════════════════════════════════
 *  Written 2026-10-27 and NOT RUN: the owner said not to run e2e for now.
 *  The rules are pinned in apps/api (users/new-investor*.spec.ts,
 *  cycles/profit-split.db.spec.ts) and in funding-card.test.tsx; these walk
 *  the screens as a person does (CLAUDE.md §2): through the menu, never a
 *  goto to the cycle.
 */
import { test, expect } from '@playwright/test';
import { API, apiCtx, refusedCallers } from './support/fixtures';
import { login, messages, openCycleByCode } from './support/ui';

const en = messages('en') as any;
const stamp = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;

async function openCycle(page: any, code: string) {
  await login(page);
  await openCycleByCode(page, code);
  return page.getByTestId('funding-card');
}

test.describe('A new temporary investor from the Funding card', () => {
  test('TC-FUND-01: the + makes him from a name, selects him, and he joins the cycle as an investor', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const name = `Setta ${stamp()}`;

    const card = await openCycle(page, cycle.code);
    await card.getByTestId('add-investor').click();
    const form = page.getByTestId('add-participant-form');
    await form.locator('[data-field="contributionAmount"]').fill('20000');
    await form.locator('[data-quick-create="investor"]').click();
    const dialog = page.locator('[data-quick-create-dialog="investor"]');
    await dialog.locator('input[name="displayName"]').fill(name);
    await dialog.getByRole('button', { name: en.common.create, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // Selected, not a blank field; what was typed underneath still there.
    await expect(form).toContainText(name);
    await expect(form.locator('[data-field="contributionAmount"]')).toHaveValue('20,000');
    await form.getByRole('button', { name: en.common.save, exact: true }).click();
    await expect(card).toContainText(name);

    const users = (await (await request.get(`${API}/users?limit=200`, { headers })).json()).data as any[];
    const made = users.find((u) => u.partner?.displayName === name);
    expect(made.role).toBe('TEMP_INVESTOR');
    expect(made.email).toMatch(/@investors\.invalid$/);
  });

  test('TC-FUND-02: the second visit — Cancel after making one, and Add investor opens with nobody chosen', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const card = await openCycle(page, cycle.code);
    await card.getByTestId('add-investor').click();
    let form = page.getByTestId('add-participant-form');
    await form.locator('[data-quick-create="investor"]').click();
    const dialog = page.locator('[data-quick-create-dialog="investor"]');
    await dialog.locator('input[name="displayName"]').fill(`Cancelled ${stamp()}`);
    await dialog.getByRole('button', { name: en.common.create, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await form.getByRole('button', { name: en.common.cancel, exact: true }).click();
    await expect(form).toHaveCount(0);
    await card.getByTestId('add-investor').click();
    form = page.getByTestId('add-participant-form');
    await expect(form.locator('input[type="hidden"][name="userId"]')).toHaveValue('');
  });

  test('TC-FUND-03: never a partner, and only a core partner may make one — straight at the API', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const res = await request.post(`${API}/users/investors`, {
      headers,
      data: { displayName: `Sneaky ${stamp()}`, role: 'CORE_PARTNER', email: 'x@motoparts.com', password: 'Partner123!' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    expect((await res.json()).data.role).toBe('TEMP_INVESTOR');

    for (const blank of ['', '   ']) {
      const r = await request.post(`${API}/users/investors`, { headers, data: { displayName: blank } });
      expect(r.status()).toBe(400);
      expect((await r.json()).error.code).toBe('INVESTOR_NAME_REQUIRED');
    }
    for (const caller of await refusedCallers(request, 'FundInv')) {
      const r = await request.post(`${API}/users/investors`, { headers: caller.headers, data: { displayName: `No ${stamp()}` } });
      expect(r.status(), caller.who).toBeGreaterThanOrEqual(401);
      expect((await r.json()).error.code, caller.who).toBe(caller.code);
    }
  });
});

test.describe('Change split saved on the server in one go', () => {
  test('TC-FUND-04: the dialog saves the whole split with one request; the card reads it back', async ({ page, request }) => {
    const { mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const card = await openCycle(page, cycle.code);
    const calls: string[] = [];
    page.on('request', (r: any) => {
      if (r.method() === 'PUT' && r.url().includes('/cycles/')) calls.push(r.url());
    });
    await card.getByTestId('change-split').click();
    const dialog = page.getByTestId('split-dialog');
    const fields = dialog.locator('input[data-field^="split-"]');
    await expect(fields).toHaveCount(3);
    for (const [i, v] of ['50', '30', '20'].entries()) await fields.nth(i).fill(v);
    await dialog.getByRole('button', { name: en.common.save, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByTestId('profit-split-line')).toContainText('50 / 30 / 20');
    expect(calls.filter((u) => u.endsWith('/split'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('/cycles/participants/'))).toEqual([]);
  });

  test('TC-FUND-05: straight at the API — 99.99, 100.01, a partial split and another cycle’s participant are refused, nothing saved', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const a = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const b = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const parts = async (id: string) => (await (await request.get(`${API}/cycles/${id}/participants`, { headers })).json()).data as any[];
    const pa = (await parts(a.id)).map((p) => p.id);
    const pb = (await parts(b.id)).map((p) => p.id);
    const save = (id: string, ids: string[], pcts: (number | null)[]) =>
      request.put(`${API}/cycles/${id}/split`, {
        headers,
        data: { split: ids.map((participantId, i) => ({ participantId, customProfitPct: pcts[i] })) },
      });
    const cases: [string[], (number | null)[], string][] = [
      [pa, [33.33, 33.33, 33.33], 'SPLIT_NOT_100'],
      [pa, [33.33, 33.34, 33.34], 'SPLIT_NOT_100'],
      [pa, [50, 50, null], 'PARTIAL_CUSTOM_SPLIT'],
      [pa, [-10, 60, 50], 'SPLIT_PCT_INVALID'],
      [[pa[0], pa[1], pb[2]], [50, 30, 20], 'SPLIT_PARTICIPANT_NOT_ON_CYCLE'],
    ];
    for (const [ids, pcts, code] of cases) {
      const r = await save(a.id, ids, pcts);
      expect(r.status(), code).toBe(400);
      expect((await r.json()).error.code).toBe(code);
    }
    expect((await parts(a.id)).map((p) => p.customProfitPct)).toEqual([null, null, null]);
    for (const caller of await refusedCallers(request, 'FundSplit')) {
      const refused = await request.put(`${API}/cycles/${a.id}/split`, { headers: caller.headers, data: { split: [] } });
      expect((await refused.json()).error.code, caller.who).toBe(caller.code);
    }
  });
});
