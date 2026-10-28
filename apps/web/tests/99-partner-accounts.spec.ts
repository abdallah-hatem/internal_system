/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are parsed JSON; each assertion names the field it checks */
/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: a running account per partner (BUSINESS_LOGIC §8, owner
 *  2026-10-25: "equal thirds, no negative, paid straight to supplier")
 * ═══════════════════════════════════════════════════════════════════════
 *  Written 2026-10-25 and NOT RUN: the owner said not to run e2e for now.
 *  The rules themselves are pinned in apps/api (partner-accounts.db.spec.ts,
 *  common/partner-account.spec.ts) and in 34 (TC-INV-84..88); these walk the
 *  screens as a person does (CLAUDE.md §2): through the menu, never a goto to
 *  the screen.
 */
import { test, expect } from '@playwright/test';
import { API, apiCtx } from './support/fixtures';
import { usersByEmail } from './support/running-costs';
import { login, messages, openCycleByCode, openNav } from './support/ui';

const en = messages('en') as any;

test.describe('Running accounts', () => {
  test('TC-ACC-01: a payment to the supplier shows as paid so far, by whom, and the equal thirds are contributed from the accounts', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const who = await usersByEmail(request, headers);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    // Every partner has paid enough in for his third of 900.
    for (const email of ['abdallah@motoparts.com', 'shady@motoparts.com', 'fares@motoparts.com']) {
      await mk(`partner-accounts/${who(email).id}/advances`, { cycleId: cycle.id, amount: 300 });
    }

    await login(page);
    await openCycleByCode(page, cycle.code);
    // One Funding card since 2026-10-26: a row per partner under "paid so far on this cycle".
    const panel = page.getByTestId('funding-card');
    await expect(panel.getByTestId('paid-so-far')).toContainText('900.00 EGP');
    await expect(panel.getByTestId('paid-row')).toHaveCount(3);

    // A further payment, through the dialog.
    await panel.getByTestId('record-advance').click();
    const dialog = page.getByTestId('record-advance-dialog');
    await dialog.locator('[role="combobox"]').first().click();
    await page.getByRole('option', { name: /^Shady/ }).click();
    await dialog.locator('#advance-amount').fill('150');
    await page.getByRole('button', { name: en.accounts.recordPayment, exact: true }).last().click();
    await expect(panel.getByTestId('paid-so-far')).toContainText('1,050.00 EGP');

    // Contribute 900 equally: three equal shares, then the contributions are on the cycle.
    await panel.getByTestId('contribute-thirds').click();
    const contribute = page.getByTestId('contribute-dialog');
    await contribute.locator('#contribute-total').fill('900');
    await expect(contribute.getByTestId('contribute-share')).toHaveText(['300.00 EGP', '300.00 EGP', '300.00 EGP']);
    await contribute.getByRole('button', { name: new RegExp(`^${en.accounts.contribute}`) }).click();
    await expect(panel.getByTestId('share-put-in')).toHaveText([/300\.00 EGP/, /300\.00 EGP/, /300\.00 EGP/]);
  });

  test('TC-ACC-02: an account that is short stops the contribution on screen, and the API refuses it too', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await login(page);
    await openCycleByCode(page, cycle.code);
    await page.getByTestId('funding-card').getByTestId('contribute-thirds').click();
    const panel = page.getByTestId('contribute-dialog');
    await panel.locator('#contribute-total').fill('999999999');
    await expect(panel.getByTestId('contribute-short').first()).toBeVisible();
    await expect(panel.getByRole('button', { name: new RegExp(`^${en.accounts.contribute}`) })).toBeDisabled();
    const res = await request.post(`${API}/cycles/${cycle.id}/account-contributions`, { headers, data: { totalEgp: 999999999 } });
    expect((await res.json()).error.code).toBe('ACCOUNT_BALANCE_TOO_LOW');
  });

  test('TC-ACC-03: the Partners page shows each account, and taking out more than it holds is refused in the dialog', async ({ page, request }) => {
    const { headers, mk } = await apiCtx(request);
    const who = await usersByEmail(request, headers);
    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    await mk(`partner-accounts/${who('fares@motoparts.com').id}/advances`, { cycleId: cycle.id, amount: 80 });

    await login(page);
    await openNav(page, en.nav.partners);
    const card = page.locator('[data-testid="partner-account"][data-email="fares@motoparts.com"]');
    const balance = Number((await card.getByTestId('account-balance').innerText()).replace(/[^\d.]/g, ''));
    await card.getByTestId('withdraw').click();
    await page.locator('#withdraw-amount').fill(String(balance + 1));
    await page.getByRole('button', { name: en.accounts.takeOut, exact: true }).last().click();
    await expect(page.getByText(/cannot be taken from it/)).toBeVisible();
  });
});
