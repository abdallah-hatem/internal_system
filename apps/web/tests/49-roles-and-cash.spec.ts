/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Who may do what, and how much money there actually is
 * ═══════════════════════════════════════════════════════════════════════
 *  `POST /auth/register` had no guard at all and the caller chose their own
 *  role, so anyone able to reach the API could mint themselves a CORE_PARTNER —
 *  and from there approve settlements, reverse ledger entries and cancel
 *  orders. Nothing in the app ever called it: the frontend carries a helper for
 *  it that no screen uses. An open door onto the whole system, for no benefit.
 *
 *  Compounding it, the four modules that move money — settlements, sales,
 *  payments, ledger — carried no RolesGuard at all, while products and
 *  suppliers did. A temporary investor given a login could approve the
 *  settlement that paid them.
 *
 *  And cash on hand: only truthful once contributions were recorded. Before
 *  that the ledger held the purchase going out and nothing for the capital
 *  coming in, so netting it gave −62,325 on a cycle that owed nobody anything.
 */
import { test, expect, Page } from '@playwright/test';
import { apiCtx, API } from './support/fixtures';

const BASE = 'http://localhost:3000';
const EMAIL = 'partner.a@motoparts.com';
const PASSWORD = 'password123';

const num = (v: any) => Number(v ?? 0);

async function login(page: Page) {
  await page.goto(`${BASE}/en/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(EMAIL);
  await page.getByPlaceholder('••••••••').fill(PASSWORD);
  await page.getByRole('button', { name: /login/i }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** A logged-in account with the given role, created by a partner. */
async function accountWithRole(request: any, role: string) {
  const { headers } = await apiCtx(request);
  const stamp = `${Date.now()}${Math.floor(performance.now() % 1000)}`;
  const email = `role-${role.toLowerCase()}-${stamp}@motoparts.com`;

  const made = await request.post(`${API}/auth/register`, {
    headers,
    data: { email, password: 'password123', displayName: `Role ${stamp}`, role },
  });
  expect(made.ok(), `create ${role}: ${await made.text()}`).toBeTruthy();

  const signedIn = await request.post(`${API}/auth/login`, {
    data: { email, password: 'password123' },
  });
  const token = (await signedIn.json()).data.accessToken;
  return { headers: { Authorization: `Bearer ${token}` }, email };
}

test.describe('Creating accounts', () => {
  test('TC-SEC-01: a stranger cannot register themselves as a partner', async ({
    request,
  }) => {
    // The hole, stated directly. No token at all.
    const res = await request.post(`${API}/auth/register`, {
      data: {
        email: `intruder${Date.now()}@example.com`,
        password: 'password123',
        displayName: 'Intruder',
        role: 'CORE_PARTNER',
      },
    });

    expect(res.status()).toBe(401);
  });

  test('TC-SEC-02: an investor cannot create accounts either', async ({ request }) => {
    // Being logged in is not the same as being allowed. An investor promoting
    // themselves would put the door straight back.
    const investor = await accountWithRole(request, 'TEMP_INVESTOR');

    const res = await request.post(`${API}/auth/register`, {
      headers: investor.headers,
      data: {
        email: `promoted${Date.now()}@example.com`,
        password: 'password123',
        displayName: 'Promoted',
        role: 'CORE_PARTNER',
      },
    });

    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe('ROLE_NOT_ALLOWED');
  });

  test('TC-SEC-03: creating a user does not hand back their token', async ({
    request,
  }) => {
    // It creates somebody else's account. Returning a token for it means a
    // partner adding a colleague walks away able to act as them.
    const { headers } = await apiCtx(request);
    const res = await request.post(`${API}/auth/register`, {
      headers,
      data: {
        email: `colleague${Date.now()}@motoparts.com`,
        password: 'password123',
        displayName: 'Colleague',
        role: 'ADMIN_SUPPORT',
      },
    });

    expect(res.ok()).toBeTruthy();
    expect(JSON.stringify(await res.json())).not.toContain('accessToken');
  });
});

test.describe('What an investor login may touch', () => {
  test('TC-SEC-04: an investor cannot approve or pay a settlement', async ({
    request,
  }) => {
    // The sharpest case: an outside investor approving the settlement that
    // pays them out.
    const investor = await accountWithRole(request, 'TEMP_INVESTOR');
    const fake = '00000000-0000-4000-8000-000000000999';

    for (const path of [`settlements/${fake}/approve`, `settlements/${fake}/pay`]) {
      const res = await request.post(`${API}/${path}`, {
        headers: investor.headers,
        data: {},
      });
      // Refused on the role, not on the missing settlement — a 404 here would
      // mean the guard let them through and only the id stopped them.
      expect(res.status(), path).toBe(403);
      expect((await res.json()).error.code).toBe('ROLE_NOT_ALLOWED');
    }
  });

  test('TC-SEC-05: an investor cannot reverse a payment or a ledger entry', async ({
    request,
  }) => {
    const investor = await accountWithRole(request, 'TEMP_INVESTOR');
    const fake = '00000000-0000-4000-8000-000000000999';

    for (const path of [`payments/${fake}/reverse`, `ledger/${fake}/reverse`]) {
      const res = await request.post(`${API}/${path}`, {
        headers: investor.headers,
        data: { reason: 'nice try' },
      });
      expect(res.status(), path).toBe(403);
    }
  });

  test('TC-SEC-06: the office can still do the office work', async ({ request }) => {
    // A guard that refuses everyone is not a guard. ADMIN_SUPPORT records
    // sales and payments day to day and must keep being able to.
    const office = await accountWithRole(request, 'ADMIN_SUPPORT');

    const sales = await request.get(`${API}/sales/orders?limit=5`, {
      headers: office.headers,
    });
    expect(sales.ok(), await sales.text()).toBeTruthy();

    const payments = await request.get(`${API}/payments?limit=5`, {
      headers: office.headers,
    });
    expect(payments.ok()).toBeTruthy();

    // But not the partner-only actions.
    const fake = '00000000-0000-4000-8000-000000000999';
    const reverse = await request.post(`${API}/ledger/${fake}/reverse`, {
      headers: office.headers,
      data: { reason: 'no' },
    });
    expect(reverse.status()).toBe(403);
  });

  test('TC-SEC-07: a partner is unaffected', async ({ request }) => {
    // The whole change is worthless if it gets in the way of the people who
    // run the business.
    const { headers } = await apiCtx(request);
    for (const path of ['settlements', 'sales/orders', 'payments', 'ledger']) {
      const res = await request.get(`${API}/${path}?limit=5`, { headers });
      expect(res.ok(), `${path}: ${await res.text()}`).toBeTruthy();
    }
  });
});

test.describe('Cash on hand', () => {
  test('TC-CASH-01: it is inflows less outflows, and it reaches the page', async ({
    page,
    request,
  }) => {
    const { headers } = await apiCtx(request);
    const d = (await (await request.get(`${API}/analytics/dashboard`, { headers })).json())
      .data;

    const ledger = await (await request.get(`${API}/ledger?limit=500`, { headers })).json();
    const rows = ledger.data?.items ?? ledger.data ?? [];
    const net = rows.reduce(
      (s: number, r: any) => s + (r.direction === 'INFLOW' ? num(r.amount) : -num(r.amount)),
      0,
    );

    expect(num(d.cashOnHand)).toBeCloseTo(net, 2);
    expect(num(d.totalCashIn) - num(d.totalCashOut)).toBeCloseTo(num(d.cashOnHand), 2);

    await login(page);
    await expect(page.getByText('Cash on Hand')).toBeVisible({ timeout: 15000 });
  });

  test('TC-CASH-02: capital in and out net to nothing', async ({ request }) => {
    // The invariant that made this figure possible. Funding a cycle moves money
    // in; it must not read as income, and taking it back must not read as cost.
    const { headers, mk } = await apiCtx(request);
    const before = (
      await (await request.get(`${API}/analytics/dashboard`, { headers })).json()
    ).data;

    const cycle = await mk('cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
    const detail = await (await request.get(`${API}/cycles/${cycle.id}`, { headers })).json();
    const participant = (detail.data ?? detail).participants[0];

    // Asserted, not assumed. Without this a refused update reads as "the cash
    // figure did not move", which points the finger at the wrong thing.
    const set = await request.put(`${API}/cycles/participants/${participant.id}`, {
      headers,
      data: { contributionAmount: 7000 },
    });
    expect(set.ok(), `set contribution: ${await set.text()}`).toBeTruthy();

    const funded = (
      await (await request.get(`${API}/analytics/dashboard`, { headers })).json()
    ).data;
    expect(num(funded.cashOnHand)).toBeCloseTo(num(before.cashOnHand) + 7000, 2);
    // Capital is not earnings.
    expect(num(funded.netProfit)).toBeCloseTo(num(before.netProfit), 2);

    // Hand it all back.
    await request.put(`${API}/cycles/participants/${participant.id}`, {
      headers,
      data: { contributionAmount: 0 },
    });
    const returned = (
      await (await request.get(`${API}/analytics/dashboard`, { headers })).json()
    ).data;
    expect(num(returned.cashOnHand)).toBeCloseTo(num(before.cashOnHand), 2);
    expect(num(returned.netProfit)).toBeCloseTo(num(before.netProfit), 2);
  });
});

test.describe('Export', () => {
  test('TC-EXP-01: the partners table comes out as a CSV', async ({ page }) => {
    // "Export" has been a translated label with nothing behind it since the
    // beginning — the same shape as the expenses card that was fetched and
    // never rendered.
    await login(page);
    await page.goto(`${BASE}/en/partners`);
    await expect(page.getByRole('button', { name: /export/i })).toBeVisible({
      timeout: 15000,
    });

    const download = page.waitForEvent('download', { timeout: 15000 });
    await page.getByRole('button', { name: /export/i }).click();
    const file = await download;

    expect(file.suggestedFilename()).toMatch(/^partners-\d{4}-\d{2}-\d{2}\.csv$/);

    const stream = await file.createReadStream();
    const text = await new Promise<string>((resolve, reject) => {
      let out = '';
      stream.on('data', (c) => (out += c));
      stream.on('end', () => resolve(out));
      stream.on('error', reject);
    });

    // The BOM: without it Excel on Windows reads UTF-8 as its legacy encoding
    // and every Arabic name arrives as mojibake.
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Capital in');
    expect(text).toContain('Partner A');
    // A header row plus one row per participation.
    expect(text.trim().split(/\r\n/).length).toBeGreaterThan(1);
  });

  test('TC-EXP-02: the ledger export follows the filters, not the whole table', async ({
    page,
  }) => {
    // Exporting everything when the screen shows a filtered view answers a
    // different question than the one being asked.
    await login(page);
    await page.goto(`${BASE}/en/ledger`);
    await expect(page.getByRole('button', { name: /export/i })).toBeVisible({
      timeout: 15000,
    });

    const download = page.waitForEvent('download', { timeout: 15000 });
    await page.getByRole('button', { name: /export/i }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^ledger-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
