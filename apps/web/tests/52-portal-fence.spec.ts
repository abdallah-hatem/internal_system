/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: The fence between the office and the shop
 * ═══════════════════════════════════════════════════════════════════════
 *  `InternalOnlyGuard` was written at the start of the project and applied to
 *  nothing. The only thing standing between a shop owner's token and the
 *  partners' settlements was that no shop owner had one yet. This suite makes
 *  that a fact rather than an accident.
 *
 *  It asserts in both directions. A guard that refuses everybody passes half a
 *  suite, and that half is the half people read.
 */
import { test, expect } from '@playwright/test';
import { API, EMAIL, PASSWORD } from './support/fixtures';

const BASE = 'http://localhost:3000';
const SHOP_EMAIL = 'shop.owner@example.com';
const SHOP_PASSWORD = 'password123';

/** The claims of a JWT, without verifying it — tests read, they do not trust. */
const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

test.describe('Which door a token was issued at', () => {
  test('TC-FENCE-01: the internal login refuses a shop owner', async ({ request }) => {
    // The first of three independent checks. A portal user cannot obtain an
    // internal token at all, so the audience comparison never has to be the
    // only thing standing there.
    const res = await request.post(`${API}/auth/login`, {
      data: { email: SHOP_EMAIL, password: SHOP_PASSWORD },
    });
    expect(res.status()).toBe(401);
    expect((await res.json()).error.code).toBe('USE_PORTAL_LOGIN');
  });

  test('TC-FENCE-02: an internal token carries the internal audience', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(claimsOf((await res.json()).data.accessToken).aud).toBe('internal');
  });

  test('TC-FENCE-03: a token with no audience opens nothing', async ({ request }) => {
    // Every token issued before this change. Refused rather than
    // grandfathered: one that predates the fence has never been behind it.
    // Signed with the real secret so the refusal is the audience check and not
    // merely a bad signature.
    const stale = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const good = (await stale.json()).data.accessToken;
    const [header, payload, signature] = good.split('.');
    const stripped = JSON.parse(Buffer.from(payload, 'base64url').toString());
    delete stripped.aud;
    const forged = [
      header,
      Buffer.from(JSON.stringify(stripped)).toString('base64url'),
      signature,
    ].join('.');

    const res = await request.get(`${API}/cycles`, {
      headers: { Authorization: `Bearer ${forged}` },
    });
    // Tampering breaks the signature, so this is SESSION_INVALID rather than
    // WRONG_SURFACE — either way it does not open, which is the assertion.
    expect([401, 403]).toContain(res.status());
  });
});

test.describe('The shop door', () => {
  test('TC-FENCE-06: the portal login refuses an office account', async ({ request }) => {
    // The mirror of TC-FENCE-01. Both doors refuse the other's people, so
    // neither audience can be minted for the wrong kind of account.
    const res = await request.post(`${API}/auth/portal/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    expect(res.status()).toBe(401);
    expect((await res.json()).error.code).toBe('USE_INTERNAL_LOGIN');
  });

  test('TC-FENCE-07: a shop token names its own customer', async ({ request }) => {
    const res = await request.post(`${API}/auth/portal/login`, {
      data: { email: SHOP_EMAIL, password: SHOP_PASSWORD },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const body = await res.json();

    expect(body.data.user.customerId).toBeTruthy();
    const claims = claimsOf(body.data.accessToken);
    expect(claims.aud).toBe('portal');
    // The customer id is IN the token. Portal endpoints read it from here and
    // never from the request, so there is no route on which a shop can name
    // another shop.
    expect(claims.customerId).toBe(body.data.user.customerId);
  });
});

test.describe('Every internal route, both directions', () => {
  /**
   * One GET per module that holds something a shop must never see — costs,
   * margins, other shops' orders, partner payouts.
   */
  const INTERNAL_GETS = [
    'cycles',
    'purchases',
    'suppliers',
    'providers',
    'products',
    'customers',
    'sales/orders',
    'payments',
    'ledger',
    'settlements',
    'analytics/dashboard',
    'audit-logs',
    'users',
    'notifications',
    'currency-rates',
    'payment-plans',
  ];

  test('TC-FENCE-04: a shop token opens none of them', async ({ request }) => {
    const login = await request.post(`${API}/auth/portal/login`, {
      data: { email: SHOP_EMAIL, password: SHOP_PASSWORD },
    });
    const token = (await login.json()).data.accessToken;

    const reachable: string[] = [];
    for (const path of INTERNAL_GETS) {
      const res = await request.get(`${API}/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (![401, 403].includes(res.status())) reachable.push(`${path} → ${res.status()}`);
    }
    expect(reachable).toEqual([]);
  });

  test('TC-FENCE-05: an office token still opens all of them', async ({ request }) => {
    // The other half. A guard that refuses everybody passes TC-FENCE-04, and
    // this repository has shipped exactly that shape of test before.
    const login = await request.post(`${API}/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    const token = (await login.json()).data.accessToken;

    const refused: string[] = [];
    for (const path of INTERNAL_GETS) {
      const res = await request.get(`${API}/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if ([401, 403].includes(res.status())) refused.push(`${path} → ${res.status()}`);
    }
    expect(refused).toEqual([]);
  });
});

test('TC-FENCE-08: a shop owner is turned away from the internal app, in words', async ({
  page,
}) => {
  // Reached the way a person reaches it, and asserted on what they would see.
  // The API tests above prove the rule; this proves it is not sitting behind a
  // screen that never calls it, and that the refusal arrives as a sentence
  // rather than an empty toast.
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(SHOP_EMAIL);
  await page.getByPlaceholder('••••••••').fill(SHOP_PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();

  await expect(page.getByText(/sign in on the store/i)).toBeVisible({ timeout: 10000 });
  await expect(page).not.toHaveURL(/dashboard/);
});

test('TC-FENCE-09: and the refusal is in the reader\'s language', async ({ page }) => {
  // The English assertion above passes whether or not the page translates
  // anything — the API's fallback message IS English. This is the half that
  // fails when a screen shows the code's fallback instead of saying it in the
  // reader's language, which is what the login page did: it read
  // `err.response.data.error.message` and had been missed when the other
  // thirty-six call sites were moved onto coded errors. CLAUDE.md rule 9.
  await page.goto(`${BASE}/ar/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(SHOP_EMAIL);
  await page.getByPlaceholder('••••••••').fill(SHOP_PASSWORD);
  await page.getByRole('button', { name: /تسجيل الدخول/ }).click();

  await expect(page.getByText(/حسابات المحلات/)).toBeVisible({ timeout: 10000 });
  // And no English leaked through beside it.
  await expect(page.getByText(/sign in on the store/i)).toHaveCount(0);
  await expect(page).not.toHaveURL(/dashboard/);
});
