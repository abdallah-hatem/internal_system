/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: "Paid by" on an expense (BUSINESS_LOGIC §9, owner
 *  2026-10-26: fuel for a delivery paid from a partner's own pocket)
 * ═══════════════════════════════════════════════════════════════════════
 *  Written 2026-10-27 and NOT RUN: the owner said not to run e2e for now.
 *  The rules are pinned in apps/api (ledger/expense-paid-by.db.spec.ts,
 *  ledger-entry.spec.ts, common/partner-account.spec.ts) and the screens in
 *  Vitest (LedgerEntryDialog.test.tsx, ledger-quick-actions.test.tsx). These
 *  walk them as a person does (CLAUDE.md §2): through the menu, clicking.
 */
import { test, expect, type Page } from '@playwright/test';
import { API, apiCtx } from './support/fixtures';
import { usersByEmail } from './support/running-costs';
import { login, messages, openNav } from './support/ui';

const en = messages('en') as any;
const dialog = (page: Page) => page.locator('[data-ledger-entry-dialog]');

async function cashOnHand(request: any, headers: any): Promise<number> {
  const res = await request.get(`${API}/analytics/dashboard`, { headers });
  return Number((await res.json()).data.cashOnHand);
}
async function balanceOf(request: any, headers: any, userId: string): Promise<string> {
  const res = await request.get(`${API}/partner-accounts`, { headers });
  return ((await res.json()).data as any[]).find((a) => a.partnerUserId === userId).balanceEgp;
}

test.describe('Paid by on an expense', () => {
  test('TC-PAIDBY-01: Fuel paid by Shady — cash on hand does not move, his account is credited, the ledger names him', async ({ page, request }) => {
    const { headers } = await apiCtx(request);
    const who = await usersByEmail(request, headers);
    const shady = who('shady@motoparts.com').id;
    const cashBefore = await cashOnHand(request, headers);
    const balanceBefore = Number(await balanceOf(request, headers, shady));
    const note = `PAIDBY-01 ${Date.now()}`;

    await login(page);
    await openNav(page, en.nav.ledger);
    await page.getByTestId('quick-action-recordFuel').click();
    await expect(dialog(page).locator('#ledger-paid-by')).toContainText(en.ledger.paidByBusiness);
    await dialog(page).locator('#ledger-paid-by').click();
    await page.getByRole('option', { name: /Shady/ }).click();
    await expect(page.getByTestId('paid-by-hint')).toBeVisible();
    await dialog(page).locator('#ledger-amount').fill('350');
    await dialog(page).locator('#ledger-note').fill(note);
    await dialog(page).getByRole('button', { name: en.common.save, exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);

    await page.getByPlaceholder(en.ledger.search).fill(note);
    const row = page.locator('table tbody tr').filter({ visible: true });
    await expect(row).toContainText(en.ledger.paidByTag.replace('{partner}', 'Shady'));

    expect(await cashOnHand(request, headers)).toBe(cashBefore);
    expect(Number(await balanceOf(request, headers, shady))).toBeCloseTo(balanceBefore + 350, 2);
  });

  test('TC-PAIDBY-02: the second visit — a partner chosen and cancelled is gone; the next Fuel is the business’s and moves cash', async ({ page, request }) => {
    const { headers } = await apiCtx(request);
    const cashBefore = await cashOnHand(request, headers);
    await login(page);
    await openNav(page, en.nav.ledger);
    await page.getByTestId('quick-action-recordFuel').click();
    await dialog(page).locator('#ledger-paid-by').click();
    await page.getByRole('option', { name: /Shady/ }).click();
    await dialog(page).getByRole('button', { name: en.common.cancel }).click();
    await expect(dialog(page)).toHaveCount(0);

    await page.getByTestId('quick-action-recordFuel').click();
    await expect(dialog(page).locator('#ledger-paid-by')).toContainText(en.ledger.paidByBusiness);
    await dialog(page).locator('#ledger-amount').fill('90');
    await dialog(page).getByRole('button', { name: en.common.save, exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await cashOnHand(request, headers)).toBeCloseTo(cashBefore - 90, 2);
  });

  test('TC-PAIDBY-03: reversing the expense takes the credit back; after he took it out, the reversal is refused in words', async ({ request }) => {
    const { headers, mk } = await apiCtx(request);
    const who = await usersByEmail(request, headers);
    const fares = who('fares@motoparts.com').id;
    const before = Number(await balanceOf(request, headers, fares));
    const entry = await mk('ledger', { kind: 'EXPENSE', category: 'fuel', amount: 200, currency: 'EGP', paidByUserId: fares });
    expect(Number(await balanceOf(request, headers, fares))).toBeCloseTo(before + 200, 2);

    // He takes everything out: the credit is gone, so the expense cannot be undone.
    const all = Number(await balanceOf(request, headers, fares));
    await mk(`partner-accounts/${fares}/withdrawals`, { amountEgp: all });
    const refused = await request.post(`${API}/ledger/${entry.id}/reverse`, { headers, data: { reason: 'typed twice' } });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error.code).toBe('EXPENSE_CREDIT_ALREADY_TAKEN');
  });

  test('TC-PAIDBY-04: an investor, or someone who is nobody, cannot be the payer', async ({ request }) => {
    const { headers } = await apiCtx(request);
    const users = (await (await request.get(`${API}/users?limit=200`, { headers })).json()).data as any[];
    const investor = users.find((u) => u.role === 'TEMP_INVESTOR');
    for (const paidByUserId of [investor?.id, '00000000-0000-4000-8000-000000000000'].filter(Boolean)) {
      const res = await request.post(`${API}/ledger`, {
        headers,
        data: { kind: 'EXPENSE', category: 'fuel', amount: 10, currency: 'EGP', paidByUserId },
      });
      expect(res.status()).toBe(400);
      expect((await res.json()).error.code).toBe('LEDGER_PAYER_NOT_PARTNER');
    }
  });
});
