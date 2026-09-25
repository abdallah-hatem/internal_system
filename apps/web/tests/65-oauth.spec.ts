/**
 * ═══════════════════════════════════════════════════════════════════════
 *  TEST SUITE: Signing Claude in — the OAuth door
 * ═══════════════════════════════════════════════════════════════════════
 *  BUSINESS_LOGIC §16: core partners only; each Claude app signs in once and
 *  is remembered; access is revocable, lapses after 30 days without use, and
 *  ends at once for a partner who stops being one.
 *
 *  Driven the way Claude drives it, over HTTP against the running API:
 *  register a client, open the sign-in page, post the login, follow the
 *  redirect, redeem the code with its PKCE verifier, refresh. Assertions are on
 *  what Claude's client receives — the status, the Location header, and the
 *  RFC 6749 `error` field it parses.
 *
 *  Two cases need time to have passed. A code six minutes old is signed by
 *  hand with the API's secret, next to a control signed the same way but
 *  fresh — so the refusal is proven to be the age and not the signature. A
 *  refresh token 31 days old is aged in the database.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash, randomUUID } from 'crypto';

import { API, EMAIL, PASSWORD, apiCtx } from './support/fixtures';
import { sign } from './support/api-jwt';
import { psqlStdin } from './support/database';
import {
  CLAUDE_CB,
  ROOT,
  authorizeFields,
  claimsOf,
  codeFor,
  defined,
  newClient,
  pkce,
  redeem,
  register,
  signIn,
  tokenCall,
  tokensFor,
  type Fields,
} from './support/oauth-flow';

const DESKTOP_CB = 'http://localhost:6274/callback';
const SHOP_EMAIL = 'shop.owner@example.com';
const SHOP_PASSWORD = 'password123';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

// ─────────────────────────────────────────────────────────────── accounts

/** A fresh account, made by a partner the way the office makes one. */
async function newAccount(request: APIRequestContext, role: 'CORE_PARTNER' | 'TEMP_INVESTOR') {
  const { headers } = await apiCtx(request);
  const email = `oauth-${role.toLowerCase()}-${stamp()}@motoparts.com`;
  const res = await request.post(`${API}/auth/register`, {
    headers,
    data: { email, password: 'password123', displayName: `OAuth ${stamp()}`, role },
  });
  expect(res.ok(), `create ${role}: ${await res.text()}`).toBeTruthy();
  return { id: (await res.json()).data.id as string, email, password: 'password123' };
}

async function updateUser(request: APIRequestContext, id: string, data: object) {
  const { headers } = await apiCtx(request);
  const res = await request.put(`${API}/users/${id}`, { headers, data });
  expect(res.ok(), await res.text()).toBeTruthy();
}

// ──────────────────────────────────────────────────────────────── client

async function openPage(request: APIRequestContext, fields: Fields) {
  const res = await request.get(
    `${ROOT}/oauth/authorize?${new URLSearchParams(defined(fields)).toString()}`,
    { maxRedirects: 0 },
  );
  return { status: res.status(), location: res.headers()['location'], html: await res.text() };
}

const refreshCall = (request: APIRequestContext, client: string, refresh_token: string) =>
  tokenCall(request, { grant_type: 'refresh_token', client_id: client, refresh_token });

const revokeCall = (request: APIRequestContext, fields: Fields) =>
  request.post(`${ROOT}/oauth/revoke`, { form: defined(fields) });

// ═══════════════════════════════════════════════════════════ registration

test.describe('Registering a client', () => {
  test('Register with https://evil.example/cb → 400 invalid_redirect_uri', async ({ request }) => {
    const res = await register(request, ['https://evil.example/cb']);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  test('Register with https://claude.ai/api/mcp/auth_callback → 201 with a client_id', async ({ request }) => {
    const res = await register(request, [CLAUDE_CB]);
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.token_endpoint_auth_method).toBe('none');
  });

  test('Register with http://localhost:6274/callback → accepted', async ({ request }) => {
    const res = await register(request, [DESKTOP_CB]);
    expect(res.status).toBe(201);
  });

  test('a lookalike of Claude, an empty list, or a huge list → invalid_redirect_uri', async ({ request }) => {
    for (const uris of [
      ['https://claude.ai.evil.example/cb'],
      [CLAUDE_CB, 'https://evil.example/cb'],
      [],
      Array.from({ length: 11 }, (_, i) => `http://localhost:${7000 + i}/cb`),
    ]) {
      const res = await register(request, uris);
      expect(res.status, JSON.stringify(uris).slice(0, 80)).toBe(400);
      expect(res.body.error).toBe('invalid_redirect_uri');
    }
  });
});

// ════════════════════════════════════════════════════════════ authorize

test.describe('The sign-in page', () => {
  test('Authorize with an unknown client_id → error page, no redirect', async ({ request }) => {
    const { challenge } = pkce();
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await openPage(request, authorizeFields(id, challenge));
      expect(res.status).toBe(400);
      expect(res.location).toBeUndefined();
      expect(res.html).toContain('data-error="unknown_client"');
    }
  });

  test('Authorize with a redirect_uri not registered to that client → error page, no redirect', async ({ request }) => {
    const client = await newClient(request);
    const { challenge } = pkce();
    const res = await openPage(
      request,
      authorizeFields(client, challenge, { redirect_uri: 'https://evil.example/cb' }),
    );
    expect(res.status).toBe(400);
    expect(res.location).toBeUndefined();
    expect(res.html).toContain('data-error="unregistered_redirect"');
  });

  test('Authorize without code_challenge, or with method plain → error (PKCE S256)', async ({ request }) => {
    const client = await newClient(request);
    const { challenge } = pkce();
    for (const overrides of [{ code_challenge: undefined }, { code_challenge_method: 'plain' }]) {
      const res = await openPage(request, authorizeFields(client, challenge, overrides));
      expect(res.status).toBe(302);
      const back = new URL(res.location!);
      expect(back.searchParams.get('error')).toBe('invalid_request');
      expect(back.searchParams.get('code')).toBeNull();
    }
  });

  test('the page says what Claude may do, in English and in Arabic', async ({ request }) => {
    const client = await newClient(request);
    const { challenge } = pkce();
    const en = await openPage(request, authorizeFields(client, challenge));
    expect(en.status).toBe(200);
    expect(en.html).toContain('Record or change sales, payments');
    const ar = await openPage(request, authorizeFields(client, challenge, { lang: 'ar' }));
    expect(ar.html).toContain('dir="rtl"');
  });

  test('Wrong password → page shown again with an error, no code', async ({ request }) => {
    const client = await newClient(request);
    const { challenge } = pkce();
    const res = await signIn(request, authorizeFields(client, challenge), EMAIL, 'wrong-password');
    expect(res.status).toBe(401);
    expect(res.location).toBeUndefined();
    expect(res.html).toContain('data-error="wrong_credentials"');
  });

  test('Investor signs in → refused on the page', async ({ request }) => {
    const investor = await newAccount(request, 'TEMP_INVESTOR');
    const client = await newClient(request);
    const { challenge } = pkce();
    const res = await signIn(request, authorizeFields(client, challenge), investor.email, investor.password);
    expect(res.status).toBe(403);
    expect(res.location).toBeUndefined();
    expect(res.html).toContain('data-error="partners_only"');
  });

  test('Shop owner signs in → refused on the page', async ({ request }) => {
    const client = await newClient(request);
    const { challenge } = pkce();
    const res = await signIn(request, authorizeFields(client, challenge), SHOP_EMAIL, SHOP_PASSWORD);
    expect(res.status).toBe(403);
    expect(res.location).toBeUndefined();
    expect(res.html).toContain('data-error="partners_only"');
  });

  test('an inactive core partner → refused on the page', async ({ request }) => {
    const partner = await newAccount(request, 'CORE_PARTNER');
    await updateUser(request, partner.id, { status: 'INACTIVE' });
    const client = await newClient(request);
    const { challenge } = pkce();
    const res = await signIn(request, authorizeFields(client, challenge), partner.email, partner.password);
    expect(res.status).toBe(403);
    expect(res.html).toContain('data-error="inactive"');
  });

  test('Core partner signs in → 302 to the redirect URI with a code and the exact state', async ({ request }) => {
    const client = await newClient(request);
    const { challenge } = pkce();
    const fields = authorizeFields(client, challenge);
    const res = await signIn(request, fields, EMAIL, PASSWORD);
    expect(res.status).toBe(302);
    const back = new URL(res.location!);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CB);
    expect(back.searchParams.get('state')).toBe(fields.state);
    expect(back.searchParams.get('code')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════ token

test.describe('Redeeming a code', () => {
  test('a good code → an mcp access token that the office API refuses', async ({ request }) => {
    const t = await tokensFor(request, EMAIL, PASSWORD);
    expect(claimsOf(t.access).aud).toBe('mcp');
    const office = await request.get(`${API}/payments`, {
      headers: { Authorization: `Bearer ${t.access}` },
    });
    expect(office.status()).toBe(403);
    expect((await office.json()).error.code).toBe('WRONG_SURFACE');
  });

  test('Token with the wrong code_verifier → invalid_grant', async ({ request }) => {
    const c = await codeFor(request, EMAIL, PASSWORD);
    const res = await redeem(request, c, { code_verifier: pkce().verifier });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('Code used twice → second invalid_grant', async ({ request }) => {
    const c = await codeFor(request, EMAIL, PASSWORD);
    expect((await redeem(request, c)).status).toBe(200);
    const second = await redeem(request, c);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_grant');
  });

  test('a code replayed concurrently is redeemed exactly once', async ({ request }) => {
    const c = await codeFor(request, EMAIL, PASSWORD);
    const results = await Promise.all([redeem(request, c), redeem(request, c), redeem(request, c)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  test('Code older than 5 minutes → invalid_grant', async ({ request }) => {
    // A real code's claims, re-signed with the API's secret at two ages.
    const c = await codeFor(request, EMAIL, PASSWORD);
    const claims = claimsOf(c.code);
    const at = (secondsAgo: number) => {
      const iat = Math.floor(Date.now() / 1000) - secondsAgo;
      return sign({ ...claims, jti: randomUUID(), iat, exp: iat + 300 });
    };
    const stale = await redeem(request, c, { code: at(6 * 60) });
    expect(stale.body.error).toBe('invalid_grant');
    // The control: signed identically but fresh, it is accepted — so what was
    // refused above was the age, not the hand-made signature.
    const fresh = await redeem(request, c, { code: at(0) });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
  });

  test('redirect_uri at the token step differs from authorize → invalid_grant', async ({ request }) => {
    const c = await codeFor(request, EMAIL, PASSWORD);
    const res = await redeem(request, c, { redirect_uri: DESKTOP_CB });
    expect(res.body.error).toBe('invalid_grant');
  });

  test('Code issued to client A, redeemed by client B → invalid_grant', async ({ request }) => {
    const c = await codeFor(request, EMAIL, PASSWORD);
    const other = await newClient(request);
    const res = await redeem(request, c, { client_id: other });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });
});

test.describe('Refreshing', () => {
  test('Refresh → new access and refresh tokens; the old refresh token then fails', async ({ request }) => {
    const t = await tokensFor(request, EMAIL, PASSWORD);
    const next = await refreshCall(request, t.client, t.refresh);
    expect(next.status).toBe(200);
    expect(next.body.refresh_token).not.toBe(t.refresh);
    expect(claimsOf(next.body.access_token).aud).toBe('mcp');
    const old = await refreshCall(request, t.client, t.refresh);
    expect(old.status).toBe(400);
    expect(old.body.error).toBe('invalid_grant');
  });

  test('Refresh a revoked token → invalid_grant', async ({ request }) => {
    const t = await tokensFor(request, EMAIL, PASSWORD);
    expect((await revokeCall(request, { token: t.refresh, client_id: t.client })).status()).toBe(200);
    const res = await refreshCall(request, t.client, t.refresh);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('Refresh after the partner was demoted → invalid_grant', async ({ request }) => {
    const partner = await newAccount(request, 'CORE_PARTNER');
    const t = await tokensFor(request, partner.email, partner.password);
    await updateUser(request, partner.id, { role: 'TEMP_INVESTOR' });
    const res = await refreshCall(request, t.client, t.refresh);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('refresh after the partner was switched off → invalid_grant', async ({ request }) => {
    const partner = await newAccount(request, 'CORE_PARTNER');
    const t = await tokensFor(request, partner.email, partner.password);
    await updateUser(request, partner.id, { status: 'INACTIVE' });
    const res = await refreshCall(request, t.client, t.refresh);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('Refresh older than 30 days → invalid_grant', async ({ request }) => {
    const t = await tokensFor(request, EMAIL, PASSWORD);
    const hash = createHash('sha256').update(t.refresh).digest('hex');
    psqlStdin(
      `UPDATE oauth_refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = '${hash}';`,
    );
    const res = await refreshCall(request, t.client, t.refresh);
    expect(res.body.error).toBe('invalid_grant');
  });
});

test.describe('Revoking', () => {
  test('/oauth/revoke → that refresh token no longer works', async ({ request }) => {
    const t = await tokensFor(request, EMAIL, PASSWORD);
    const revoked = await revokeCall(request, { token: t.refresh });
    expect(revoked.status()).toBe(200);
    const res = await refreshCall(request, t.client, t.refresh);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  test('an unknown token is answered 200, telling the caller nothing', async ({ request }) => {
    expect((await revokeCall(request, { token: 'never-issued' })).status()).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════ metadata

test.describe('Metadata', () => {
  test('Metadata carries absolute URLs on the public host', async ({ request }) => {
    const as = await (await request.get(`${ROOT}/.well-known/oauth-authorization-server`)).json();
    for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint']) {
      expect(as[key], key).toMatch(/^https?:\/\/[^/]+\/oauth\//);
      expect(new URL(as[key]).origin).toBe(as.issuer);
    }
    expect(as.code_challenge_methods_supported).toEqual(['S256']);

    const pr = await (await request.get(`${ROOT}/.well-known/oauth-protected-resource`)).json();
    expect(pr.resource).toBe(`${as.issuer}/mcp`);
    expect(pr.authorization_servers).toEqual([as.issuer]);
  });

  test('the OAuth routes are not under api/v1', async ({ request }) => {
    expect((await request.get(`${API}/.well-known/oauth-authorization-server`)).status()).toBe(404);
  });
});
