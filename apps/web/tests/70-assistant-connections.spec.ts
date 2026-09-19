/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Settings → Claude connections
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §16: each Claude app a partner connects — the phone, a
 *  laptop — is its own connection in Settings. Access is revocable, one
 *  device or all, without changing the password. Core partners only.
 *
 *  Connections are made the way Claude makes them — register a client, sign
 *  in on the OAuth page, redeem the code with its PKCE verifier — so what the
 *  screen lists and ends is exactly what Claude holds.
 *
 *  Every test uses a partner of its own, created for it. The seeded partner
 *  may carry connections from other suites, and a list shared between tests
 *  is how an empty-state test passes alone and fails in a full run.
 *
 *  The screen tests reach Settings by clicking the sidebar, as a person does,
 *  and assert on what the page shows — not on the API underneath.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'crypto';

import { API, apiCtx } from './support/fixtures';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
/** OAuth lives at the host's root, outside `api/v1`, where clients look. */
const ROOT = API.replace(/\/api\/v1\/?$/, '');
const CONNECTIONS = `${API}/auth/assistant-connections`;
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const SHOP_EMAIL = 'shop.owner@example.com';
const SHOP_PASSWORD = 'password123';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

interface Account {
  id: string;
  email: string;
  password: string;
}

// ─────────────────────────────────────────────────────────────── accounts

/** A fresh account, made by a partner the way the office makes one. */
async function newAccount(
  request: APIRequestContext,
  role: 'CORE_PARTNER' | 'TEMP_INVESTOR' = 'CORE_PARTNER',
): Promise<Account> {
  const { headers } = await apiCtx(request);
  const email = `claude-conn-${role.toLowerCase()}-${stamp()}@motoparts.com`;
  const res = await request.post(`${API}/auth/register`, {
    headers,
    data: { email, password: 'password123', displayName: `Conn ${stamp()}`, role },
  });
  expect(res.ok(), `create ${role}: ${await res.text()}`).toBeTruthy();
  return { id: (await res.json()).data.id as string, email, password: 'password123' };
}

/** The office's own login for an account. */
async function officeHeaders(request: APIRequestContext, who: Account) {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: who.email, password: who.password },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return { Authorization: `Bearer ${(await res.json()).data.accessToken}` };
}

// ─────────────────────────────────────────────────────────────── claude

async function newClient(request: APIRequestContext, name = 'Claude'): Promise<string> {
  const res = await request.post(`${ROOT}/oauth/register`, {
    data: { client_name: name, redirect_uris: [CLAUDE_CB] },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).client_id;
}

/**
 * One Claude app signed in by `who`: register (unless a client is given),
 * sign in on the page, redeem the code. Returns what Claude would keep.
 */
async function connect(
  request: APIRequestContext,
  who: Account,
  opts: { name?: string; client?: string } = {},
) {
  const client = opts.client ?? (await newClient(request, opts.name));
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const signIn = await request.post(`${ROOT}/oauth/authorize`, {
    form: {
      response_type: 'code',
      client_id: client,
      redirect_uri: CLAUDE_CB,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: `st-${stamp()}`,
      email: who.email,
      password: who.password,
    },
    maxRedirects: 0,
  });
  expect(signIn.status(), await signIn.text()).toBe(302);
  const code = new URL(signIn.headers()['location']).searchParams.get('code')!;

  const token = await request.post(`${ROOT}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client,
      redirect_uri: CLAUDE_CB,
    },
  });
  expect(token.status(), await token.text()).toBe(200);
  const body = await token.json();
  return { client, access: body.access_token as string, refresh: body.refresh_token as string };
}

const refresh = (request: APIRequestContext, client: string, refresh_token: string) =>
  request.post(`${ROOT}/oauth/token`, {
    form: { grant_type: 'refresh_token', client_id: client, refresh_token },
  });

async function listFor(request: APIRequestContext, who: Account) {
  const res = await request.get(CONNECTIONS, { headers: await officeHeaders(request, who) });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data as { id: string; clientName: string | null }[];
}

// ─────────────────────────────────────────────────────────────── screen

async function login(page: Page, who: Account, locale: 'en' | 'ar' = 'en') {
  await page.goto(`${BASE}/${locale}/login`);
  await page.getByPlaceholder('partner.a@motoparts.com').fill(who.email);
  await page.getByPlaceholder('••••••••').fill(who.password);
  await page.getByRole('button').filter({ hasText: /.+/ }).last().click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10000 });
}

/** Settings, reached from the sidebar — not typed into the address bar. */
async function openSettings(page: Page, label: string) {
  await page.getByRole('link', { name: label, exact: true }).first().click();
  await expect(page).toHaveURL(/\/settings/, { timeout: 10000 });
  const section = page.getByTestId('claude-connections');
  await expect(section).toBeVisible();
  return section;
}

// ═══════════════════════════════════════════════════════════════ the API

test.describe('Claude connections — the API', () => {
  test('A partner sees only their own connections', async ({ request }) => {
    const a = await newAccount(request);
    const b = await newAccount(request);
    const mine = await connect(request, a);
    const theirs = await connect(request, b);
    // One Claude app signed in by both: each sees only their own grant on it.
    const shared = await newClient(request);
    await connect(request, a, { client: shared });
    await connect(request, b, { client: shared });

    const seen = (await listFor(request, a)).map((c) => c.id).sort();
    expect(seen).toEqual([mine.client, shared].sort());
    expect(seen).not.toContain(theirs.client);
  });

  test("Disconnecting another partner's connection id → 404", async ({ request }) => {
    const a = await newAccount(request);
    const b = await newAccount(request);
    const theirs = await connect(request, b);

    const res = await request.delete(`${CONNECTIONS}/${theirs.client}`, {
      headers: await officeHeaders(request, a),
    });
    expect(res.status()).toBe(404);
    const error = (await res.json()).error;
    expect(error.code).toBe('NOT_FOUND');
    expect(error.params).toEqual({ entity: 'assistantConnection' });

    // Nothing of B's was touched.
    expect((await refresh(request, theirs.client, theirs.refresh)).status()).toBe(200);
  });

  test("Disconnect all → only this partner's tokens revoked", async ({ request }) => {
    const a = await newAccount(request);
    const b = await newAccount(request);
    const phone = await connect(request, a);
    const laptop = await connect(request, a);
    const theirs = await connect(request, b);

    const res = await request.delete(CONNECTIONS, { headers: await officeHeaders(request, a) });
    expect(res.status()).toBe(200);
    expect((await res.json()).data).toEqual({ disconnected: 2 });

    expect(await listFor(request, a)).toEqual([]);
    for (const grant of [phone, laptop]) {
      const again = await refresh(request, grant.client, grant.refresh);
      expect((await again.json()).error).toBe('invalid_grant');
    }
    expect((await listFor(request, b)).map((c) => c.id)).toEqual([theirs.client]);
    expect((await refresh(request, theirs.client, theirs.refresh)).status()).toBe(200);
  });

  test('Two Claude apps signed in by one partner → two separate connections, each disconnectable alone', async ({ request }) => {
    const partner = await newAccount(request);
    const phone = await connect(request, partner, { name: 'Claude phone' });
    const laptop = await connect(request, partner, { name: 'Claude laptop' });

    const both = await listFor(request, partner);
    expect(both.map((c) => c.clientName).sort()).toEqual(['Claude laptop', 'Claude phone']);

    const res = await request.delete(`${CONNECTIONS}/${phone.client}`, {
      headers: await officeHeaders(request, partner),
    });
    expect(res.status()).toBe(200);
    expect((await listFor(request, partner)).map((c) => c.id)).toEqual([laptop.client]);
    expect((await refresh(request, laptop.client, laptop.refresh)).status()).toBe(200);
  });

  test('After disconnecting, refresh fails', async ({ request }) => {
    const partner = await newAccount(request);
    const grant = await connect(request, partner);
    // Refreshed once, so the live token is a successor: the disconnect has to
    // reach it, not only the token first issued.
    const next = (await (await refresh(request, grant.client, grant.refresh)).json()).refresh_token;

    const res = await request.delete(`${CONNECTIONS}/${grant.client}`, {
      headers: await officeHeaders(request, partner),
    });
    expect(res.status()).toBe(200);

    const after = await refresh(request, grant.client, next);
    expect(after.status()).toBe(400);
    expect((await after.json()).error).toBe('invalid_grant');
  });

  test('disconnecting twice → the second is 404, not 500', async ({ request }) => {
    const partner = await newAccount(request);
    const grant = await connect(request, partner);
    const headers = await officeHeaders(request, partner);

    expect((await request.delete(`${CONNECTIONS}/${grant.client}`, { headers })).status()).toBe(200);
    const again = await request.delete(`${CONNECTIONS}/${grant.client}`, { headers });
    expect(again.status()).toBe(404);
    expect((await again.json()).error.code).toBe('NOT_FOUND');
  });

  test('a non-uuid id, or one that is nobody\'s → a coded 404', async ({ request }) => {
    const partner = await newAccount(request);
    await connect(request, partner);
    const headers = await officeHeaders(request, partner);

    for (const id of ['not-a-uuid', randomUUID()]) {
      const res = await request.delete(`${CONNECTIONS}/${id}`, { headers });
      expect(res.status(), id).toBe(404);
      expect((await res.json()).error.code).toBe('NOT_FOUND');
    }
    expect(await listFor(request, partner)).toHaveLength(1);
  });

  test('an investor is refused with ROLE_NOT_ALLOWED, on every route', async ({ request }) => {
    const investor = await newAccount(request, 'TEMP_INVESTOR');
    const headers = await officeHeaders(request, investor);
    for (const res of [
      await request.get(CONNECTIONS, { headers }),
      await request.delete(CONNECTIONS, { headers }),
      await request.delete(`${CONNECTIONS}/${randomUUID()}`, { headers }),
    ]) {
      expect(res.status()).toBe(403);
      expect((await res.json()).error.code).toBe('ROLE_NOT_ALLOWED');
    }
  });

  test('a shop owner is refused with WRONG_SURFACE', async ({ request }) => {
    const login = await request.post(`${API}/auth/portal/login`, {
      data: { email: SHOP_EMAIL, password: SHOP_PASSWORD },
    });
    expect(login.ok(), await login.text()).toBeTruthy();
    const headers = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };

    const res = await request.get(CONNECTIONS, { headers });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe('WRONG_SURFACE');
  });

  test("Claude's own mcp token → WRONG_SURFACE: the assistant cannot see or end its grants", async ({ request }) => {
    const partner = await newAccount(request);
    const grant = await connect(request, partner);
    const headers = { Authorization: `Bearer ${grant.access}` };

    for (const res of [
      await request.get(CONNECTIONS, { headers }),
      await request.delete(CONNECTIONS, { headers }),
      await request.delete(`${CONNECTIONS}/${grant.client}`, { headers }),
    ]) {
      expect(res.status()).toBe(403);
      expect((await res.json()).error.code).toBe('WRONG_SURFACE');
    }
    expect((await listFor(request, partner)).map((c) => c.id)).toEqual([grant.client]);
  });
});

// ═══════════════════════════════════════════════════════════ the screen

test.describe('Claude connections — the Settings screen', () => {
  test('(ui) No connections → an empty state that says how to connect', async ({ page, request }) => {
    const partner = await newAccount(request);
    await login(page, partner);
    const section = await openSettings(page, 'Settings');

    await expect(section.getByText('Claude is not connected to your account.')).toBeVisible();
    await expect(section.getByText(/Settings → Connectors/)).toBeVisible();
    // The URL to paste, ending where Claude looks for the server.
    await expect(section.locator('code')).toHaveText(/^https?:\/\/.+\/mcp$/);
    // Nothing to disconnect, so no button offering to.
    await expect(section.getByRole('button', { name: 'Disconnect all' })).toHaveCount(0);
  });

  test('(ui) The list updates after a disconnect without a reload', async ({ page, request }) => {
    const partner = await newAccount(request);
    const phone = `Claude phone ${stamp()}`;
    const laptop = `Claude laptop ${stamp()}`;
    await connect(request, partner, { name: phone });
    await connect(request, partner, { name: laptop });

    await login(page, partner);
    const section = await openSettings(page, 'Settings');
    await expect(section.getByText(phone)).toBeVisible();
    await expect(section.getByText(laptop)).toBeVisible();

    // A value on `window` survives anything but a document load.
    await page.evaluate(() => {
      (window as unknown as { __noReload: string }).__noReload = 'alive';
    });
    let documentLoads = 0;
    page.on('load', () => documentLoads++);

    // One device alone: the phone goes, the laptop stays.
    await section.getByRole('button', { name: `Disconnect ${phone}` }).click();
    await expect(section.getByText(phone)).toHaveCount(0);
    await expect(section.getByText(laptop)).toBeVisible();

    // All of them — asked first, and cancelling changes nothing.
    await section.getByRole('button', { name: 'Disconnect all' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Disconnect every Claude app?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(section.getByText(laptop)).toBeVisible();

    await section.getByRole('button', { name: 'Disconnect all' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect all' }).click();
    await expect(section.getByText(laptop)).toHaveCount(0);
    await expect(section.getByText('Claude is not connected to your account.')).toBeVisible();

    expect(documentLoads).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: string }).__noReload),
    ).toBe('alive');
    // And the server agrees with the screen.
    expect(await listFor(request, partner)).toEqual([]);
  });

  test('(ui) Arabic, right to left', async ({ page, request }) => {
    const partner = await newAccount(request);
    const app = `Claude ${stamp()}`;
    await connect(request, partner, { name: app });

    await login(page, partner, 'ar');
    const section = await openSettings(page, 'الإعدادات');

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(section.getByRole('heading', { name: 'اتصالات Claude' })).toBeVisible();
    await expect(section.getByText(app)).toBeVisible();
    await expect(section.getByText(/^متصل منذ/)).toBeVisible();

    // The Arabic button ends the connection, and the Arabic empty state follows.
    await section.getByRole('button', { name: `قطع اتصال ${app}` }).click();
    await expect(section.getByText('Claude غير متصل بحسابك.')).toBeVisible();
    // The server URL stays left to right inside the right-to-left page.
    await expect(section.locator('code')).toHaveAttribute('dir', 'ltr');
    // No English left behind on the section.
    await expect(section.getByText(/Disconnect|not connected/)).toHaveCount(0);
  });

  test('(ui) an investor sees no Claude connections section', async ({ page, request }) => {
    const investor = await newAccount(request, 'TEMP_INVESTOR');
    await login(page, investor);
    await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
    await expect(page.getByTestId('claude-connections')).toHaveCount(0);
  });
});
